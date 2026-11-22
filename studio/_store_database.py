"""SQLite 表结构、短连接和存储层共用的输入校验。"""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import uuid

from .contracts import DomainError

_LEGACY_SYSTEM_TEXT = {
    "首次注册赠送10次创作额度": "首次注册赠送10点算力",
    "已预占1次，成功后扣除": "已预留1点算力，生成成功后扣除",
    "单张作品生成成功，扣除1次": "单张作品生成成功，扣除1点算力",
    "结果待核对，保留1次预占": "结果待核对，保留预留的1点算力",
    "生成明确失败，已释放1次预占": "生成明确失败，不扣算力，已释放预留的1点算力",
    "服务重启，保留预占等待老师核对": "服务重启，保留预留的1点算力等待老师核对",
    "服务正在关闭，本次尚未发送绘图请求，次数已保留。": "服务正在关闭，本次尚未发送绘图请求，算力不扣除。",
    "服务已关闭，本次尚未发送绘图请求，次数已保留。": "服务已关闭，本次尚未发送绘图请求，算力不扣除。",
    "可用创作次数不足，请联系老师。": "可用算力点数不足，请联系老师。",
    "请选择扣除或返还额度。": "请选择扣除或返还算力。",
    "出图服务当前繁忙或额度不足，请稍后再试。": "出图服务当前繁忙或暂不可用，请联系老师。",
}


def display_system_text(value):
    """只转换已知旧系统短语的展示，不改数据库，也不替换用户文字中的“次”。"""
    return _LEGACY_SYSTEM_TEXT.get(value, value)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
    region TEXT NOT NULL, school TEXT NOT NULL, grade TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student','admin')), password_hash TEXT NOT NULL,
    credits INTEGER NOT NULL CHECK(credits >= 0),
    reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK(reserved_credits >= 0 AND reserved_credits <= credits),
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS only_initial_admin ON users(role) WHERE role = 'admin';
CREATE TABLE IF NOT EXISTS authorization_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT UNIQUE NOT NULL, code_hint TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    used_by TEXT UNIQUE REFERENCES users(id), used_at TEXT,
    CHECK ((used_by IS NULL AND used_at IS NULL) OR (used_by IS NOT NULL AND used_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS authorization_codes_created_by ON authorization_codes(created_by);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
    answers TEXT NOT NULL, step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 6),
    confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_user ON plans(user_id);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan_id TEXT NOT NULL REFERENCES plans(id),
    request_key TEXT NOT NULL, request_hash TEXT NOT NULL, prompt TEXT NOT NULL, options TEXT NOT NULL,
    snapshot_answers TEXT NOT NULL, snapshot_title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','uncertain','settled')),
    error_message TEXT, artwork_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    upstream_request_id TEXT NOT NULL DEFAULT '', usage_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(user_id,request_key)
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id);
CREATE TABLE IF NOT EXISTS artworks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    plan_id TEXT NOT NULL REFERENCES plans(id), title TEXT NOT NULL, image_path TEXT NOT NULL,
    mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, prompt TEXT NOT NULL,
    answers TEXT NOT NULL, description TEXT NOT NULL, reflection TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artworks_user ON artworks(user_id);
CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
    delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, job_id TEXT REFERENCES jobs(id),
    note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);
CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    admin_user_id TEXT NOT NULL REFERENCES users(id), consume INTEGER NOT NULL CHECK(consume IN (0,1)),
    reason TEXT NOT NULL, created_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


def text_value(value, label: str, limit: int, allow_empty=True) -> str:
    if (not isinstance(value, str) or len(value) > limit or "\x00" in value
            or any(0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise DomainError(400, "invalid_input", f"{label}格式不正确或过长。")
    value = value.strip()
    if not allow_empty and not value:
        raise DomainError(400, "invalid_input", f"请填写{label}。")
    return value


def json_object(value, label="创作答案", limit=32768) -> str:
    if not isinstance(value, dict):
        raise DomainError(400, "invalid_input", f"{label}必须是对象。")
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > limit:
            raise ValueError("too large")
        return encoded
    except (ValueError, TypeError, RecursionError, UnicodeError):
        raise DomainError(400, "invalid_input", f"{label}格式不正确或超过大小限制。") from None


def user_record(row) -> dict:
    if row is None:
        raise DomainError(404, "not_found", "账号不存在。")
    keys = ("id", "name", "phone", "region", "school", "grade", "role", "credits", "reserved_credits", "created_at")
    result = {key: row[key] for key in keys}
    result["available_credits"] = result["credits"] - result["reserved_credits"]
    return result


def plan_record(row) -> dict:
    if row is None:
        raise DomainError(404, "not_found", "创作方案不存在。")
    result = dict(row)
    result["answers"] = json.loads(result["answers"])
    result["confirmed"] = bool(result["confirmed"])
    return result


def job_record(row) -> dict:
    if row is None:
        raise DomainError(404, "not_found", "生成任务不存在。")
    keys = ("id", "user_id", "plan_id", "status", "error_message", "artwork_id", "created_at", "updated_at",
            "upstream_request_id")
    result = {key: row[key] for key in keys}
    result["error_message"] = display_system_text(result["error_message"])
    return result


def artwork_record(row) -> dict:
    if row is None:
        raise DomainError(404, "not_found", "作品不存在。")
    result = dict(row)
    result["answers"] = json.loads(result["answers"])
    return result


class Database:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript("BEGIN IMMEDIATE;\n" + _SCHEMA + "\nCOMMIT;")
        with self.transaction() as connection:
            # 小型兼容迁移只补缺少的列，不重建任务表，也不改变旧任务和额度。
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(jobs)")}
            if "upstream_request_id" not in columns:
                connection.execute("ALTER TABLE jobs ADD COLUMN upstream_request_id TEXT NOT NULL DEFAULT ''")
            if "usage_json" not in columns:
                connection.execute("ALTER TABLE jobs ADD COLUMN usage_json TEXT NOT NULL DEFAULT '{}'")

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self):
        with self.connection() as connection:
            # 写事务先拿到写锁，额度检查与更新由同一事务完成。
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise

    def _user_in(self, connection, user_id):
        return user_record(connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())

    def _ledger_in(self, connection, user_id, kind, delta, job_id, note):
        user = self._user_in(connection, user_id)
        connection.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)",
                           (new_id(), user_id, kind, delta, user["credits"], job_id, note, now()))
