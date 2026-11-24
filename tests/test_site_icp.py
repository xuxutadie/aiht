"""备案信息仅来自站点配置；以临时数据库验证，不受真实站点数据影响。"""

from contextlib import contextmanager
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from studio.contracts import DomainError
from studio.web import Application, StudioServer
from test_http import Client


class SiteIcpTests(unittest.TestCase):
    @contextmanager
    def site(self, **options):
        with tempfile.TemporaryDirectory() as directory:
            app = Application(Path(directory), **options)
            try:
                server = StudioServer(("127.0.0.1", 0), app)
                thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
                thread.start()
                try:
                    yield Client(server.server_address[1])
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(5)
            finally:
                app.close()

    def test_unconfigured_site_has_no_filing_footer_or_inherited_number(self):
        with self.site() as client:
            status, content, headers = client.request("GET", "/")
        self.assertEqual(status, 200)
        page = content.decode("utf-8")
        self.assertNotIn('class="site-footer"', page)
        self.assertNotIn("beian.miit.gov.cn", page)
        self.assertIn('src="/app.js"', page)
        self.assertEqual(headers["cache-control"], "no-store")

    def test_configured_tencent_cloud_site_renders_only_its_own_number(self):
        number = "京ICP备12345678号-1"
        with self.site(public_url="https://studio.example.com", icp_number=number) as client:
            for path in ("/", "/index.html"):
                status, content, headers = client.request("GET", path, headers={"Host": "studio.example.com"})
                self.assertEqual(status, 200)
                page = content.decode("utf-8")
                self.assertIn('class="site-footer"', page)
                self.assertIn('href="https://beian.miit.gov.cn/"', page)
                self.assertIn(f">{number}</a>", page)
                self.assertEqual(page.count("ICP备"), 1)
                self.assertEqual(headers["content-length"], str(len(content)))
                self.assertEqual(headers["cache-control"], "no-store")
                self.assertIn("script-src 'self'", headers["content-security-policy"])
                self.assertEqual(headers["strict-transport-security"], "max-age=31536000")
            self.assertEqual(client.request("GET", "/", headers={"Host": "other.example.com"})[0], 403)
            status, result, _ = client.request("POST", "/api/setup", {}, headers={"Host": "studio.example.com"},
                                               origin="https://studio.example.com")
            self.assertEqual(status, 403)
            self.assertEqual(result["error"]["code"], "local_setup_only")

    def test_custom_number_is_escaped_as_text_instead_of_html(self):
        number = '<script>"test" & \'text\'</script>'
        with self.site(icp_number=number) as client:
            status, content, _ = client.request("GET", "/")
        self.assertEqual(status, 200)
        page = content.decode("utf-8")
        self.assertNotIn(number, page)
        self.assertIn("&lt;script&gt;&quot;test&quot; &amp; &#x27;text&#x27;&lt;/script&gt;", page)

    def test_invalid_number_is_rejected_before_creating_data_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            for invalid in ("备案号\n另一行", "字" * 81, None):
                with self.subTest(invalid=invalid), self.assertRaises(DomainError):
                    target = Path(directory) / "new-data"
                    Application(target, icp_number=invalid)
                self.assertFalse(target.exists())

    def test_server_help_documents_filing_option(self):
        result = subprocess.run([sys.executable, "server.py", "--help"], cwd=Path(__file__).resolve().parent.parent,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"--icp-number", result.stdout)


if __name__ == "__main__":
    unittest.main()
