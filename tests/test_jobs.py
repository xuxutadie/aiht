"""生成执行器的进程互斥、关闭行为和快照竞态回归测试。"""

from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import zlib

from studio.contracts import DomainError
from studio.provider import GeneratedImage, ProviderError
from studio.web import Application


def fixture_png():
    def chunk(kind, content):
        return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\0\x55\x88\xaa")) + chunk(b"IEND", b""))


def complete_answers():
    return {"task_understanding": "表达城市与自然共生", "theme": "绿色城市", "reason": "给小鸟留下家园",
            "message": "人与自然共生", "message_detail": "楼顶树木连成通道", "subject": "小鸟和树木",
            "scene": "未来城市", "action": "小鸟穿过树林", "details": "树上有鸟巢", "ratio": "1:1",
            "style": "水彩", "style_reason": "色彩柔和", "innovation_type": "新的组合",
            "innovation": "树林和城市结合", "innovation_visible": "绿色屋顶连接成通道"}


class FakeSettings:
    def configured(self):
        return True


class BlockingProvider:
    def __init__(self):
        self.calls = 0
        self.lock = threading.Lock()
        self.entered = threading.Event()
        self.two_entered = threading.Event()
        self.release = threading.Event()

    def generate(self, prompt, options):
        with self.lock:
            self.calls += 1
            self.entered.set()
            if self.calls >= 2:
                self.two_entered.set()
        if not self.release.wait(10):
            raise ProviderError("测试绘图等待超时", uncertain=True)
        return GeneratedImage(fixture_png(), "image/png", 1, 1, {"generated_images": 1}, "job-test")


class JobsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.directory.name)
        self.provider = BlockingProvider()
        self.settings = FakeSettings()
        self.app = Application(self.data_dir, provider=self.provider, settings=self.settings, test_mode=True)
        self.addCleanup(self.cleanup)
        self.user = self.app.store.create_user({"name": "学生小明", "phone": "13800138000", "region": "贵州",
                                               "school": "示例中学", "grade": "七年级"}, "student123")
        plan = self.app.store.create_plan(self.user["id"], "绿色城市", complete_answers())
        self.plan = self.app.store.save_plan(self.user["id"], plan["id"], plan["answers"], 5, True)

    def cleanup(self):
        self.provider.release.set()
        self.app.close()
        self.app.jobs.executor.shutdown(wait=True)
        self.directory.cleanup()

    def submit(self, key=None):
        return self.app.jobs.submit(self.user["id"], self.plan["id"], key or str(uuid.uuid4()))

    def wait_status(self, job_id, status):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = self.app.store.get_job(self.user["id"], job_id)
            if job["status"] == status:
                return job
            time.sleep(0.01)
        self.fail(f"测试任务未进入预期状态：{status}")

    def test_second_application_cannot_change_first_instances_running_job(self):
        job = self.submit()
        self.assertTrue(self.provider.entered.wait(2))
        self.assertEqual(self.app.store.get_job(self.user["id"], job["id"])["status"], "running")
        second = None
        try:
            with self.assertRaises(DomainError) as caught:
                second = Application(self.data_dir, provider=self.provider, settings=self.settings, test_mode=True)
            self.assertEqual((caught.exception.status, caught.exception.code), (409, "instance_already_running"))
            self.assertEqual(self.app.store.get_job(self.user["id"], job["id"])["status"], "running")
            self.assertEqual(self.app.store.get_user(self.user["id"])["reserved_credits"], 1)
        finally:
            if second is not None:
                second.close()
        self.provider.release.set()
        self.wait_status(job["id"], "succeeded")

    def test_closing_cancels_unstarted_job_and_releases_only_its_reservation(self):
        first, second = self.submit(), self.submit()
        self.assertTrue(self.provider.two_entered.wait(2))
        queued = self.submit()
        self.assertEqual(self.app.store.get_job(self.user["id"], queued["id"])["status"], "queued")
        errors = []
        def close_manager():
            try:
                self.app.jobs.close()
            except BaseException as error:
                errors.append(error)
        close_thread = threading.Thread(target=close_manager, daemon=True)
        close_thread.start()
        try:
            self.wait_status(queued["id"], "failed")
            self.assertEqual(self.provider.calls, 2)
            user = self.app.store.get_user(self.user["id"])
            self.assertEqual((user["credits"], user["reserved_credits"]), (10, 2))
        finally:
            self.provider.release.set()
            close_thread.join(5)
        self.assertFalse(close_thread.is_alive())
        self.assertEqual(errors, [])
        for job in (first, second):
            self.wait_status(job["id"], "succeeded")
        self.assertEqual(self.provider.calls, 2)
        user = self.app.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"]), (8, 0))

    def test_prompt_snapshot_race_is_rejected_before_reservation(self):
        key = str(uuid.uuid4())
        original_reserve = self.app.store.reserve_generation
        def change_plan_before_reservation(user_id, plan_id, request_key, prompt, options, expected_plan_hash=None):
            changed = {**self.plan["answers"], "theme": "刚刚修改的主题"}
            self.app.store.save_plan(user_id, plan_id, changed, 4, False)
            return original_reserve(user_id, plan_id, request_key, prompt, options, expected_plan_hash)
        # 保留真实预占行为，只在整理提示词和进入事务之间插入一次真实改稿。
        with patch.object(self.app.store, "reserve_generation", side_effect=change_plan_before_reservation):
            with self.assertRaises(DomainError) as caught:
                self.submit(key)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "plan_changed"))
        user = self.app.store.get_user(self.user["id"])
        self.assertEqual((user["credits"], user["reserved_credits"], user["available_credits"]), (10, 0, 10))
        self.assertIsNone(self.app.store.get_job_by_request(self.user["id"], key))
        self.assertEqual(self.provider.calls, 0)


if __name__ == "__main__":
    unittest.main()
