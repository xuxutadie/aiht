"""迁移用合成数据验证，不连接生产或绘图接口。"""

import base64
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
import tempfile
import unittest
import zlib

from scripts.migrate_d1 import MigrationError, inspect_d1, migrate_d1, verify_migration
from studio.auth import hash_password
from studio.contracts import DomainError
from studio.jobs import JobManager
from studio.store import Store


ROOT = Path(__file__).resolve().parents[1]
USER, PLAN, JOB, ART = (character * 32 for character in "abcd")
STAMP = "2026-11-15T00:00:00.000Z"
PASSWORD = "Migration-test-2026"


def png_bytes():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    # 额外合法文本块使图片跨越两片，能验证分片顺序与完整性。
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"tEXt", b"Comment\x00" + b"q" * (768 * 1024))
            + chunk(b"IDAT", zlib.compress(b"\0\x55\x88\xaa")) + chunk(b"IEND", b""))


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.source = sqlite3.connect(":memory:")
        self.source.executescript((ROOT / "cloudflare/schema.sql").read_text(encoding="utf-8"))
        self.password_hash = hash_password(PASSWORD)
        self.image = png_bytes()
        self.key = f"artworks/{USER}/{ART}.png"
        self.answers = {"theme": "人机共生", "custom_prompt": "由学生改写的黄色纸飞机", "subject_framing": "全身"}
        self.source.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                            (USER, "合成学生", "13900000001", "测试地区", "测试学校", "小学六年级",
                             "student", self.password_hash, 9, 0, STAMP))
        self.source.execute("INSERT INTO plans VALUES (?,?,?,?,?,?,?,?,?)",
                            (PLAN, USER, "后来改过的标题", json.dumps(self.answers), 5, 1, 3, STAMP, STAMP))
        self.source.execute("""INSERT INTO jobs
            (id,user_id,plan_id,request_key,prompt,options,snapshot_answers,snapshot_title,status,
             reservation_active,storage_reservation_bytes,error_message,artwork_id,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,0,0,NULL,?,?,?)""",
                            (JOB, USER, PLAN, "original-request-key-123", "原任务提示词", '{"ratio":"16:9"}',
                             '{"theme":"原主题"}', "原任务标题", "succeeded", ART, STAMP, STAMP))
        self.source.execute("INSERT INTO artworks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (ART, USER, JOB, PLAN, "原任务标题", self.key, "image/png", 1, 1,
                             "原任务提示词", '{"theme":"原主题"}', "作品说明", "作品反思", STAMP))
        self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)",
                            ("grant-1", USER, "grant", 10, 10, None, "赠送", STAMP))
        self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)",
                            ("reserve-1", USER, "reserve", 0, 10, JOB, "预留", STAMP))
        self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)",
                            ("consume-1", USER, "consume", -1, 9, JOB, "扣除", STAMP))
        chunks = [self.image[index:index + 768 * 1024] for index in range(0, len(self.image), 768 * 1024)]
        self.source.execute("INSERT INTO image_objects VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (self.key, JOB, "image/png", len(self.image), sum(len(base64.b64encode(c)) for c in chunks),
                             len(chunks), json.dumps({"job_id": JOB, "artwork_id": ART}),
                             hashlib.sha256(self.image).hexdigest(), 1, STAMP))
        for index, body in enumerate(chunks):
            self.source.execute("INSERT INTO image_chunks VALUES (?,?,?)",
                                (self.key, index, base64.b64encode(body).decode("ascii")))
        self.source.execute("INSERT INTO sessions VALUES (?,?,?,?)", ("session-not-migrated", USER, 123456, STAMP))
        self.source.execute("INSERT INTO settings VALUES (?,?,?)", ("generation-settings", '{"encrypted_key":"do-not-copy"}', STAMP))
        self.destination = self.base / "new-data"

    def tearDown(self):
        self.source.close()
        self.temp.cleanup()

    def export(self, filename="input.sql"):
        path = self.base / filename
        path.write_text("\n".join(self.source.iterdump()), encoding="utf-8")
        return path

    def test_preserves_unused_and_used_authorization_codes(self):
        # 迁移测试自己建立来源结构，确保未适配的导入器确实会失败。
        self.source.executescript("""CREATE TABLE IF NOT EXISTS authorization_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT UNIQUE NOT NULL,
            code_hint TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL, used_by TEXT UNIQUE REFERENCES users(id), used_at TEXT,
            CHECK ((used_by IS NULL AND used_at IS NULL)
                OR (used_by IS NOT NULL AND used_at IS NOT NULL)));
            CREATE INDEX IF NOT EXISTS authorization_codes_created_by ON authorization_codes(created_by);""")
        admin_id = "e" * 32
        self.source.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                            (admin_id, "合成管理员", "13900000009", "", "", "", "admin",
                             self.password_hash, 10, 0, STAMP))
        self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)",
                            ("grant-admin", admin_id, "grant", 10, 10, None, "赠送", STAMP))
        unused_code, used_code = "48172369", "59763148"
        rows = [(41, hashlib.sha256(unused_code.encode()).hexdigest(), unused_code[-4:],
                 admin_id, STAMP, None, None),
                (42, hashlib.sha256(used_code.encode()).hexdigest(), used_code[-4:],
                 admin_id, STAMP, USER, STAMP)]
        self.source.executemany("INSERT INTO authorization_codes VALUES (?,?,?,?,?,?,?)", rows)
        source = self.export("with-authorization.sql")
        report = migrate_d1(source, self.destination)
        self.assertEqual(report["counts"]["authorization_codes"], 2)
        self.assertTrue(verify_migration(source, self.destination)["verified"])
        store = Store(self.destination / "creation.sqlite3")
        with store.connection() as db:
            self.assertEqual([tuple(row) for row in db.execute(
                "SELECT * FROM authorization_codes ORDER BY id")], rows)
        # 迁移后的未用码可注册，已用码仍不能重复使用。
        student = store.create_user({"name": "迁移后学生", "phone": "13900000010",
                                    "region": "测试", "school": "测试", "grade": "初一"},
                                   PASSWORD, authorization_code=unused_code)
        self.assertEqual(student["credits"], 10)
        with self.assertRaises(DomainError) as rejected:
            store.create_user({"name": "重复用码", "phone": "13900000011",
                               "region": "测试", "school": "测试", "grade": "初一"},
                              PASSWORD, authorization_code=used_code)
        self.assertEqual(rejected.exception.code, "invalid_authorization_code")

    def test_legacy_snapshot_without_authorization_table_still_migrates(self):
        self.source.execute("DROP TABLE IF EXISTS authorization_codes")
        report = migrate_d1(self.export("legacy.sql"), self.destination)
        self.assertTrue(report["verified"])
        store = Store(self.destination / "creation.sqlite3")
        self.assertEqual(store.authenticate("13900000001", PASSWORD)["credits"], 9)
        with store.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM authorization_codes").fetchone()[0], 0)

    def test_preserves_account_quota_prompt_and_private_image(self):
        report = migrate_d1(self.export(), self.destination)
        self.assertEqual(report["counts"]["users"], 1)
        self.assertEqual(report["counts"]["artworks"], 1)
        store = Store(self.destination / "creation.sqlite3")
        self.assertEqual(store.authenticate("13900000001", PASSWORD)["credits"], 9)
        self.assertIsNone(store.get_user_by_session("session-not-migrated"))
        self.assertEqual(store.get_plan(USER, PLAN)["answers"], self.answers)
        art = store.get_artwork(USER, ART)
        self.assertEqual((self.destination / "artworks" / art["image_path"]).read_bytes(), self.image)
        self.assertNotIn("/", art["image_path"])
        self.assertEqual((art["description"], art["reflection"]), ("作品说明", "作品反思"))
        self.assertEqual(len(store.ledger(USER)), 3)
        self.assertFalse((self.destination / "provider-settings.json").exists())
        with store.connection() as db:
            self.assertEqual(db.execute("SELECT password_hash FROM users").fetchone()[0], self.password_hash)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
            self.assertNotEqual(db.execute("SELECT request_hash FROM jobs").fetchone()[0], "")
        self.assertEqual(verify_migration(self.export(), self.destination)["verified"], True)

    def test_original_request_recovery_does_not_schedule_or_require_settings(self):
        migrate_d1(self.export(), self.destination)
        store = Store(self.destination / "creation.sqlite3")
        class NeverSettings:
            def get(self):
                raise AssertionError("恢复旧请求不应读取配置或调用绘图")
        manager = JobManager(store, None, NeverSettings(), self.destination)
        try:
            self.assertEqual(manager.submit(USER, PLAN, "original-request-key-123")["id"], JOB)
            self.assertEqual(store.get_user(USER)["credits"], 9)
        finally:
            manager.close()

    def test_refuses_overwrite_and_verifier_detects_changed_balances(self):
        source = self.export()
        migrate_d1(source, self.destination)
        with self.assertRaisesRegex(MigrationError, "已有"):
            migrate_d1(source, self.destination)
        with closing(sqlite3.connect(self.destination / "creation.sqlite3")) as db:
            db.execute("UPDATE users SET credits=8")
            db.commit()
        with self.assertRaises(MigrationError):
            verify_migration(source, self.destination)

    def test_rejects_unsettled_and_nonzero_reservation_without_output(self):
        self.source.execute("UPDATE jobs SET status='uncertain',reservation_active=1,artwork_id=NULL")
        self.source.execute("UPDATE users SET reserved_credits=1")
        with self.assertRaisesRegex(MigrationError, "在途|待核对|预留"):
            migrate_d1(self.export(), self.destination)
        self.assertFalse(self.destination.exists())

    def test_rejects_bad_digest_missing_chunk_and_owner_mismatch(self):
        cases = ["UPDATE image_objects SET sha256='" + "0" * 64 + "'",
                 "DELETE FROM image_chunks WHERE chunk_index=1",
                 "UPDATE image_objects SET metadata_json='{}'",
                 "UPDATE artworks SET image_path='../outside.png'"]
        for index, statement in enumerate(cases):
            self.source.execute("SAVEPOINT bad")
            self.source.execute(statement)
            with self.subTest(statement=index), self.assertRaises(MigrationError):
                migrate_d1(self.export(f"bad-{index}.sql"), self.destination)
            self.assertFalse(self.destination.exists())
            self.source.execute("ROLLBACK TO bad")
            self.source.execute("RELEASE bad")

    def test_rejects_unbalanced_ledger(self):
        self.source.execute("UPDATE users SET credits=10")
        with self.assertRaisesRegex(MigrationError, "账本"):
            migrate_d1(self.export(), self.destination)

    def test_rejects_missing_reservation_history_even_when_balance_matches(self):
        self.source.execute("DELETE FROM ledger WHERE kind='reserve'")
        with self.assertRaisesRegex(MigrationError, "账本"):
            migrate_d1(self.export(), self.destination)

    def test_sql_cannot_attach_file_or_run_trigger(self):
        for statement in ("ATTACH DATABASE 'outside.sqlite3' AS outside;", "CREATE TRIGGER bad AFTER INSERT ON users BEGIN DELETE FROM plans; END;"):
            path = self.export()
            path.write_text(path.read_text(encoding="utf-8") + "\n" + statement, encoding="utf-8")
            with self.assertRaises(MigrationError):
                migrate_d1(path, self.destination)
            self.assertFalse(self.destination.exists())

    def test_failed_and_manually_settled_jobs_keep_audit_and_ledger(self):
        admin, failed, settled = (character * 32 for character in "ef0")
        self.source.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                            (admin, "合成管理员", "13900000002", "", "", "", "admin", self.password_hash, 10, 0, STAMP))
        self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)", ("admin-grant", admin, "grant", 10, 10, None, "赠送", STAMP))
        for job_id, status in ((failed, "failed"), (settled, "settled")):
            self.source.execute("""INSERT INTO jobs
                (id,user_id,plan_id,request_key,prompt,options,snapshot_answers,snapshot_title,status,
                 reservation_active,storage_reservation_bytes,error_message,artwork_id,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,0,0,?,NULL,?,?)""",
                                (job_id, USER, PLAN, "historical-" + job_id, "旧任务提示词", '{}', '{}', "旧标题", status, "旧说明", STAMP, STAMP))
            self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)", ("reserve-" + job_id, USER, "reserve", 0, 9, job_id, "预留", STAMP))
        self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)", ("failed-release", USER, "release", 0, 9, failed, "释放", STAMP))
        self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)", ("settled-freeze", USER, "freeze", 0, 9, settled, "冻结", STAMP))
        self.source.execute("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)", ("settled-consume", USER, "manual_consume", -1, 8, settled, "人工核对", STAMP))
        self.source.execute("INSERT INTO audit VALUES (?,?,?,?,?,?)", ("audit-1", settled, admin, 1, "已在上游确认", STAMP))
        self.source.execute("UPDATE users SET credits=8 WHERE id=?", (USER,))
        report = migrate_d1(self.export(), self.destination)
        self.assertEqual(report["job_status_counts"], {"failed": 1, "settled": 1, "succeeded": 1})
        self.assertEqual(report["counts"]["audit"], 1)
        store = Store(self.destination / "creation.sqlite3")
        self.assertEqual(store.get_user(USER)["credits"], 8)
        self.assertEqual(store.get_job_by_request(USER, "historical-" + settled)["status"], "settled")
        self.assertEqual(len(store.ledger(USER)), 8)

    def test_check_only_report_contains_no_personal_or_prompt_data(self):
        report = inspect_d1(self.export())
        self.assertEqual(report["credits_total"], 9)
        self.assertEqual(report["image_count"], 1)
        self.assertFalse(report["image_bytes_verified"])
        self.assertFalse(self.destination.exists())
        encoded = json.dumps(report, ensure_ascii=False)
        for private in ("合成学生", "13900000001", "原任务提示词", self.password_hash, "do-not-copy"):
            self.assertNotIn(private, encoded)

    def test_semicolon_and_quote_in_user_text_do_not_break_sql(self):
        text = "学生写的';分号与单引号"
        self.source.execute("UPDATE artworks SET reflection=?", (text,))
        source = self.export()
        # 官方转储有时把多条完整SQL放在同一行，文字中的分号仍应保留。
        source.write_text(source.read_text(encoding="utf-8").replace(";\n", "; "), encoding="utf-8")
        migrate_d1(source, self.destination)
        self.assertEqual(Store(self.destination / "creation.sqlite3").get_artwork(USER, ART)["reflection"], text)

    def test_wrangler_replace_and_char_restore_multiline_text(self):
        self.source.execute("UPDATE artworks SET reflection='first-line-token'")
        source = self.export()
        source.write_text(source.read_text(encoding="utf-8").replace("'first-line-token'", "replace('first\\nsecond','\\n',char(10))"), encoding="utf-8")
        migrate_d1(source, self.destination)
        self.assertEqual(Store(self.destination / "creation.sqlite3").get_artwork(USER, ART)["reflection"], "first\nsecond")


if __name__ == "__main__":
    unittest.main()
