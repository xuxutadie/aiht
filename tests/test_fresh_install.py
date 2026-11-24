"""从实际发布包验证空库安装，不使用现有账号、密钥或远程服务器。"""

from contextlib import contextmanager
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

from scripts.build_mainland_release import build_release
from test_http import Client


ROOT = Path(__file__).resolve().parent.parent
DOMAIN = "studio.example.com"
ORIGIN = f"https://{DOMAIN}"


class FreshInstallTests(unittest.TestCase):
    @contextmanager
    def running_package(self, source, data, *options):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, "server.py", "--host", "127.0.0.1", "--port", str(port),
             "--data-dir", str(data), *options], cwd=source,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            client = Client(port)
            headers = {"Host": DOMAIN} if "--public-url" in options else None
            for _ in range(100):
                if process.poll() is not None:
                    self.fail("新安装进程在启动阶段退出")
                try:
                    if client.request("GET", "/api/bootstrap", headers=headers)[0] == 200:
                        break
                except OSError:
                    pass
                time.sleep(0.05)
            else:
                self.fail("新安装进程未在限定时间内启动")
            yield client
        finally:
            # 临时服务从未配置绘图接口，也没有在途任务；退出后清理的只是临时目录。
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)

    def test_fresh_package_initialization_then_reverse_proxy_mode(self):
        with tempfile.TemporaryDirectory(prefix="aiht-fresh-") as temporary:
            root = Path(temporary)
            package, source, data = root / "release.tar.gz", root / "app", root / "private-data"
            build_release(ROOT, package)
            with tarfile.open(package, "r:gz") as archive:
                # 此处只解包本测试刚刚由白名单生成的归档，绝非外部上传文件。
                self.assertTrue(all(not Path(member.name).is_absolute() and ".." not in Path(member.name).parts
                                    and member.isfile() for member in archive.getmembers()))
                archive.extractall(source)
            self.assertFalse((source / "cloudflare").exists())
            self.assertFalse((source / "data").exists())
            # 公网模式不能让第一个陌生访问者取得管理员权限。
            result = subprocess.run([sys.executable, "server.py", "--data-dir", str(data),
                                     "--public-url", ORIGIN, "--port", "0"], cwd=source,
                                    capture_output=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)

            admin_profile = {"name": "合成管理员", "phone": "19900000001", "password": "Fresh-test-only-2026"}
            with self.running_package(source, data) as client:
                status, bootstrap, _ = client.request("GET", "/api/bootstrap")
                self.assertEqual(status, 200)
                self.assertTrue(bootstrap["setup_required"])
                self.assertFalse(bootstrap["generation_configured"])
                status, result, _ = client.request("POST", "/api/setup", admin_profile)
                self.assertEqual(status, 200)
                self.assertTrue(result["user"]["unlimited_credits"])

            with self.running_package(source, data, "--public-url", ORIGIN, "--icp-number", "示例备案号") as admin:
                headers = {"Host": DOMAIN}
                status, bootstrap, _ = admin.request("GET", "/api/bootstrap", headers=headers)
                self.assertEqual(status, 200)
                self.assertFalse(bootstrap["setup_required"])
                status, _, _ = admin.request("POST", "/api/setup", admin_profile, headers=headers, origin=ORIGIN)
                self.assertEqual(status, 403)
                status, result, response_headers = admin.request("POST", "/api/login", admin_profile, headers=headers, origin=ORIGIN)
                self.assertEqual(status, 200)
                self.assertTrue(result["user"]["unlimited_credits"])
                self.assertIn("Secure", response_headers["set-cookie"])
                status, result, _ = admin.request("POST", "/api/admin/authorization-codes", {"count": 1}, headers=headers, origin=ORIGIN)
                self.assertEqual(status, 201)
                code = result["codes"][0]["code"]
                student = Client(admin.port)
                profile = {"name": "合成学生", "phone": "19900000002", "password": "Fresh-test-only-2026",
                           "region": "测试地区", "school": "测试学校", "grade": "六年级", "authorization_code": code}
                status, result, _ = student.request("POST", "/api/register", profile, headers=headers, origin=ORIGIN)
                self.assertEqual(status, 200)
                self.assertEqual(result["user"]["credits"], 10)
                self.assertFalse(result["user"]["unlimited_credits"])
                status, html, _ = student.request("GET", "/", headers=headers)
                self.assertEqual(status, 200)
                self.assertIn("示例备案号".encode(), html)


if __name__ == "__main__":
    unittest.main()
