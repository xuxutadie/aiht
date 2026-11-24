"""把官方 D1 业务 SQL 快照转换为新的私有数据目录，仅使用标准库。"""

import argparse
import base64
import binascii
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile

# 直接运行脚本时仍从本发布包加载存储契约，不依赖当前工作目录。
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from studio._store_database import _SCHEMA, json_object
from studio.contracts import ADMIN_UNLIMITED_RESERVE_NOTE
from studio.provider import inspect_image, MAX_IMAGE_BYTES


TABLES = ("users", "plans", "jobs", "artworks", "ledger", "audit")
OPTIONAL_TABLES = ("authorization_codes",)
SOURCE_TABLES = {*TABLES, *OPTIONAL_TABLES, "image_objects", "image_chunks", "sessions", "settings", "rate_limits", "_cf_METADATA"}
IMAGE_CHUNK_BYTES = 768 * 1024
EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
PASSWORD_HASH = re.compile(r"scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}\Z")


class MigrationError(Exception):
    """只输出安全的分类说明，不把数据库内容或 SQL 原文带入错误。"""


def _require(condition, message):
    if not condition:
        raise MigrationError(message)


def _file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for part in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def _authorize_sql(action, first, second, database, origin):
    """导入仅允许普通表/索引和数据写入，禁止附加外部库、触发器及扩展。"""
    tables = SOURCE_TABLES | {"sqlite_master", "sqlite_schema", "sqlite_sequence"}
    if action == sqlite3.SQLITE_PRAGMA:
        return sqlite3.SQLITE_OK if first.lower() in ("foreign_keys", "defer_foreign_keys") else sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_READ):
        return sqlite3.SQLITE_OK if first in tables else sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_UPDATE:
        return sqlite3.SQLITE_OK if first in ("sqlite_master", "sqlite_schema", "sqlite_sequence") else sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_DELETE:
        # AUTOINCREMENT表的官方/SQLite导出会重置序号，只允许内部序号表。
        return sqlite3.SQLITE_OK if first == "sqlite_sequence" else sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_CREATE_INDEX:
        return sqlite3.SQLITE_OK if second in SOURCE_TABLES else sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION:
        # Wrangler 会用 replace/char 还原导出文本中的换行，不开放扩展或任意函数。
        return sqlite3.SQLITE_OK if (second or "").lower() in ("replace", "char") else sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_TRANSACTION, sqlite3.SQLITE_REINDEX):
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


@contextmanager
def _source_database(sql_path):
    sql_path = Path(sql_path).resolve(strict=True)
    _require(sql_path.is_file() and sql_path.stat().st_size <= 512 * 1024 * 1024, "SQL 快照不存在或超过512MiB。")
    source_hash = _file_hash(sql_path)
    # 临时数据库不在网站目录中；退出时只清理本工具创建的临时文件。
    with tempfile.TemporaryDirectory(prefix=".aiht-d1-source-", dir=sql_path.parent) as temporary:
        database_path = Path(temporary) / "source.sqlite3"
        db = sqlite3.connect(database_path)
        database_path.chmod(0o600)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA trusted_schema=OFF")
            # 删除过自增表的旧SQLite快照仍可能导出序号清空语句。
            # 在本次临时库中准备内部序号表，不向业务库增加额外表。
            db.execute("CREATE TABLE migration_sequence_seed (id INTEGER PRIMARY KEY AUTOINCREMENT)")
            db.execute("DROP TABLE migration_sequence_seed")
            db.set_authorizer(_authorize_sql)
            buffer = ""
            with sql_path.open("r", encoding="utf-8-sig") as handle:
                for line in handle:
                    buffer += line
                    _require(len(buffer.encode("utf-8")) <= 64 * 1024 * 1024, "单条 SQL 超过安全导入限制。")
                    # execute 不会像 executescript 那样隐式提交，保留官方导出的 BEGIN/COMMIT。
                    while sqlite3.complete_statement(buffer):
                        for mark in re.finditer(";", buffer):
                            statement = buffer[:mark.end()]
                            if sqlite3.complete_statement(statement):
                                db.execute(statement)
                                buffer = buffer[mark.end():]
                                break
                        else:
                            break
            if buffer.strip():
                db.execute(buffer)
            db.set_authorizer(None)
            _require(_file_hash(sql_path) == source_hash, "SQL 快照在读取期间发生变化，请重新导出。")
            _require(db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "SQL 快照数据库完整性检查失败。")
            _require(not list(db.execute("PRAGMA foreign_key_check")), "SQL 快照存在断开的数据引用。")
            yield db, source_hash
        except (sqlite3.Error, UnicodeError, ValueError, KeyError, TypeError, binascii.Error):
            raise MigrationError("SQL 快照、字段或图片格式不符合迁移契约，未发布数据目录。") from None
        finally:
            db.close()


