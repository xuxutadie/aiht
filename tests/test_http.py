"""真实本机 HTTP 流程测试；绘图由独立假服务承担，不触发真实出图。"""

from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.cookies import SimpleCookie
from pathlib import Path
import json
import struct
import tempfile
import threading
import time
import unittest
import uuid
import zlib

from studio.provider import GeneratedImage, ProviderError
from studio.web import Application, StudioServer


def fixture_png():
    """标准库构造一张有效的2×2 PNG，仅用于接口测试。"""
    def chunk(kind, content):
        return (struct.pack(">I", len(content)) + kind + content
                + struct.pack(">I", zlib.crc32(kind + content)))
    rows = (b"\0" + b"\x55\x88\xaa" * 2) * 2
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def complete_answers():
    return {
        "task_understanding": "表达城市与自然共生", "theme": "小鸟的绿色城市",
        "reason": "希望小鸟也有自己的家", "message": "给自然留下生活空间",
        "message_detail": "楼顶树木连接成绿色通道", "subject": "小鸟和树木",
        "scene": "未来城市楼顶", "action": "小鸟在树林间飞行", "details": "树梢有温暖的鸟巢",
        "ratio": "1:1", "style": "水彩", "style_reason": "柔和色彩表现温暖感受",
        "innovation_type": "新的组合", "innovation": "楼房与树林组成鸟类通道",
        "innovation_visible": "每栋楼顶都有连通的小树林",
    }


class FakeSettings:
    def __init__(self):
        self.enabled = True
        self.values = {"api_key": "integration-test-secret-only", "model": "doubao-seedream-5-0-flash-260915",
                       "base_url": "https://ark.cn-beijing.volces.com/api/v3", "watermark": True}

    def configured(self):
        return self.enabled

    def get(self):
        return dict(self.values)

    def public(self):
        return {"configured": self.enabled, "model": self.values["model"],
                "base_url": self.values["base_url"], "watermark": self.values["watermark"],
                "key_hint": "已配置（测试）"}

    def update(self, payload):
        self.values.update({key: value for key, value in payload.items() if key != "api_key" or value})
        return self.public()


class FakeProvider:
    def __init__(self):
        self.mode = "success"
        self.calls = 0
        self.lock = threading.Lock()
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()

    def generate(self, prompt, options):
        with self.lock:
            self.calls += 1
        self.entered.set()
        if not self.release.wait(5):
            raise ProviderError("测试绘图等待超时", uncertain=True)
        if self.mode == "failure":
            raise ProviderError("绘图服务明确拒绝请求", uncertain=False, request_id="integration-rejected")
        if self.mode == "uncertain":
            raise ProviderError("绘图结果未完整收到，等待老师核对", uncertain=True, request_id="integration-timeout")
        return GeneratedImage(fixture_png(), "image/png", 2, 2, {"generated_images": 1}, "integration-request")


