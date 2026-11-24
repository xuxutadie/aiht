"""用真实 SQLite 验证账号隔离、预占额度和结算。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from studio.contracts import DomainError
from studio.store import Store


def profile(phone="13800138000", name="小明同学"):
    return {"name": name, "phone": phone, "region": "贵州省贵阳市",
            "school": "示例中学", "grade": "七年级"}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db_path = Path(self.directory.name) / "studio.sqlite3"
        self.store = Store(self.db_path)
        self._admin = self.store.create_user({"name": "指导老师", "phone": "13700137000"},
                                             "teacher123", role="admin")
        self.user = self.create_student(profile(), "student123")
        self.plan = self.store.create_plan(self.user["id"], "未来城市", {"theme": "绿色"})
        self.plan = self.store.save_plan(self.user["id"], self.plan["id"],
                                         self.plan["answers"], 4, True)

    def assert_error(self, status, call):
        with self.assertRaises(DomainError) as caught:
            call()
        self.assertEqual(caught.exception.status, status)

    def reserve(self, key="request-1"):
        return self.store.reserve_generation(self.user["id"], self.plan["id"], key,
                                             "画一座绿色城市", {"ratio": "1:1"})

    def artifact(self):
        return {"image_path": "example.png", "mime": "image/png", "width": 1024,
                "height": 1024, "description": "作品说明", "reflection": "我的思考"}

    def second_user(self):
        return self.create_student(profile("13900139000", "小红同学"), "student456")

    def create_student(self, data, password):
        code = self.store.create_authorization_codes(self._admin["id"])[0]["code"]
        return self.store.create_user(data, password, authorization_code=code)

    def admin(self):
        return self._admin

    def reserve_admin(self, key):
        admin_id = self.admin()["id"]
        plan = self.store.create_plan(admin_id, "指导创作", {"theme": "绿色"})
        plan = self.store.save_plan(admin_id, plan["id"], plan["answers"], 4, True)
        return self.store.reserve_generation(admin_id, plan["id"], key,
                                             "画一座绿色城市", {"ratio": "1:1"})

    def test_admin_has_unlimited_credits_without_numeric_grant_or_deduction(self):
        admin_id = self.admin()["id"]
        self.assertTrue(self.admin()["unlimited_credits"])
        self.assertFalse(self.user["unlimited_credits"])
        self.assertEqual(self.admin()["credits"], 0)
        for index in range(12):
            job = self.reserve_admin(f"admin-{index}")
            self.assertTrue(job["unlimited_credits"])
            self.assertTrue(self.store.get_job_by_request(admin_id, f"admin-{index}")["unlimited_credits"])
            self.assertEqual(self.store.get_user(admin_id)["reserved_credits"], 0)
            self.store.mark_job_running(job["id"])
            first = self.store.complete_generation(job["id"], self.artifact())
            repeated = self.store.complete_generation(job["id"], self.artifact())
            self.store.fail_generation(job["id"], "迟到的失败")
            self.assertEqual(first["id"], repeated["id"])
            self.assertTrue(self.store.get_job(admin_id, job["id"])["unlimited_credits"])
        entries = self.store.ledger(admin_id)
        self.assertTrue(all(entry["delta"] == 0 and entry["balance_after"] == 0 for entry in entries))
        self.assertEqual(sum(entry["kind"] == "consume" for entry in entries), 12)
        self.assertEqual(sum(entry["kind"] == "reserve" for entry in entries), 12)
        self.assertEqual(self.store.get_user(admin_id)["credits"], 0)

    def test_admin_fail_restart_and_manual_settlement_never_change_numeric_balance(self):
        admin_id = self.admin()["id"]
        failed = self.reserve_admin("admin-fail")
        self.store.fail_generation(failed["id"], "明确失败")
        self.store.fail_generation(failed["id"], "重复")
        uncertain = self.reserve_admin("admin-uncertain")
        self.store.fail_generation(uncertain["id"], "等待核对", uncertain=True)
        interrupted = self.reserve_admin("admin-restart")
        self.store.mark_job_running(interrupted["id"])
        reopened = Store(self.db_path)
        reopened.mark_interrupted_jobs_uncertain()
        reopened.mark_interrupted_jobs_uncertain()
        self.assertTrue(all(job["unlimited_credits"] for job in reopened.list_uncertain_jobs()))
        reopened.resolve_uncertain_job(uncertain["id"], True, admin_id, "确实生成")
        reopened.resolve_uncertain_job(interrupted["id"], False, admin_id, "没有生成")
        self.assert_error(409, lambda: reopened.resolve_uncertain_job(uncertain["id"], True, admin_id, "重复"))
        self.assertEqual((reopened.get_user(admin_id)["credits"], reopened.get_user(admin_id)["reserved_credits"]), (0, 0))
        self.assertTrue(all(entry["delta"] == 0 for entry in reopened.ledger(admin_id)))
        with closing(sqlite3.connect(self.db_path)) as connection:
            self.assertEqual(dict(connection.execute("SELECT job_id, consume FROM audit")),
                             {uncertain["id"]: 1, interrupted["id"]: 0})

    def test_historical_admin_reservations_settle_at_previous_policy(self):
        admin_id = self.admin()["id"]
        # 临时数据库中模拟升级前已有的预留任务，兼容三种旧任务结算方式。
        legacy_one = self.reserve_admin("legacy-success")
        legacy_two = self.reserve_admin("legacy-failure")
        legacy_three = self.reserve_admin("legacy-uncertain")
        with closing(sqlite3.connect(self.db_path)) as connection, connection:
            connection.execute("UPDATE users SET credits=10,reserved_credits=3 WHERE id=?", (admin_id,))
            connection.execute("UPDATE ledger SET delta=10,balance_after=10,note='首次注册赠送10点算力' WHERE user_id=? AND kind='grant'", (admin_id,))
            connection.execute("UPDATE ledger SET balance_after=10,note='已预留1点算力，生成成功后扣除' WHERE job_id IN (?,?,?)",
                               (legacy_one["id"], legacy_two["id"], legacy_three["id"]))
        new_job = self.reserve_admin("after-upgrade")
        self.assertFalse(self.store.get_job(admin_id, legacy_one["id"])["unlimited_credits"])
        self.assertTrue(new_job["unlimited_credits"])
        self.store.complete_generation(new_job["id"], self.artifact())
        self.assertEqual(self.store.get_user(admin_id)["reserved_credits"], 3)
        self.store.complete_generation(legacy_one["id"], self.artifact())
        self.store.fail_generation(legacy_two["id"], "旧任务失败")
        self.store.fail_generation(legacy_three["id"], "旧任务待核对", uncertain=True)
        self.store.resolve_uncertain_job(legacy_three["id"], True, admin_id, "已生成")
        user = self.store.get_user(admin_id)
        self.assertTrue(user["unlimited_credits"])
        self.assertEqual((user["credits"], user["reserved_credits"]), (8, 0))
        self.assertEqual(sum(entry["delta"] for entry in self.store.ledger(admin_id)), 8)

    def test_registration_grants_once_and_duplicate_phone_cannot_grant_again(self):
        self.assertEqual(self.user["credits"], 10)
        self.assertEqual(self.user["reserved_credits"], 0)
        self.assertEqual(self.user["available_credits"], 10)
        self.assert_error(409, lambda: self.create_student(profile(), "student456"))
        entries = self.store.ledger(self.user["id"])
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["delta"], 10)
        self.assertEqual(entries[0]["balance_after"], 10)

    def test_legacy_system_credit_terms_are_normalized_without_rewriting_records(self):
        job = self.reserve()
        old_note = "首次注册赠送10次创作额度"
        old_error = "服务正在关闭，本次尚未发送绘图请求，次数已保留。"
        personal_note = "老师核对：学生第一次尝试，原话是想生成10次不同画面。"
        before = self.store.get_user(self.user["id"])
        with closing(sqlite3.connect(self.db_path)) as connection, connection:
            connection.execute("UPDATE ledger SET note = ? WHERE user_id = ? AND kind = 'grant'", (old_note, self.user["id"]))
            connection.execute("UPDATE ledger SET note = ? WHERE job_id = ? AND kind = 'reserve'", (personal_note, job["id"]))
            connection.execute("UPDATE jobs SET status = 'uncertain', error_message = ? WHERE id = ?", (old_error, job["id"]))
        entries = self.store.ledger(self.user["id"])
        self.assertEqual(next(entry["note"] for entry in entries if entry["kind"] == "grant"), "首次注册赠送10点算力")
        self.assertEqual(next(entry["note"] for entry in entries if entry["kind"] == "reserve"), personal_note)
        expected_error = "服务正在关闭，本次尚未发送绘图请求，算力不扣除。"
        self.assertEqual(self.store.get_job(self.user["id"], job["id"])["error_message"], expected_error)
        self.assertEqual(self.store.list_uncertain_jobs()[0]["error_message"], expected_error)
        self.assertEqual(self.store.get_user(self.user["id"]), before)
        with closing(sqlite3.connect(self.db_path)) as connection:
            self.assertEqual(connection.execute("SELECT note FROM ledger WHERE user_id = ? AND kind = 'grant'", (self.user["id"],)).fetchone()[0], old_note)
            self.assertEqual(connection.execute("SELECT error_message FROM jobs WHERE id = ?", (job["id"],)).fetchone()[0], old_error)

    def test_authentication_hides_credentials_and_rejects_wrong_password(self):
        found = self.store.authenticate("13800138000", "student123")
        self.assertEqual(found["id"], self.user["id"])
        self.assertIsNone(self.store.authenticate("13800138000", "wrong123"))
        self.assertIsNone(self.store.authenticate("1" * 10000, "x" * 10000))
        self.assertIsNone(self.store.authenticate("\ud800", "student123"))
        self.assertNotIn("password", repr(found))
        self.assertNotIn("hash", repr(found))

    def test_invalid_profiles_and_passwords_do_not_create_users(self):
        for field, value in (("name", ""), ("phone", "138001380001"),
                             ("region", ""), ("school", []), ("grade", ""),
                             ("name", "a" * 1000), ("phone", "1" * 10000)):
            data = profile("13600136000")
            data[field] = value
            self.assert_error(400, lambda d=data: self.create_student(d, "student123"))
        self.assert_error(400, lambda: self.create_student(profile("13600136000"), "a" * 129))
        self.assertEqual(len(self.store.list_users()), 2)

    def test_malformed_unicode_profile_has_a_safe_validation_error(self):
        data = profile("13600136000")
        data["name"] = "测试\ud800"
        self.assert_error(400, lambda: self.create_student(data, "student123"))

    def test_malformed_unicode_text_has_a_safe_validation_error(self):
        self.assert_error(400, lambda: self.store.create_plan(self.user["id"], "测试\ud800"))

    def test_only_one_admin_can_be_created_under_concurrency(self):
        store = Store(Path(self.directory.name) / "fresh-setup.sqlite3")
        barrier = threading.Barrier(2)
        def create(phone):
            barrier.wait()
            try:
                store.create_user({"name": "老师", "phone": phone}, "teacher123", "admin")
                return "created"
            except DomainError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(create, ("13500135000", "13600136000")))
        self.assertCountEqual(results, ["created", 409])
        self.assertTrue(store.has_admin())
        self.assertEqual(sum(u["role"] == "admin" for u in store.list_users()), 1)

    def test_sessions_store_only_hash_expire_and_logout(self):
        token = self.store.create_session(self.user["id"])
        self.assertEqual(self.store.get_user_by_session(token)["id"], self.user["id"])
        with closing(sqlite3.connect(self.db_path)) as connection, connection:
            row = connection.execute("SELECT * FROM sessions").fetchone()
            self.assertNotIn(token, row)
            connection.execute("UPDATE sessions SET expires_at = 0")
        self.assertIsNone(self.store.get_user_by_session(token))
        token = self.store.create_session(self.user["id"])
        self.store.delete_session(token)
        self.assertIsNone(self.store.get_user_by_session(token))

    def test_students_cannot_read_or_change_another_users_plan(self):
        other = self.second_user()
        self.assertEqual(self.store.list_plans(other["id"]), [])
        self.assert_error(404, lambda: self.store.get_plan(other["id"], self.plan["id"]))
        self.assert_error(404, lambda: self.store.save_plan(other["id"], self.plan["id"], {}, 0))
        admin = self.admin()
        self.assert_error(404, lambda: self.store.get_plan(admin["id"], self.plan["id"]))

    def test_content_change_cancels_confirmation_but_navigation_keeps_it(self):
        moved = self.store.save_plan(self.user["id"], self.plan["id"], self.plan["answers"], 5, True)
        self.assertTrue(moved["confirmed"])
        changed = self.store.save_plan(self.user["id"], self.plan["id"], {"theme": "蓝色"}, 4, True)
        self.assertFalse(changed["confirmed"])
        self.assert_error(409, lambda: self.reserve())
        saved = self.store.save_plan(self.user["id"], self.plan["id"], changed["answers"], 4, True)
        self.assertTrue(saved["confirmed"])

    def test_plan_rejects_invalid_step_and_oversized_answers(self):
        for step in (-1, 7, True, "4"):
            self.assert_error(400, lambda s=step: self.store.save_plan(
                self.user["id"], self.plan["id"], {}, s))
        self.assert_error(400, lambda: self.store.create_plan(self.user["id"], "测试", {"text": "图" * 100000}))
        self.assert_error(400, lambda: self.store.create_plan(self.user["id"], "测试", []))

    def test_reservation_deduplicates_and_rejects_changed_payload(self):
        first = self.reserve()
        repeated = self.reserve()
        self.assertEqual(first["id"], repeated["id"])
        user = self.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"], user["available_credits"]), (10, 1, 9))
        self.assert_error(409, lambda: self.store.reserve_generation(
            self.user["id"], self.plan["id"], "request-1", "另一幅画", {"ratio": "1:1"}))

    def test_changed_plan_snapshot_does_not_reserve_credit(self):
        expected_hash = hashlib.sha256(json.dumps(
            {"title": "未来城市", "answers": {"theme": "绿色"}},
            ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        self.store.save_plan(self.user["id"], self.plan["id"], {"theme": "蓝色"}, 4, False)
        with self.assertRaises(DomainError) as caught:
            self.store.reserve_generation(self.user["id"], self.plan["id"], "stale-snapshot",
                                          "旧方案的提示词", {"ratio": "1:1"}, expected_hash)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "plan_changed"))
        user = self.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"], user["available_credits"]), (10, 0, 10))
        self.assertIsNone(self.store.get_job_by_request(self.user["id"], "stale-snapshot"))

    def test_matching_plan_snapshot_can_reserve(self):
        expected_hash = hashlib.sha256(json.dumps(
            {"title": "未来城市", "answers": {"theme": "绿色"}},
            ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        job = self.store.reserve_generation(self.user["id"], self.plan["id"], "matching-snapshot",
                                            "画一座绿色城市", {"ratio": "1:1"}, expected_hash)
        self.assertEqual(job["status"], "queued")
        self.assertEqual(self.store.get_user(self.user["id"])["reserved_credits"], 1)

    def test_request_lookup_is_scoped_to_owner_and_only_returns_public_fields(self):
        job = self.reserve("lookup-request")
        other = self.second_user()
        self.assertIsNone(self.store.get_job_by_request(other["id"], "lookup-request"))
        self.assertIsNone(self.store.get_job_by_request(self.user["id"], "unknown-request"))
        found = self.store.get_job_by_request(self.user["id"], "lookup-request")
        self.assertEqual(found, job)
        for hidden in ("prompt", "options", "request_hash", "snapshot_answers", "snapshot_title"):
            self.assertNotIn(hidden, found)

    def test_only_one_worker_can_claim_the_same_job(self):
        job = self.reserve()
        barrier = threading.Barrier(2)
        def claim(_):
            barrier.wait()
            return self.store.mark_job_running(job["id"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, range(2)))
        self.assertCountEqual(results, [True, False])
        self.store.fail_generation(job["id"], "等待核对", uncertain=True)
        self.assertFalse(self.store.mark_job_running(job["id"]))

    def test_internal_job_payload_uses_the_reserved_snapshot(self):
        job = self.reserve()
        self.store.save_plan(self.user["id"], self.plan["id"], {"theme": "修改"}, 3)
        internal = self.store.get_job_internal(job["id"])
        self.assertEqual(internal["prompt"], "画一座绿色城市")
        self.assertEqual(internal["options"], {"ratio": "1:1"})
        self.assertEqual(internal["answers"], {"theme": "绿色"})
        self.assertNotIn("prompt", self.store.get_job(self.user["id"], job["id"]))

    def test_provider_tracking_is_safe_and_usage_stays_internal(self):
        job = self.reserve()
        self.store.record_provider_result(job["id"], "request_ID-2026:abc.1", {
            "generated_images": 1, "output_tokens": 12, "api_key": "不应保存的文字"})
        public = self.store.get_job(self.user["id"], job["id"])
        self.assertEqual(public["upstream_request_id"], "request_ID-2026:abc.1")
        self.assertNotIn("usage", public)
        self.assertNotIn("usage_json", public)
        internal = self.store.get_job_internal(job["id"])
        self.assertEqual(internal["usage"], {"generated_images": 1, "output_tokens": 12})
        self.assertNotIn("不应保存的文字", repr(internal))
        self.store.record_provider_result(job["id"], "", None)
        self.store.fail_generation(job["id"], "等待老师核对", uncertain=True)
        pending = self.store.list_uncertain_jobs()[0]
        self.assertEqual(pending["upstream_request_id"], "request_ID-2026:abc.1")
        self.assertNotIn("usage", pending)
        self.assertEqual(self.store.get_job_internal(job["id"])["usage"], {"generated_images": 1, "output_tokens": 12})

    def test_provider_tracking_rejects_unsafe_identifiers_and_large_usage(self):
        job = self.reserve()
        for identifier in (None, "r" * 161, "中文编号", "request\r\nsecret", "https://example.com/id"):
            with self.subTest(identifier=repr(identifier)):
                self.assert_error(400, lambda value=identifier: self.store.record_provider_result(job["id"], value))
        for usage in ([], {"text": "x" * 5000}, {"output_tokens": float("nan")}):
            with self.subTest(usage=type(usage).__name__):
                self.assert_error(400, lambda value=usage: self.store.record_provider_result(job["id"], "request-safe", value))
        self.assertEqual(self.store.get_job(self.user["id"], job["id"])["upstream_request_id"], "")

    def test_provider_tracking_does_not_change_idempotent_quota_settlement(self):
        job = self.reserve()
        for _ in range(2):
            self.store.record_provider_result(job["id"], "request-once", {"generated_images": 1})
            self.store.complete_generation(job["id"], self.artifact())
        user = self.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"]), (9, 0))
        self.assertEqual(len(self.store.list_artworks(self.user["id"])), 1)
        self.assertEqual(sum(entry["delta"] for entry in self.store.ledger(self.user["id"])), 9)

    def test_old_database_gets_tracking_columns_without_changing_existing_job(self):
        job = self.reserve()
        # 在临时数据库中还原旧版 jobs 布局，保留已有账号、预占和请求记录。
        with closing(sqlite3.connect(self.db_path)) as connection, connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
            for column in ("upstream_request_id", "usage_json"):
                if column in columns:
                    connection.execute(f"ALTER TABLE jobs DROP COLUMN {column}")
        migrated = Store(self.db_path)
        restored = migrated.get_job(self.user["id"], job["id"])
        self.assertEqual(restored["id"], job["id"])
        self.assertEqual(restored["upstream_request_id"], "")
        self.assertEqual(migrated.get_job_internal(job["id"])["usage"], {})
        repeated = migrated.reserve_generation(self.user["id"], self.plan["id"], "request-1", "画一座绿色城市", {"ratio": "1:1"})
        self.assertEqual(repeated["id"], job["id"])
        self.assertEqual(migrated.get_user(self.user["id"])["reserved_credits"], 1)
        migrated.record_provider_result(job["id"], "legacy-request", {"generated_images": 1})
        reopened = Store(self.db_path)
        self.assertEqual(reopened.get_job(self.user["id"], job["id"])["upstream_request_id"], "legacy-request")
        for _ in range(2):
            reopened.complete_generation(job["id"], self.artifact())
        self.assertEqual(reopened.get_user(self.user["id"])["credits"], 9)

    def test_two_concurrent_jobs_cannot_spend_last_credit_twice(self):
        with closing(sqlite3.connect(self.db_path)) as connection, connection:
            connection.execute("UPDATE users SET credits = 1 WHERE id = ?", (self.user["id"],))
        barrier = threading.Barrier(2)
        def run(key):
            barrier.wait()
            try:
                return self.reserve(key)["id"]
            except DomainError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, ("concurrent-1", "concurrent-2")))
        self.assertEqual(sum(isinstance(item, str) for item in results), 1)
        self.assertIn(409, results)
        user = self.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"], user["available_credits"]), (1, 1, 0))

    def test_exhausted_credits_ask_admin_to_replenish_without_changing_balance(self):
        for index in range(10):
            job = self.reserve(f"spent-{index}")
            self.store.complete_generation(job["id"], self.artifact())
        before = self.store.get_user(self.user["id"])
        before_entries = self.store.ledger(self.user["id"])
        self.assertEqual((before["credits"], before["reserved_credits"], before["available_credits"]), (0, 0, 0))
        with self.assertRaises(DomainError) as caught:
            self.reserve("after-exhausted")
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "insufficient_credits"))
        self.assertEqual(caught.exception.message, "算力已用完，请联系管理员进行补充算力。")
        self.assertEqual(self.store.get_user(self.user["id"]), before)
        self.assertEqual(self.store.ledger(self.user["id"]), before_entries)
        self.assertIsNone(self.store.get_job_by_request(self.user["id"], "after-exhausted"))

    def test_reserved_credits_ask_to_wait_without_suggesting_replenishment(self):
        for index in range(10):
            self.reserve(f"reserved-{index}")
        before = self.store.get_user(self.user["id"])
        before_entries = self.store.ledger(self.user["id"])
        self.assertEqual((before["credits"], before["reserved_credits"], before["available_credits"]), (10, 10, 0))
        with self.assertRaises(DomainError) as caught:
            self.reserve("after-all-reserved")
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "insufficient_credits"))
        self.assertIn("预留", caught.exception.message)
        self.assertIn("等待", caught.exception.message)
        self.assertIn("核对", caught.exception.message)
        self.assertNotIn("补充", caught.exception.message)
        self.assertNotIn("充值", caught.exception.message)
        self.assertEqual(self.store.get_user(self.user["id"]), before)
        self.assertEqual(self.store.ledger(self.user["id"]), before_entries)
        self.assertIsNone(self.store.get_job_by_request(self.user["id"], "after-all-reserved"))

    def test_success_is_charged_once_and_callback_is_idempotent(self):
        job = self.reserve()
        self.store.mark_job_running(job["id"])
        artwork = self.store.complete_generation(job["id"], self.artifact())
        repeated = self.store.complete_generation(job["id"], self.artifact())
        self.store.fail_generation(job["id"], "迟到的失败")
        self.assertEqual(artwork["id"], repeated["id"])
        self.assertEqual(artwork["prompt"], "画一座绿色城市")
        self.assertEqual(artwork["answers"], {"theme": "绿色"})
        user = self.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"]), (9, 0))
        self.assertEqual(len(self.store.list_artworks(self.user["id"])), 1)
        self.assertEqual(sum(entry["delta"] for entry in self.store.ledger(self.user["id"])), 9)
        self.assertEqual(self.store.get_job(self.user["id"], job["id"])["status"], "succeeded")

    def test_explicit_failure_releases_once_without_consuming(self):
        job = self.reserve()
        self.store.fail_generation(job["id"], "请求格式错误")
        self.store.fail_generation(job["id"], "重复失败")
        user = self.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"]), (10, 0))
        self.assertEqual(self.store.get_job(self.user["id"], job["id"])["status"], "failed")
        self.assert_error(409, lambda: self.store.complete_generation(job["id"], self.artifact()))

    def test_timeout_freezes_credit_and_only_admin_can_settle_once(self):
        job = self.reserve()
        self.store.fail_generation(job["id"], "连接超时，请老师核对", uncertain=True)
        self.store.fail_generation(job["id"], "重复失败")
        self.assertEqual(self.store.get_user(self.user["id"])["reserved_credits"], 1)
        self.assertEqual(len(self.store.list_uncertain_jobs()), 1)
        self.assert_error(403, lambda: self.store.resolve_uncertain_job(job["id"], False, self.user["id"], "已核对"))
        admin = self.admin()
        self.store.resolve_uncertain_job(job["id"], True, admin["id"], "后台确认已生成")
        self.assert_error(409, lambda: self.store.resolve_uncertain_job(job["id"], False, admin["id"], "再次核对"))
        user = self.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"]), (9, 0))
        self.assertEqual(self.store.get_job(self.user["id"], job["id"])["status"], "settled")
        with closing(sqlite3.connect(self.db_path)) as connection, connection:
            row = connection.execute("SELECT admin_user_id, reason FROM audit").fetchone()
        self.assertEqual(row, (admin["id"], "后台确认已生成"))

    def test_restart_marks_active_jobs_uncertain_without_retrying(self):
        queued = self.reserve("queued-job")
        running = self.reserve("running-job")
        self.store.mark_job_running(running["id"])
        restarted = Store(self.db_path)
        restarted.mark_interrupted_jobs_uncertain()
        restarted.mark_interrupted_jobs_uncertain()
        for job in (queued, running):
            self.assertEqual(restarted.get_job(self.user["id"], job["id"])["status"], "uncertain")
        self.assertEqual(restarted.get_user(self.user["id"])["reserved_credits"], 2)

    def test_job_and_artwork_ownership_isolation(self):
        job = self.reserve()
        artwork = self.store.complete_generation(job["id"], self.artifact())
        other = self.second_user()
        self.assert_error(404, lambda: self.store.get_job(other["id"], job["id"]))
        self.assert_error(404, lambda: self.store.get_artwork(other["id"], artwork["id"]))
        self.assert_error(404, lambda: self.store.update_artwork(other["id"], artwork["id"], "篡改", "篡改"))
        self.assertEqual(self.store.list_artworks(other["id"]), [])
        updated = self.store.update_artwork(self.user["id"], artwork["id"], "新的反思", "新的说明")
        self.assertEqual((updated["reflection"], updated["description"]), ("新的反思", "新的说明"))

    def test_explicit_admin_artwork_access_checks_role(self):
        job = self.reserve()
        artwork = self.store.complete_generation(job["id"], self.artifact())
        self.assert_error(403, lambda: self.store.get_artwork_for_admin(self.user["id"], artwork["id"]))
        admin = self.admin()
        found = self.store.get_artwork_for_admin(admin["id"], artwork["id"])
        self.assertEqual(found["id"], artwork["id"])
        self.assert_error(404, lambda: self.store.get_artwork(admin["id"], artwork["id"]))

    def test_manual_release_restores_availability_without_charging(self):
        job = self.reserve()
        self.store.fail_generation(job["id"], "结果未知", uncertain=True)
        admin = self.admin()
        self.store.resolve_uncertain_job(job["id"], False, admin["id"], "后台确认未生成")
        user = self.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"], user["available_credits"]), (10, 0, 10))
        self.assertEqual(self.store.list_uncertain_jobs(), [])

    def test_concurrent_duplicate_requests_share_one_reservation(self):
        barrier = threading.Barrier(2)
        def reserve(_):
            barrier.wait()
            return self.reserve("same-key")["id"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(reserve, range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.store.get_user(self.user["id"])["reserved_credits"], 1)

    def test_concurrent_completion_creates_one_artwork_and_charge(self):
        job = self.reserve()
        barrier = threading.Barrier(2)
        def finish(_):
            barrier.wait()
            return self.store.complete_generation(job["id"], self.artifact())["id"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(finish, range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.store.get_user(self.user["id"])["credits"], 9)
        self.assertEqual(len(self.store.list_artworks(self.user["id"])), 1)

    def test_generated_artwork_retains_the_requested_plan_snapshot(self):
        job = self.reserve()
        self.store.save_plan(self.user["id"], self.plan["id"], {"theme": "改后的草稿"}, 3)
        artwork = self.store.complete_generation(job["id"], self.artifact())
        self.assertEqual(artwork["answers"], {"theme": "绿色"})
        self.assertEqual(artwork["title"], "未来城市")


if __name__ == "__main__":
    unittest.main()