def _json(value):
    result = json.loads(value)
    _require(isinstance(result, dict), "JSON 快照必须为对象。")
    return result


def _validate_source(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    _require(set(TABLES) | {"image_objects", "image_chunks"} <= tables, "缺少必须的业务表，请使用完整业务快照。")
    _require(not db.execute("SELECT 1 FROM jobs WHERE status IN ('queued','running','uncertain') OR reservation_active<>0 OR storage_reservation_bytes<>0 LIMIT 1").fetchone(),
             "存在在途、待核对任务或图片预留，须在原站核对结算后重新导出。")
    _require(not db.execute("SELECT 1 FROM users WHERE reserved_credits<>0 LIMIT 1").fetchone(), "账号仍有预留算力，拒绝迁移。")
    _require(not db.execute("SELECT 1 FROM image_objects WHERE completed<>1 LIMIT 1").fetchone(), "存在未完成图片，须先在原站核对。")
    _require(not db.execute("""SELECT 1 FROM users u WHERE credits <> COALESCE(
        (SELECT SUM(delta) FROM ledger l WHERE l.user_id=u.id),0) LIMIT 1""").fetchone(), "账号余额与完整账本不一致，拒绝迁移。")
    _require(not db.execute("""SELECT 1 FROM jobs j JOIN plans p ON p.id=j.plan_id
        WHERE p.user_id<>j.user_id LIMIT 1""").fetchone(), "任务与方案归属不一致。")
    _require(not db.execute("""SELECT 1 FROM ledger l JOIN jobs j ON j.id=l.job_id
        WHERE l.user_id<>j.user_id LIMIT 1""").fetchone(), "任务账本归属不一致。")
    # 免扣标记仅用于管理员新任务；无标记的历史任务继续按原来的1点校验。
    _require(not db.execute("""WITH job_charges AS (
        SELECT j.*, u.role, CASE WHEN EXISTS (SELECT 1 FROM ledger l
            WHERE l.job_id=j.id AND l.kind='reserve' AND l.note=?) THEN 0 ELSE 1 END AS charge_points
        FROM jobs j JOIN users u ON u.id=j.user_id
        ) SELECT 1 FROM job_charges j WHERE
        (j.charge_points=0 AND j.role<>'admin') OR
        (SELECT COUNT(*) FROM ledger l WHERE l.job_id=j.id AND l.kind='reserve' AND l.delta=0)<>1
        OR (j.status='succeeded' AND (SELECT COUNT(*) FROM ledger l WHERE l.job_id=j.id AND l.kind='consume' AND l.delta=-j.charge_points)<>1)
        OR (j.status='failed' AND (SELECT COUNT(*) FROM ledger l WHERE l.job_id=j.id AND l.kind='release' AND l.delta=0)<>1)
        OR (j.status='settled' AND NOT EXISTS (SELECT 1 FROM audit a JOIN ledger l ON l.job_id=a.job_id
            WHERE a.job_id=j.id AND l.delta=-a.consume*j.charge_points AND l.kind=CASE WHEN a.consume=1 THEN 'manual_consume' ELSE 'manual_release' END))
        LIMIT 1""", (ADMIN_UNLIMITED_RESERVE_NOTE,)).fetchone(), "任务终态与预留、扣点或人工结算账本不一致。")
    _require(not db.execute("""SELECT 1 FROM jobs j WHERE (j.status='succeeded' AND NOT EXISTS
        (SELECT 1 FROM artworks a WHERE a.job_id=j.id AND a.id=j.artwork_id))
        OR (j.status<>'succeeded' AND j.artwork_id IS NOT NULL) LIMIT 1""").fetchone(), "任务终态与作品引用不一致。")
    _require(not db.execute("""SELECT 1 FROM artworks a JOIN jobs j ON j.id=a.job_id
        JOIN plans p ON p.id=a.plan_id WHERE a.user_id<>j.user_id OR a.plan_id<>j.plan_id
        OR a.user_id<>p.user_id OR j.status<>'succeeded' OR a.id<>j.artwork_id LIMIT 1""").fetchone(), "作品、方案或任务归属不一致。")
    _require(not db.execute("""SELECT 1 FROM image_objects i WHERE NOT EXISTS
        (SELECT 1 FROM artworks a WHERE a.image_path=i.object_key AND a.job_id=i.job_id) LIMIT 1""").fetchone(), "存在未关联作品的图片对象，须先核对。")
    _require(not db.execute("""SELECT 1 FROM audit a JOIN users u ON u.id=a.admin_user_id
        JOIN jobs j ON j.id=a.job_id WHERE u.role<>'admin' OR j.status<>'settled' LIMIT 1""").fetchone(), "人工结算记录与任务状态不一致。")
    for row in db.execute("SELECT password_hash FROM users"):
        _require(isinstance(row[0], str) and bool(PASSWORD_HASH.fullmatch(row[0])), "存在不兼容的密码哈希，请先核对账号。")
    for row in db.execute("SELECT answers FROM plans UNION ALL SELECT answers FROM artworks"):
        _json(row[0])
    for row in db.execute("SELECT options,snapshot_answers,usage_json FROM jobs"):
        for value in row:
            _json(value)
    if "authorization_codes" in tables:
        _require(not db.execute("""SELECT 1 FROM authorization_codes c
            LEFT JOIN users a ON a.id=c.created_by LEFT JOIN users u ON u.id=c.used_by
            WHERE a.role IS NULL OR a.role<>'admin'
                OR (c.used_by IS NOT NULL AND (u.role IS NULL OR u.role<>'student'))
                OR ((c.used_by IS NULL)<>(c.used_at IS NULL)) LIMIT 1""").fetchone(),
                 "授权码的生成者、使用者或使用状态不一致。")
        for row in db.execute("SELECT id,code_hash,code_hint FROM authorization_codes"):
            _require(type(row["id"]) is int and 0 < row["id"] <= 9007199254740991
                     and isinstance(row["code_hash"], str) and bool(re.fullmatch(r"[a-f0-9]{64}", row["code_hash"]))
                     and isinstance(row["code_hint"], str) and bool(re.fullmatch(r"[0-9]{4}", row["code_hint"])),
                     "授权码记录格式不正确。")


def _local_image_name(artwork):
    _require(bool(re.fullmatch(r"[a-f0-9]{32}", artwork["id"])), "作品编号格式不正确。")
    extension = EXTENSIONS.get(artwork["mime"])
    _require(extension is not None, "图片类型不受支持。")
    expected = f"artworks/{artwork['user_id']}/{artwork['id']}{extension}"
    _require(artwork["image_path"] == expected, "原图片路径或归属不符合私有目录规则。")
    return artwork["id"] + extension


def _expected_row(table, source_row):
    result = dict(source_row)
    if table == "plans":
        result.pop("revision")
    elif table == "jobs":
        result.pop("reservation_active")
        result.pop("storage_reservation_bytes")
        payload = {"plan_id": result["plan_id"], "prompt": result["prompt"], "options": _json(result["options"]),
                   "answers": _json(result["snapshot_answers"]), "title": result["snapshot_title"]}
        # 指纹依据原任务快照，不能用后来修改过的方案覆盖历史请求。
        result["request_hash"] = hashlib.sha256(json_object(payload, "生成请求", 65536).encode("utf-8")).hexdigest()
    elif table == "artworks":
        result["image_path"] = _local_image_name(result)
    return result


def _copy_image(source, artwork, artwork_dir):
    name = _local_image_name(artwork)
    image = source.execute("SELECT * FROM image_objects WHERE object_key=?", (artwork["image_path"],)).fetchone()
    _require(image is not None and image["completed"] == 1, "作品图片对象缺失或不完整。")
    size = image["byte_size"]
    _require(type(size) is int and 0 < size <= MAX_IMAGE_BYTES, "原图大小超过迁移限制。")
    count = (size + IMAGE_CHUNK_BYTES - 1) // IMAGE_CHUNK_BYTES
    _require(image["chunk_count"] == count and image["mime"] == artwork["mime"] and image["job_id"] == artwork["job_id"], "图片分片数、类型或任务归属不一致。")
    metadata = _json(image["metadata_json"])
    _require(metadata.get("job_id") == artwork["job_id"] and metadata.get("artwork_id") == artwork["id"], "图片元数据归属不一致。")
    target = artwork_dir / name
    digest = hashlib.sha256()
    encoded_size = total = 0
    with target.open("xb") as handle:
        for index, row in enumerate(source.execute("SELECT chunk_index,body_base64 FROM image_chunks WHERE object_key=? ORDER BY chunk_index", (image["object_key"],))):
            _require(row["chunk_index"] == index and index < count, "图片分片缺失、重复或顺序异常。")
            encoded = row["body_base64"]
            _require(isinstance(encoded, str) and len(encoded) <= 1024 * 1024, "图片分片编码超过限制。")
            part = base64.b64decode(encoded, validate=True)
            _require(base64.b64encode(part).decode("ascii") == encoded, "图片分片编码不规范。")
            _require(len(part) == min(IMAGE_CHUNK_BYTES, size - index * IMAGE_CHUNK_BYTES), "图片分片长度不一致。")
            handle.write(part)
            digest.update(part)
            total += len(part)
            encoded_size += len(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    _require(total == size and encoded_size == image["encoded_size"] and digest.hexdigest() == image["sha256"], "图片大小或SHA-256校验失败。")
    _require(inspect_image(target.read_bytes()) == (artwork["mime"], artwork["width"], artwork["height"]), "图片实际类型或尺寸与作品不一致。")
    target.chmod(0o600)
    return {"file": name, "bytes": total, "sha256": digest.hexdigest()}


def _business_tables(db):
    present = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # 旧快照可能尚无授权码表；已有该表时必须逐行迁移，不能静默丢弃。
    return TABLES + tuple(table for table in OPTIONAL_TABLES if table in present)


def _counts(db):
    return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in _business_tables(db)}


def _reconcile(source, target):
    source_counts, target_counts = _counts(source), _counts(target)
    _require(all(source_counts.get(table, 0) == target_counts.get(table, 0)
                 for table in (*TABLES, *OPTIONAL_TABLES)), "迁移前后业务记录数不一致。")
    for table in _business_tables(source):
        for row in source.execute(f"SELECT * FROM {table} ORDER BY rowid"):
            expected = _expected_row(table, row)
            found = target.execute(f"SELECT * FROM {table} WHERE id=?", (row["id"],)).fetchone()
            _require(found is not None and dict(found) == expected, "迁移前后业务字段或账本不一致。")
    _require(not list(target.execute("PRAGMA foreign_key_check")), "目标数据库存在断开的引用。")


def _summary(source, source_hash, images):
    return {"format_version": 1, "source_sha256": source_hash, "counts": _counts(source),
            "credits_total": source.execute("SELECT COALESCE(SUM(credits),0) FROM users").fetchone()[0],
            "reserved_credits_total": 0, "image_count": len(images),
            "image_bytes": sum(image["bytes"] for image in images),
            "job_status_counts": {row[0]: row[1] for row in source.execute("SELECT status,COUNT(*) FROM jobs GROUP BY status")},
            "sessions_migrated": False, "api_settings_migrated": False}


def migrate_d1(sql_path, destination):
    """创建全新的数据目录；不合并、不覆盖任何现有数据，不调用绘图服务。"""
    destination = Path(destination).absolute()
    _require(not destination.exists() and not destination.is_symlink(), "目标目录已有内容或已经存在，拒绝覆盖。")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with _source_database(sql_path) as (source, source_hash):
        _validate_source(source)
        with tempfile.TemporaryDirectory(prefix=".aiht-migration-", dir=destination.parent) as temporary:
            stage = Path(temporary) / "data"
            stage.mkdir(mode=0o700)
            images_dir = stage / "artworks"
            images_dir.mkdir(mode=0o700)
            target = sqlite3.connect(stage / "creation.sqlite3")
            target.row_factory = sqlite3.Row
            try:
                target.executescript(_SCHEMA)
                target.execute("PRAGMA foreign_keys=ON")
                with target:
                    for table in _business_tables(source):
                        for row in source.execute(f"SELECT * FROM {table} ORDER BY rowid"):
                            values = _expected_row(table, row)
                            columns = ",".join(values)
                            placeholders = ",".join("?" for _ in values)
                            target.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", tuple(values.values()))
                _reconcile(source, target)
                images = [_copy_image(source, dict(row), images_dir) for row in source.execute("SELECT * FROM artworks ORDER BY rowid")]
                report = _summary(source, source_hash, images)
                manifest = {**report, "images": images}
                (stage / "migration-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            finally:
                target.close()
            for name in ("creation.sqlite3", "migration-manifest.json"):
                (stage / name).chmod(0o600)
            # 最后再检查一次，不替换已有数据目录。
            _require(not destination.exists() and not destination.is_symlink(), "目标目录已有内容，拒绝覆盖。")
            os.rename(stage, destination)
            return {**report, "verified": True}


def verify_migration(sql_path, destination):
    """启动新服务前复核转换结果；只读，不修补任何差异。"""
    destination = Path(destination).absolute()
    _require(not destination.is_symlink(), "目标数据目录不能是符号链接。")
    destination = destination.resolve(strict=True)
    with _source_database(sql_path) as (source, source_hash):
        _validate_source(source)
        manifest = json.loads((destination / "migration-manifest.json").read_text(encoding="utf-8"))
        _require(manifest.get("source_sha256") == source_hash, "核对快照与迁移来源不同。")
        database_path = destination / "creation.sqlite3"
        _require(database_path.is_file() and not database_path.is_symlink(), "目标数据库缺失或是符号链接。")
        _require(not (destination / "artworks").is_symlink(), "私有图片目录不能是符号链接。")
        target = sqlite3.connect(database_path.as_uri() + "?mode=ro", uri=True)
        target.row_factory = sqlite3.Row
        try:
            _require(target.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "目标数据库完整性检查失败。")
            _reconcile(source, target)
            image_rows = []
            for artwork in source.execute("SELECT * FROM artworks ORDER BY rowid"):
                image = source.execute("SELECT * FROM image_objects WHERE object_key=?", (artwork["image_path"],)).fetchone()
                filename = _local_image_name(artwork)
                path = destination / "artworks" / filename
                _require(path.is_file() and not path.is_symlink(), "目标私有图片缺失或是链接。")
                _require(path.stat().st_size == image["byte_size"] and _file_hash(path) == image["sha256"], "目标图片大小或SHA-256不一致。")
                image_rows.append({"file": filename, "bytes": image["byte_size"], "sha256": image["sha256"]})
            _require(manifest == {**_summary(source, source_hash, image_rows), "images": image_rows}, "迁移核对清单不一致。")
            return {**_summary(source, source_hash, image_rows), "verified": True}
        finally:
            target.close()


def inspect_d1(sql_path):
    """仅检查业务和终态，输出汇总；不会生成正式数据目录。"""
    with _source_database(sql_path) as (source, source_hash):
        _validate_source(source)
        images = [{"bytes": row[0]} for row in source.execute("SELECT byte_size FROM image_objects")]
        return {**_summary(source, source_hash, images), "active_jobs": 0,
                "source_checked": True, "image_bytes_verified": False}


def main():
    parser = argparse.ArgumentParser(description="把D1业务SQL转换为新的私有数据目录；不会覆盖旧数据。")
    parser.add_argument("sql", type=Path, help="官方Wrangler导出的业务SQL快照")
    parser.add_argument("destination", type=Path, nargs="?", help="尚不存在的目标数据目录")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check-only", action="store_true", help="仅检查来源业务终态，不转换")
    group.add_argument("--verify", action="store_true", help="只读核对已转换的新目录")
    args = parser.parse_args()
    if not args.check_only and args.destination is None:
        parser.error("转换或复核需要指定目标目录。")
    try:
        report = (inspect_d1(args.sql) if args.check_only else
                  verify_migration(args.sql, args.destination) if args.verify else migrate_d1(args.sql, args.destination))
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (MigrationError, OSError, sqlite3.Error, ValueError):
        # CLI 不打印SQL、姓名、手机号、密码哈希、提示词或密钥。
        error = sys.exc_info()[1]
        message = str(error) if isinstance(error, MigrationError) else "迁移输入或文件操作失败，请在受保护目录检查输入及权限。"
        print(json.dumps({"ok": False, "message": message}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