class Client:
    def __init__(self, port):
        self.port = port
        self.cookie = ""

    def request(self, method, path, payload=None, *, headers=None, origin=True, raw=None):
        sent_headers = {}
        body = raw
        if self.cookie:
            sent_headers["Cookie"] = self.cookie
        if method in ("POST", "PUT"):
            if origin is not None:
                sent_headers["Origin"] = f"http://127.0.0.1:{self.port}" if origin is True else origin
            sent_headers["Content-Type"] = "application/json"
            if body is None:
                body = json.dumps({} if payload is None else payload, ensure_ascii=False).encode("utf-8")
        sent_headers.update(headers or {})
        connection = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=sent_headers)
            response = connection.getresponse()
            content = response.read()
            received_headers = {key.lower(): value for key, value in response.getheaders()}
            if "set-cookie" in received_headers:
                cookies = SimpleCookie(received_headers["set-cookie"])
                self.cookie = "; ".join(f"{key}={morsel.value}" for key, morsel in cookies.items() if morsel.value)
            data = json.loads(content) if received_headers.get("content-type", "").startswith("application/json") else content
            return response.status, data, received_headers
        finally:
            connection.close()


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.directory.name)
        self.settings, self.provider = FakeSettings(), FakeProvider()
        self.app = Application(self.data_dir, provider=self.provider, settings=self.settings, test_mode=True)
        self.server = StudioServer(("127.0.0.1", 0), self.app)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.provider.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.app.close()
        # 清理临时数据库之前，确保所有测试工作线程已退出。
        self.app.jobs.executor.shutdown(wait=True)
        self.directory.cleanup()

    def client(self):
        return Client(self.port)

    def admin(self):
        client = self.client()
        status, data, _ = client.request("POST", "/api/setup", {
            "name": "指导老师", "phone": "13700137000", "password": "teacher123"})
        self.assertEqual(status, 200, data)
        return client, data["user"]

    def student(self, phone="13800138000", name="学生小明"):
        client = self.client()
        status, data, _ = client.request("POST", "/api/register", {
            "name": name, "phone": phone, "password": "student123", "region": "贵州省贵阳市",
            "school": "示例中学", "grade": "七年级"})
        self.assertEqual(status, 200, data)
        return client, data["user"]

    def plan(self, client, *, confirmed=True):
        status, data, _ = client.request("POST", "/api/plans", {"title": "绿色城市", "answers": complete_answers()})
        self.assertEqual(status, 201, data)
        plan = data["plan"]
        if confirmed:
            status, data, _ = client.request("PUT", f"/api/plans/{plan['id']}", {
                "title": plan["title"], "answers": plan["answers"], "step": 5, "confirmed": True})
            self.assertEqual(status, 200, data)
            plan = data["plan"]
            self.assertTrue(plan["confirmed"])
        return plan

    def generate(self, client, plan, key=None):
        return client.request("POST", "/api/generate", {"plan_id": plan["id"], "request_key": key or str(uuid.uuid4())})

    def wait_job(self, client, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, data, _ = client.request("GET", f"/api/jobs/{job_id}")
            self.assertEqual(status, 200, data)
            if data["job"]["status"] not in ("queued", "running"):
                return data
            time.sleep(0.01)
        self.fail("测试任务未在限定时间内进入终态")

    def test_bootstrap_setup_is_local_once_and_cookie_is_private(self):
        client = self.client()
        status, data, _ = client.request("GET", "/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertTrue(data["setup_required"])
        self.assertIsNone(data["user"])
        status, data, headers = client.request("POST", "/api/setup", {
            "name": "指导老师", "phone": "13700137000", "password": "teacher123"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["role"], "admin")
        self.assertIn("HttpOnly", headers["set-cookie"])
        self.assertIn("SameSite=Strict", headers["set-cookie"])
        self.assertIn("Max-Age=604800", headers["set-cookie"])
        self.assertNotIn("teacher123", json.dumps(data))
        self.assertNotIn("password_hash", json.dumps(data))
        status, data, _ = client.request("GET", "/api/bootstrap")
        self.assertFalse(data["setup_required"])
        self.assertEqual(data["user"]["role"], "admin")
        self.assertEqual(client.request("POST", "/api/setup", {"name": "另一老师", "phone": "13600136000", "password": "teacher456"})[0], 409)

    def test_registration_login_and_logout_do_not_repeat_the_gift(self):
        self.admin()
        client, user = self.student()
        self.assertEqual((user["credits"], user["reserved_credits"], user["available_credits"]), (10, 0, 10))
        self.assertEqual(client.request("POST", "/api/register", {"name": "学生", "phone": "13800138000", "password": "student123", "region": "贵州", "school": "示例学校", "grade": "七年级"})[0], 409)
        self.assertEqual(client.request("POST", "/api/logout")[0], 200)
        self.assertEqual(client.request("GET", "/api/me")[0], 401)
        self.assertEqual(client.request("POST", "/api/login", {"phone": "13800138000", "password": "wrong123"})[0], 401)
        status, data, _ = client.request("POST", "/api/login", {"phone": "13800138000", "password": "student123"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["credits"], 10)
        status, data, _ = client.request("GET", "/api/credits")
        self.assertEqual(status, 200)
        self.assertEqual(len(data["entries"]), 1)
        self.assertEqual(data["entries"][0]["delta"], 10)

    def test_anonymous_private_routes_are_denied(self):
        client = self.client()
        for path in ("/api/me", "/api/plans", "/api/artworks", "/api/credits", "/api/admin/settings"):
            with self.subTest(path=path):
                self.assertEqual(client.request("GET", path)[0], 401)

    def test_incomplete_confirmation_and_changed_confirmed_plan_cannot_generate(self):
        self.admin()
        client, _ = self.student()
        status, data, _ = client.request("POST", "/api/plans", {"answers": {"theme": "未来城市"}})
        self.assertEqual(status, 201)
        incomplete = data["plan"]
        status, data, _ = client.request("PUT", f"/api/plans/{incomplete['id']}", {"answers": incomplete["answers"], "step": 4, "confirmed": True})
        self.assertEqual(status, 400)
        self.assertEqual(self.generate(client, incomplete)[0], 409)
        plan = self.plan(client)
        changed = {**plan["answers"], "theme": "改后的创作主题"}
        status, data, _ = client.request("PUT", f"/api/plans/{plan['id']}", {"answers": changed, "step": 4, "confirmed": True})
        self.assertEqual(status, 200, data)
        self.assertFalse(data["plan"]["confirmed"])
        self.assertEqual(self.generate(client, plan)[0], 409)
        self.assertEqual(self.provider.calls, 0)

    def test_success_and_concurrent_duplicate_key_call_provider_once(self):
        self.admin()
        client, _ = self.student()
        plan = self.plan(client)
        self.provider.release.clear()
        key = str(uuid.uuid4())
        duplicate = self.client()
        duplicate.cookie = client.cookie
        with ThreadPoolExecutor(max_workers=2) as pool:
            requests = [pool.submit(self.generate, each, plan, key) for each in (client, duplicate)]
            replies = [future.result(5) for future in requests]
        self.assertTrue(self.provider.entered.wait(2))
        self.assertEqual([reply[0] for reply in replies], [202, 202])
        job = replies[0][1]["job"]
        self.assertEqual(job["id"], replies[1][1]["job"]["id"])
        self.assertEqual(self.provider.calls, 1)
        self.assertEqual(client.request("GET", "/api/me")[1]["user"]["reserved_credits"], 1)
        self.provider.release.set()
        result = self.wait_job(client, job["id"])
        self.assertEqual(result["job"]["status"], "succeeded")
        self.assertEqual(result["job"]["upstream_request_id"], "integration-request")
        self.assertNotIn("usage", result["job"])
        self.assertNotIn("usage_json", result["job"])
        self.assertEqual((result["user"]["credits"], result["user"]["reserved_credits"]), (9, 0))
        artwork_id = result["job"]["artwork_id"]
        status, data, _ = client.request("GET", f"/api/artworks/{artwork_id}")
        self.assertEqual(status, 200)
        artwork = data["artwork"]
        self.assertEqual(artwork["image_path"], f"/api/artworks/{artwork_id}/image")
        self.assertNotIn(str(self.data_dir), json.dumps(data))
        self.assertIn("AI辅助与修改过程", artwork["description"])
        self.assertEqual(client.request("GET", artwork["image_path"])[1], fixture_png())
        status, image, headers = client.request("GET", f"/api/artworks/{artwork_id}/download")
        self.assertEqual((status, image), (200, fixture_png()))
        self.assertIn("attachment", headers["content-disposition"])
        self.assertEqual(self.generate(client, plan, key)[0], 202)
        self.assertEqual(self.provider.calls, 1)
        self.assertEqual(client.request("GET", "/api/credits")[1]["user"]["credits"], 9)

    def test_cross_account_plan_job_artwork_and_admin_settings_are_denied(self):
        admin, _ = self.admin()
        owner, _ = self.student()
        plan = self.plan(owner)
        status, data, _ = self.generate(owner, plan)
        self.assertEqual(status, 202)
        result = self.wait_job(owner, data["job"]["id"])
        job_id, artwork_id = result["job"]["id"], result["job"]["artwork_id"]
        other, _ = self.student("13900139000", "学生小红")
        for path in (f"/api/plans/{plan['id']}", f"/api/jobs/{job_id}", f"/api/artworks/{artwork_id}",
                     f"/api/artworks/{artwork_id}/image", f"/api/artworks/{artwork_id}/download"):
            with self.subTest(path=path):
                self.assertEqual(other.request("GET", path)[0], 404)
        self.assertEqual(other.request("PUT", f"/api/plans/{plan['id']}", {"answers": {}, "step": 0})[0], 404)
        self.assertEqual(other.request("POST", f"/api/plans/{plan['id']}/preview")[0], 404)
        self.assertEqual(self.generate(other, plan)[0], 404)
        self.assertEqual(other.request("PUT", f"/api/artworks/{artwork_id}", {"reflection": "修改", "description": "修改"})[0], 404)
        self.assertEqual(other.request("GET", "/api/plans")[1]["plans"], [])
        self.assertEqual(other.request("GET", "/api/artworks")[1]["artworks"], [])
        self.assertEqual(other.request("GET", "/api/admin/settings")[0], 403)
        self.assertEqual(other.request("PUT", "/api/admin/settings", {"api_key": "x"})[0], 403)
        self.assertEqual(other.request("GET", "/api/admin/overview")[0], 403)
        self.assertEqual(admin.request("GET", f"/api/artworks/{artwork_id}/image")[0], 200)
        self.assertEqual(admin.request("PUT", f"/api/artworks/{artwork_id}", {"reflection": "代改", "description": "代改"})[0], 404)
        status, data, _ = admin.request("GET", "/api/admin/settings")
        self.assertEqual(status, 200)
        self.assertNotIn("integration-test-secret-only", json.dumps(data))
        self.assertNotIn("api_key", data)

    def test_definite_failure_returns_reserved_credit(self):
        self.admin()
        client, _ = self.student()
        self.provider.mode = "failure"
        status, data, _ = self.generate(client, self.plan(client))
        self.assertEqual(status, 202)
        result = self.wait_job(client, data["job"]["id"])
        self.assertEqual(result["job"]["status"], "failed")
        self.assertEqual(result["job"]["upstream_request_id"], "integration-rejected")
        self.assertEqual((result["user"]["credits"], result["user"]["reserved_credits"], result["user"]["available_credits"]), (10, 0, 10))
        self.assertEqual(self.provider.calls, 1)

    def test_uncertain_result_stays_frozen_until_admin_resolves_once(self):
        admin, _ = self.admin()
        client, _ = self.student()
        self.provider.mode = "uncertain"
        plan = self.plan(client)
        for consume, expected_credits in ((False, 10), (True, 9)):
            with self.subTest(consume=consume):
                status, data, _ = self.generate(client, plan)
                self.assertEqual(status, 202)
                job_id = data["job"]["id"]
                result = self.wait_job(client, job_id)
                self.assertEqual(result["job"]["status"], "uncertain")
                self.assertEqual(result["job"]["upstream_request_id"], "integration-timeout")
                self.assertEqual(result["user"]["reserved_credits"], 1)
                self.assertEqual(client.request("POST", f"/api/admin/jobs/{job_id}/resolve", {"consume": False, "reason": "不应允许"})[0], 403)
                status, overview, _ = admin.request("GET", "/api/admin/overview")
                self.assertEqual(status, 200)
                self.assertEqual(len(overview["uncertain_jobs"]), 1)
                decision = {"consume": consume, "reason": "已人工核对上游记录"}
                self.assertEqual(admin.request("POST", f"/api/admin/jobs/{job_id}/resolve", decision)[0], 200)
                self.assertEqual(admin.request("POST", f"/api/admin/jobs/{job_id}/resolve", decision)[0], 409)
                result = self.wait_job(client, job_id)
                self.assertEqual(result["job"]["status"], "settled")
                self.assertEqual((result["user"]["credits"], result["user"]["reserved_credits"]), (expected_credits, 0))

    def test_unconfigured_generation_does_not_reserve_or_call_provider(self):
        self.admin()
        client, _ = self.student()
        plan = self.plan(client)
        self.settings.enabled = False
        self.assertEqual(self.generate(client, plan)[0], 409)
        user = client.request("GET", "/api/me")[1]["user"]
        self.assertEqual((user["credits"], user["reserved_credits"]), (10, 0))
        self.assertEqual(self.provider.calls, 0)

    def test_same_key_restores_original_job_after_draft_and_configuration_change(self):
        self.admin()
        client, _ = self.student()
        plan = self.plan(client)
        key = str(uuid.uuid4())
        self.provider.release.clear()
        status, data, _ = self.generate(client, plan, key)
        self.assertEqual(status, 202)
        changed = {**plan["answers"], "theme": "新的主题"}
        status, saved, _ = client.request("PUT", f"/api/plans/{plan['id']}", {"answers": changed, "step": 4, "confirmed": False})
        self.assertEqual(status, 200)
        self.assertFalse(saved["plan"]["confirmed"])
        self.settings.enabled = False
        status, restored, _ = self.generate(client, plan, key)
        self.assertEqual(status, 202, restored)
        self.assertEqual(restored["job"]["id"], data["job"]["id"])
        self.assertEqual(restored["user"]["reserved_credits"], 1)
        self.provider.release.set()
        self.assertEqual(self.wait_job(client, data["job"]["id"])["job"]["status"], "succeeded")
        self.assertEqual(self.provider.calls, 1)

    def test_same_key_with_different_plan_id_is_conflict(self):
        self.admin()
        client, _ = self.student()
        first = self.plan(client)
        second = self.plan(client, confirmed=False)
        key = str(uuid.uuid4())
        self.provider.release.clear()
        status, data, _ = self.generate(client, first, key)
        self.assertEqual(status, 202)
        status, conflict, _ = self.generate(client, second, key)
        self.assertEqual(status, 409)
        self.assertEqual(conflict["error"]["code"], "request_conflict")
        self.provider.release.set()
        self.assertEqual(self.wait_job(client, data["job"]["id"])["job"]["status"], "succeeded")
        self.assertEqual(self.provider.calls, 1)

    def test_csrf_non_json_malformed_json_and_host_are_rejected(self):
        client = self.client()
        for origin in (None, "https://other.example"):
            with self.subTest(origin=origin):
                self.assertEqual(client.request("POST", "/api/setup", origin=origin)[0], 403)
        self.assertEqual(client.request("POST", "/api/setup", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(client.request("POST", "/api/setup", headers={"Content-Type": "text/plain"}, raw=b"{}")[0], 415)
        self.assertEqual(client.request("POST", "/api/setup", raw=b"{")[0], 400)
        self.assertEqual(client.request("POST", "/api/setup", raw=b"[]")[0], 400)
        self.assertEqual(client.request("POST", "/api/setup", raw=b" " * 65537)[0], 413)
        self.assertEqual(client.request("GET", "/api/bootstrap", headers={"Host": "evil.example"})[0], 403)

    def test_private_database_source_and_static_traversal_are_not_served(self):
        client = self.client()
        for path in ("/data/creation.sqlite3", "/creation.sqlite3", "/studio/store.py", "/.env",
                     "/../studio/store.py", "/%2e%2e/studio/store.py", "/%2e%2e%5cstudio%5cstore.py"):
            with self.subTest(path=path):
                status, _, _ = client.request("GET", path)
                self.assertIn(status, (403, 404))


if __name__ == "__main__":
    unittest.main()
