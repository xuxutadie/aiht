"""授权码只使用合成账号和临时 SQLite，覆盖原子注册与管理权限。"""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from studio.auth import hash_password
from studio.contracts import DomainError
from studio.store import Store
from studio.web import Application, StudioServer
from test_http import Client, FakeProvider, FakeSettings
from test_store import profile


class AuthorizationCodeStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db_path = Path(self.directory.name) / "authorization.sqlite3"
        self.store = Store(self.db_path)
        self.admin = self.store.create_user({"name": "授权老师", "phone": "13700137000"},
                                            "teacher123", role="admin")

    def issue(self, count=1):
        return self.store.create_authorization_codes(self.admin["id"], count)

    def register(self, code, phone="13800138000"):
        return self.store.create_user(profile(phone), "student123", authorization_code=code)

    def assert_domain_error(self, status, code, call):
        with self.assertRaises(DomainError) as caught:
            call()
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))
        return caught.exception.message

    def test_student_cannot_register_without_an_authorization_code(self):
        self.assert_domain_error(400, "authorization_code_required",
                                 lambda: self.store.create_user(profile(), "student123"))
        self.assertEqual(len(self.store.list_users()), 1)

    def test_empty_and_malformed_codes_are_rejected_without_creating_users(self):
        for code in (None, "", "   "):
            with self.subTest(code=code):
                self.assert_domain_error(400, "authorization_code_required", lambda: self.register(code))
        for code in (12345678, True, [], {}, "1234567", "01234567", "123456789", "１２３４５６７８", "12ab5678", "1234\n678"):
            with self.subTest(code=code):
                self.assert_domain_error(400, "invalid_authorization_code", lambda: self.register(code))
        self.assertEqual(len(self.store.list_users()), 1)

    def test_new_codes_are_eight_digits_and_database_contains_only_hashes(self):
        issued = self.issue(3)
        self.assertEqual(len(issued), 3)
        self.assertEqual(len({item["code"] for item in issued}), 3)
        with self.store.connection() as connection:
            rows = [dict(row) for row in connection.execute("SELECT * FROM authorization_codes ORDER BY id")]
        for item, row in zip(issued, rows):
            self.assertRegex(item["code"], r"^[1-9][0-9]{7}$")
            self.assertEqual(row["code_hash"], hashlib.sha256(item["code"].encode("ascii")).hexdigest())
            self.assertEqual(row["code_hint"], item["code"][-4:])
            self.assertNotIn(item["code"], row.values())
            self.assertEqual(set(item), {"id", "code", "code_hint", "status", "created_at", "used_by", "used_at"})
            self.assertEqual((item["status"], item["used_by"], item["used_at"]), ("unused", None, None))

    def test_generation_retries_collisions_and_has_no_total_count_cap(self):
        with patch("studio.store.secrets.randbelow", side_effect=(0, 0, 1)):
            first = self.issue()[0]
            second = self.issue()[0]
        self.assertEqual((first["code"], second["code"]), ("10000000", "10000001"))
        self.issue(100)
        self.issue(100)
        with self.store.connection() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM authorization_codes").fetchone()[0], 202)

    def test_repeated_collisions_stop_with_retryable_error_and_roll_back_whole_batch(self):
        with patch("studio.store.secrets.randbelow", return_value=0):
            original = self.issue()[0]
        # 首个新码先写入，再持续撞已有码；用兜底异常防止错误实现让测试卡住。
        attempts = [1] + [0] * 1000 + [AssertionError("授权码生成超过尝试预算")]
        with patch("studio.store.secrets.randbelow", side_effect=attempts):
            self.assert_domain_error(503, "authorization_code_generation_failed", lambda: self.issue(2))
        listed = self.store.list_authorization_codes(self.admin["id"])
        self.assertEqual([item["id"] for item in listed["codes"]], [original["id"]])
        with self.store.connection() as connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM authorization_codes WHERE code_hint = '0001'").fetchone())

    def test_count_and_pagination_require_bounded_integers(self):
        for count in (0, 101, -1, True, "1", 1.5, None):
            with self.subTest(count=count):
                with self.assertRaises(DomainError) as caught:
                    self.issue(count)
                self.assertEqual(caught.exception.status, 400)
        for options in ({"limit": 0}, {"limit": 101}, {"limit": True}, {"limit": "2"},
                        {"before": 0}, {"before": -1}, {"before": True}, {"before": "2"},
                        {"before": 2 ** 53}):
            with self.subTest(options=options):
                with self.assertRaises(DomainError) as caught:
                    self.store.list_authorization_codes(self.admin["id"], **options)
                self.assertEqual(caught.exception.status, 400)

    def test_registration_consumes_one_code_and_grants_once(self):
        code = self.issue()[0]["code"]
        user = self.register("  " + code + "  ")
        self.assertEqual((user["role"], user["credits"], user["reserved_credits"]), ("student", 10, 0))
        entries = self.store.ledger(user["id"])
        self.assertEqual([(item["kind"], item["delta"]) for item in entries], [("grant", 10)])
        listed = self.store.list_authorization_codes(self.admin["id"])["codes"][0]
        self.assertEqual((listed["status"], listed["used_by"]), ("used", user["id"]))
        self.assertIsNotNone(listed["used_at"])
        used_message = self.assert_domain_error(400, "invalid_authorization_code",
                                                lambda: self.register(code, "13900139000"))
        absent = "10000000" if code != "10000000" else "10000001"
        absent_message = self.assert_domain_error(400, "invalid_authorization_code",
                                                  lambda: self.register(absent, "13900139000"))
        self.assertEqual(used_message, absent_message)
        self.assertEqual(len(self.store.list_users()), 2)

    def test_duplicate_phone_and_invalid_profile_or_password_do_not_consume_code(self):
        self.register(self.issue()[0]["code"])
        code = self.issue()[0]["code"]
        self.assert_domain_error(409, "phone_registered", lambda: self.register(code))
        for data, password in (({**profile("13900139000"), "school": ""}, "student123"),
                               (profile("13900139000"), "short")):
            with self.assertRaises(DomainError):
                self.store.create_user(data, password, authorization_code=code)
            self.assertEqual(self.store.list_authorization_codes(self.admin["id"])["codes"][0]["status"], "unused")
        user = self.register(code, "13900139000")
        self.assertEqual(user["credits"], 10)

    def test_database_failure_rolls_back_new_user_gift_and_code(self):
        code = self.issue()[0]["code"]
        with patch.object(self.store, "_ledger_in", side_effect=sqlite3.OperationalError("合成故障")):
            with self.assertRaises(sqlite3.OperationalError):
                self.register(code)
        self.assertEqual(len(self.store.list_users()), 1)
        self.assertIsNone(self.store.authenticate("13800138000", "student123"))
        listed = self.store.list_authorization_codes(self.admin["id"])["codes"][0]
        self.assertEqual((listed["status"], listed["used_by"], listed["used_at"]), ("unused", None, None))
        self.assertEqual(self.register(code)["credits"], 10)

    def test_failure_while_consuming_code_rolls_back_user_and_gift(self):
        code = self.issue()[0]["code"]
        with self.store.transaction() as connection:
            connection.execute("""CREATE TRIGGER reject_code_consumption BEFORE UPDATE ON authorization_codes
                BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.register(code)
        self.assertEqual(len(self.store.list_users()), 1)
        with self.store.transaction() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM ledger").fetchone()[0], 1)
            self.assertIsNone(connection.execute("SELECT used_by FROM authorization_codes").fetchone()[0])
            connection.execute("DROP TRIGGER reject_code_consumption")
        self.assertEqual(self.register(code)["credits"], 10)

    def test_two_concurrent_registrations_can_consume_a_code_only_once(self):
        code = self.issue()[0]["code"]
        barrier = threading.Barrier(2)

        def register(phone):
            barrier.wait()
            try:
                return self.register(code, phone)
            except DomainError as error:
                return (error.status, error.code)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(register, ("13800138000", "13900139000")))
        self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
        self.assertIn((400, "invalid_authorization_code"), results)
        with self.store.connection() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM users WHERE role = 'student'").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT count(*) FROM ledger WHERE kind = 'grant'").fetchone()[0], 2)

    def test_students_cannot_issue_or_list_authorization_codes(self):
        user = self.register(self.issue()[0]["code"])
        self.assert_domain_error(403, "admin_required", lambda: self.store.create_authorization_codes(user["id"]))
        self.assert_domain_error(403, "admin_required", lambda: self.store.list_authorization_codes(user["id"]))

    def test_descending_cursor_pagination_never_returns_a_full_code_or_hash(self):
        issued = self.issue(5)
        first = self.store.list_authorization_codes(self.admin["id"], limit=2)
        self.assertEqual([item["id"] for item in first["codes"]], [issued[4]["id"], issued[3]["id"]])
        self.assertEqual(first["next_cursor"], issued[3]["id"])
        self.issue()
        second = self.store.list_authorization_codes(self.admin["id"], limit=2, before=first["next_cursor"])
        final = self.store.list_authorization_codes(self.admin["id"], limit=2, before=second["next_cursor"])
        self.assertEqual([item["id"] for item in second["codes"] + final["codes"]],
                         [issued[2]["id"], issued[1]["id"], issued[0]["id"]])
        self.assertIsNone(final["next_cursor"])
        for item in first["codes"] + second["codes"] + final["codes"]:
            self.assertEqual(set(item), {"id", "code_hint", "status", "created_at", "used_by", "used_at"})

    def test_database_constraints_keep_usage_fields_consistent_and_user_unique(self):
        codes = self.issue(2)
        user = self.register(codes[0]["code"])
        for statement, parameters in (
                ("UPDATE authorization_codes SET used_at = ? WHERE id = ?", ("test", codes[1]["id"])),
                ("UPDATE authorization_codes SET used_by = ? WHERE id = ?", (self.admin["id"], codes[1]["id"])),
                ("UPDATE authorization_codes SET used_by = ?, used_at = ? WHERE id = ?", (user["id"], "test", codes[1]["id"]))):
            with self.subTest(statement=statement), self.assertRaises(sqlite3.IntegrityError):
                with self.store.transaction() as connection:
                    connection.execute(statement, parameters)

    def test_existing_database_migration_preserves_accounts_sessions_plans_jobs_and_ledger(self):
        # 用合成旧账号模拟升级前的数据，避免通过注册路径制造迁移前提。
        user_id, timestamp = "legacy-user", "2025-01-01T00:00:00+00:00"
        with self.store.transaction() as connection:
            connection.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                               (user_id, "老学员", "13800138000", "贵州", "示例学校", "七年级", "student",
                                hash_password("student123"), 10, 0, timestamp))
            self.store._ledger_in(connection, user_id, "grant", 10, None, "旧赠送记录")
        token = self.store.create_session(user_id)
        plan = self.store.create_plan(user_id, "旧方案", {"theme": "旧主题"})
        self.store.save_plan(user_id, plan["id"], plan["answers"], 4, True)
        self.store.reserve_generation(user_id, plan["id"], "legacy-job", "旧提示词", {"ratio": "1:1"})
        tables = ("users", "sessions", "plans", "jobs", "ledger", "artworks", "audit")
        with self.store.transaction() as connection:
            connection.execute("DROP TABLE IF EXISTS authorization_codes")
            before = {table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                      for table in tables}
        migrated = Store(self.db_path)
        with migrated.connection() as connection:
            after = {table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                     for table in tables}
            self.assertEqual(connection.execute("SELECT count(*) FROM authorization_codes").fetchone()[0], 0)
        self.assertEqual(before, after)
        self.assertEqual(migrated.authenticate("13800138000", "student123")["id"], user_id)
        self.assertEqual(migrated.get_user_by_session(token)["id"], user_id)


class AuthorizationCodeHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = Application(Path(self.directory.name), provider=FakeProvider(), settings=FakeSettings(), test_mode=True)
        self.server = StudioServer(("127.0.0.1", 0), self.app)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.admin = Client(self.port)
        status, result, _ = self.admin.request("POST", "/api/setup", {
            "name": "指导老师", "phone": "13700137000", "password": "teacher123"})
        self.assertEqual(status, 200, result)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.app.close()
        self.app.jobs.executor.shutdown(wait=True)
        self.directory.cleanup()

    def issue(self, count=1):
        status, result, _ = self.admin.request("POST", "/api/admin/authorization-codes", {"count": count})
        self.assertEqual(status, 201, result)
        return result["codes"]

    def registration(self, code=None, **extra):
        return {**profile(), "password": "student123", "authorization_code": code, **extra}

    def test_public_registration_requires_code_and_cannot_override_role(self):
        client = Client(self.port)
        for body in (self.registration(), self.registration(role="admin")):
            status, result, _ = client.request("POST", "/api/register", body)
            self.assertEqual(status, 400, result)
            self.assertEqual(result["error"]["code"], "authorization_code_required")
        code = self.issue()[0]["code"]
        status, result, _ = client.request("POST", "/api/register", self.registration(code, role="admin"))
        self.assertEqual(status, 200, result)
        self.assertEqual(result["user"]["role"], "student")
        self.assertEqual(result["user"]["credits"], 10)
        status, result, _ = Client(self.port).request("POST", "/api/register", self.registration(code, phone="13900139000"))
        self.assertEqual((status, result["error"]["code"]), (400, "invalid_authorization_code"))

    def test_admin_endpoints_deny_anonymous_and_students(self):
        client = Client(self.port)
        for method in ("GET", "POST"):
            self.assertEqual(client.request(method, "/api/admin/authorization-codes", {"count": 1})[0], 401)
        code = self.issue()[0]["code"]
        self.assertEqual(client.request("POST", "/api/register", self.registration(code))[0], 200)
        for method in ("GET", "POST"):
            self.assertEqual(client.request(method, "/api/admin/authorization-codes", {"count": 1})[0], 403)

    def test_admin_create_response_shows_full_code_once_and_list_uses_cursor(self):
        issued = self.issue(3)
        status, first, headers = self.admin.request("GET", "/api/admin/authorization-codes?limit=2")
        self.assertEqual(status, 200, first)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual([item["id"] for item in first["codes"]], [issued[2]["id"], issued[1]["id"]])
        status, final, _ = self.admin.request("GET", f"/api/admin/authorization-codes?limit=2&before={first['next_cursor']}")
        self.assertEqual(status, 200, final)
        self.assertEqual([item["id"] for item in final["codes"]], [issued[0]["id"]])
        self.assertIsNone(final["next_cursor"])
        for item in first["codes"] + final["codes"]:
            self.assertNotIn("code", item)
            self.assertNotIn("code_hash", item)
        for code in issued:
            self.assertNotIn(code["code"], json.dumps(first) + json.dumps(final))

    def test_admin_endpoints_reject_bad_count_or_cursor_parameters(self):
        for count in (0, 101, True, "1", 1.5, None):
            status, result, _ = self.admin.request("POST", "/api/admin/authorization-codes", {"count": count})
            self.assertEqual((status, result["error"]["code"]), (400, "invalid_authorization_code_count"))
        for query in ("limit=0", "limit=101", "limit=x", "limit=", "before=0", "before=-1", "before=x", "before=",
                      "before=9007199254740992", "before=1&before=2", "limit=1&limit=2"):
            with self.subTest(query=query):
                status, result, _ = self.admin.request("GET", "/api/admin/authorization-codes?" + query)
                self.assertEqual((status, result["error"]["code"]), (400, "invalid_pagination"))

    def test_database_error_does_not_expose_code_in_response_or_server_logs(self):
        code = self.issue()[0]["code"]
        with patch.object(self.app.store, "_ledger_in", side_effect=sqlite3.OperationalError(code)), \
                self.assertLogs("creation.web", level="ERROR") as logged:
            status, result, _ = Client(self.port).request("POST", "/api/register", self.registration(code))
        self.assertEqual((status, result["error"]["code"]), (500, "internal_error"))
        self.assertNotIn(code, json.dumps(result) + " ".join(logged.output))
        self.assertEqual(len(self.app.store.list_users()), 1)
        self.assertEqual(self.admin.request("GET", "/api/admin/authorization-codes")[1]["codes"][0]["status"], "unused")

    def test_registration_keeps_existing_rate_limit(self):
        def enforce_register_limit(key, maximum, seconds):
            if key[0] == "register":
                self.assertEqual((maximum, seconds), (120, 600))
                raise DomainError(429, "rate_limited", "请稍后重试。")

        with patch.object(self.app.limiter, "check", side_effect=enforce_register_limit):
            status, result, _ = Client(self.port).request("POST", "/api/register", self.registration("12345678"))
        self.assertEqual((status, result["error"]["code"]), (429, "rate_limited"))


if __name__ == "__main__":
    unittest.main()
