"""本机资源边界测试：仅使用临时数据和假绘图接口。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.client import HTTPResponse
from pathlib import Path
import json
import os
import queue
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from studio.web import Application, Handler, StudioServer
from test_http import Client, FakeProvider, FakeSettings


class ServiceSignalTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "Windows 的 terminate 不发送可处理的 POSIX SIGTERM")
    def test_sigterm_exits_through_normal_shutdown(self):
        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.Popen([sys.executable, "server.py", "--port", "0", "--data-dir", directory],
                                       cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       encoding="utf-8", errors="replace")
            ready = queue.Queue()
            threading.Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
            try:
                self.assertTrue(ready.get(timeout=10))
                process.send_signal(signal.SIGTERM)
                _, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stderr)
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)


class HttpResourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = Application(Path(self.directory.name), provider=FakeProvider(),
                               settings=FakeSettings(), test_mode=True)
        self.server = None
        self.thread = None
        self.addCleanup(self.stop)

    def start(self, **options):
        self.server = StudioServer(("127.0.0.1", 0), self.app, **options)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def stop(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(5)
        self.app.close()
        self.directory.cleanup()

    @contextmanager
    def tracked_request_bodies(self):
        """只观察正文读取量，不额外消费数据，稳定暴露拒绝响应后的未读正文。"""
        finished = queue.Queue()
        original_setup, original_finish = Handler.setup, Handler.finish

        class TrackedInput:
            def __init__(self, stream):
                self.stream, self.body_bytes = stream, 0

            def __getattr__(self, name):
                return getattr(self.stream, name)

            def read(self, count=-1):
                value = self.stream.read(count)
                self.body_bytes += len(value)
                return value

            def read1(self, count=-1):
                value = self.stream.read1(count)
                self.body_bytes += len(value)
                return value

        def setup(handler):
            original_setup(handler)
            handler.rfile = TrackedInput(handler.rfile)

        def finish(handler):
            finished.put(handler.rfile.body_bytes)
            original_finish(handler)

        with patch.object(Handler, "setup", setup), patch.object(Handler, "finish", finish):
            yield finished

    def test_rejected_requests_send_the_error_and_drain_already_sent_body(self):
        self.start()
        for body, options, expected in ((b"x" * 65536, {"origin": "https://other.example"}, 403),
                                        (b"x" * 65537, {}, 413)):
            with self.subTest(status=expected), self.tracked_request_bodies() as finished:
                status, result, _ = Client(self.port).request("POST", "/api/setup", raw=body, **options)
                self.assertEqual(status, expected, result)
                self.assertEqual(finished.get(timeout=2), len(body))
        self.assertFalse(self.app.store.has_admin())

    def test_rejected_request_drain_is_bounded_even_when_sender_does_not_finish(self):
        self.start()
        with self.tracked_request_bodies() as finished, \
                socket.create_connection(("127.0.0.1", self.port), timeout=2) as connection:
            request = (f"POST /api/setup HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                       "Origin: https://other.example\r\nContent-Type: application/json\r\n"
                       "Content-Length: 65536\r\n\r\n").encode("ascii")
            started = time.monotonic()
            connection.sendall(request + b"{")
            response = HTTPResponse(connection)
            response.begin()
            self.assertEqual(response.status, 403)
            self.assertEqual(json.loads(response.read())["error"]["code"], "cross_origin")
            # 发送者继续保持连接且不补齐正文，收尾仍须在短时间内释放工作线程。
            self.assertEqual(finished.get(timeout=1), 1)
            self.assertLess(time.monotonic() - started, 1)

    def test_rejected_request_drain_never_reads_more_than_128_kib(self):
        self.start()
        with self.tracked_request_bodies() as finished, \
                socket.create_connection(("127.0.0.1", self.port), timeout=2) as connection:
            body = b"x" * (256 * 1024)
            request = (f"POST /api/setup HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                       "Origin: https://other.example\r\nContent-Type: application/json\r\n"
                       f"Content-Length: {len(body)}\r\n\r\n").encode("ascii")
            connection.sendall(request + body)
            self.assertEqual(finished.get(timeout=1), 128 * 1024)

    def test_private_image_download_does_not_read_the_whole_file_into_memory(self):
        self.start()
        path = Path(self.directory.name) / "artworks" / "test.png"
        content = b"resource-bound-test" * 100000
        path.write_bytes(content)
        artwork = {"id": "owned-image", "image_path": path.name, "mime": "image/png"}
        owner = {"id": "student", "role": "student"}
        original_read_bytes = Path.read_bytes

        def reject_whole_image_read(target):
            if target == path:
                raise AssertionError("私有图片不能整张读入内存")
            return original_read_bytes(target)

        with patch.object(Handler, "_user", return_value=owner), \
                patch.object(self.app.store, "get_artwork", return_value=artwork), \
                patch.object(Path, "read_bytes", reject_whole_image_read):
            status, received, headers = Client(self.port).request("GET", "/api/artworks/owned-image/download")
        self.assertEqual(status, 200)
        self.assertEqual(received, content)
        self.assertEqual(int(headers["content-length"]), len(content))
        self.assertIn("attachment", headers["content-disposition"])
        self.assertEqual(headers["cache-control"], "no-store")

    def test_busy_password_workers_return_retryable_error_and_reads_still_work(self):
        self.start()
        self.app.auth_wait_seconds = 0.03
        held = []
        while self.app.auth_slots.acquire(blocking=False):
            held.append(True)

        def release():
            while held:
                held.pop()
                self.app.auth_slots.release()

        timer = threading.Timer(0.3, release)
        timer.start()
        try:
            status, result, headers = Client(self.port).request("POST", "/api/login", {
                "phone": "13800138000", "password": "student123"})
            self.assertEqual(status, 503, result)
            self.assertEqual(result["error"]["code"], "authentication_busy")
            self.assertEqual(headers["retry-after"], "2")
            self.assertEqual(Client(self.port).request("GET", "/api/bootstrap")[0], 200)
        finally:
            timer.join(2)
            release()

    def test_password_work_is_limited_while_other_requests_remain_available(self):
        self.start()
        release = threading.Event()
        two_entered = threading.Event()
        lock = threading.Lock()
        active = peak = 0

        def authenticate(phone, password):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                if active == 2:
                    two_entered.set()
            try:
                release.wait(3)
                return None
            finally:
                with lock:
                    active -= 1

        with patch.object(self.app.store, "authenticate", side_effect=authenticate), \
                ThreadPoolExecutor(max_workers=8) as pool:
            calls = [pool.submit(Client(self.port).request, "POST", "/api/login", {
                "phone": f"1380013800{index}", "password": "student123"}) for index in range(8)]
            try:
                self.assertTrue(two_entered.wait(2))
                self.assertEqual(Client(self.port).request("GET", "/api/bootstrap")[0], 200)
            finally:
                release.set()
            self.assertTrue(all(call.result()[0] == 401 for call in calls))
        self.assertLessEqual(peak, 2)

    def test_connection_limit_rejects_excess_then_recovers(self):
        self.start(max_connections=2)
        release = threading.Event()
        entered = threading.Event()
        lock = threading.Lock()
        count = 0

        def has_admin():
            nonlocal count
            with lock:
                count += 1
                if count == 2:
                    entered.set()
            release.wait(3)
            return False

        with patch.object(self.app.store, "has_admin", side_effect=has_admin), \
                ThreadPoolExecutor(max_workers=2) as pool:
            waiting = [pool.submit(Client(self.port).request, "GET", "/api/bootstrap") for _ in range(2)]
            try:
                self.assertTrue(entered.wait(2))
                status, result, headers = Client(self.port).request("GET", "/api/bootstrap")
                self.assertEqual(status, 503, result)
                self.assertEqual(headers["retry-after"], "2")
            finally:
                release.set()
            self.assertTrue(all(call.result()[0] == 200 for call in waiting))
        self.assertEqual(Client(self.port).request("GET", "/api/bootstrap")[0], 200)

    def test_incomplete_connection_times_out_and_releases_capacity(self):
        self.start(max_connections=1, request_timeout=0.1)
        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as connection:
            connection.sendall(b"GET /api/bootstrap HTTP/1.1\r\nHost: localhost\r\n")
            self.assertEqual(connection.recv(1), b"")
        self.assertEqual(Client(self.port).request("GET", "/api/bootstrap")[0], 200)

    def test_server_close_waits_for_active_request_before_database_lock_release(self):
        self.start()
        release = threading.Event()
        entered = threading.Event()
        closed = threading.Event()

        def has_admin():
            entered.set()
            release.wait(3)
            return False

        def close_server():
            self.server.shutdown()
            self.server.server_close()
            closed.set()

        with patch.object(self.app.store, "has_admin", side_effect=has_admin), \
                ThreadPoolExecutor(max_workers=1) as pool:
            call = pool.submit(Client(self.port).request, "GET", "/api/bootstrap")
            closer = threading.Thread(target=close_server, daemon=True)
            try:
                self.assertTrue(entered.wait(2))
                closer.start()
                self.assertFalse(closed.wait(0.1))
            finally:
                release.set()
                closer.join(3)
            self.assertEqual(call.result()[0], 200)
            self.assertTrue(closed.is_set())


if __name__ == "__main__":
    unittest.main()
