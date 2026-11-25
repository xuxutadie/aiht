"""上游调用全部用假响应：不触发真实出图或计费。"""

import base64
from email.message import Message
import io
import json
import socket
import ssl
import struct
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import zlib

from studio.provider import Provider, ProviderError, inspect_image, _NoRedirect, _PinnedHTTPSHandler


API_KEY = "test-key-for-unit-tests-0123456789"


def png(width=1, height=1):
    def chunk(kind, content):
        return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\x55\x88\xaa" * width) * height)) + chunk(b"IEND", b""))


class FakeResponse(io.BytesIO):
    def __init__(self, content, content_type="application/json", request_id="upstream-123"):
        super().__init__(content)
        self.status = 200
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self.headers["X-Request-Id"] = request_id


class FakeSettings:
    def get(self):
        return {"api_key": API_KEY, "model": "doubao-seedream-5-0-flash-260915",
                "base_url": "https://ark.cn-beijing.volces.com/api/v3", "watermark": True}


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.provider = Provider(FakeSettings())

    def response(self, image=None, **extra):
        payload = {"data": [{"b64_json": base64.b64encode(image or png()).decode()}],
                   "usage": {"generated_images": 1, "output_tokens": 10}, **extra}
        return FakeResponse(json.dumps(payload).encode())

    def test_single_image_b64_and_documented_flash_parameters(self):
        with patch("studio.provider._open", return_value=self.response()) as fake:
            image = self.provider.generate("未来校园", {"ratio": "16:9", "style": "水彩"})
        self.assertEqual((image.mime, image.width, image.height), ("image/png", 1, 1))
        self.assertEqual(image.usage["generated_images"], 1)
        self.assertEqual(image.upstream_request_id, "upstream-123")
        request = fake.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(request.full_url, "https://ark.cn-beijing.volces.com/api/v3/images/generations")
        self.assertEqual(body["model"], "doubao-seedream-5-0-flash-260915")
        self.assertEqual(body["size"], "2816x1584")
        self.assertEqual(body["response_format"], "b64_json")
        self.assertEqual(body["output_format"], "png")
        self.assertTrue(body["watermark"])
        self.assertFalse(body["layer_decomposition"])
        for unsupported in ("stream", "n", "sequential_image_generation", "tools"):
            self.assertNotIn(unsupported, body)

    def test_all_supported_ratios_have_valid_model_pixel_bounds(self):
        expected = {"1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368",
                    "16:9": "2816x1584", "9:16": "1584x2816"}
        for ratio, size in expected.items():
            with self.subTest(ratio=ratio), patch("studio.provider._open", return_value=self.response()) as fake:
                self.provider.generate("主题", {"ratio": ratio})
                self.assertEqual(json.loads(fake.call_args.args[0].data)["size"], size)
                width, height = map(int, size.split("x"))
                self.assertTrue(921600 <= width * height <= 4624220)

    def test_no_key_rejected_without_network(self):
        class EmptySettings(FakeSettings):
            def get(self):
                return {**super().get(), "api_key": ""}
        with patch("studio.provider._open") as fake, self.assertRaises(ProviderError) as caught:
            Provider(EmptySettings()).generate("主题", {})
        fake.assert_not_called()
        self.assertFalse(caught.exception.uncertain)
        self.assertIn("配置", str(caught.exception))

    def test_invalid_options_rejected_without_network(self):
        for options in ({"ratio": "url:https://127.0.0.1"}, {"ratio": []}, None):
            with self.subTest(options=options), patch("studio.provider._open") as fake, self.assertRaises(ProviderError):
                self.provider.generate("主题", options)
            fake.assert_not_called()

    def test_malformed_unicode_prompt_is_rejected_before_network(self):
        with patch("studio.provider._open") as fake, self.assertRaises(ProviderError) as caught:
            self.provider.generate("主题\ud800", {})
        self.assertFalse(caught.exception.uncertain)
        fake.assert_not_called()

    def test_wrong_model_and_base_address_rejected_before_request(self):
        for change in ({"model": "doubao-seedream-4-0"}, {"base_url": "https://127.0.0.1/api/v3"}):
            class ChangedSettings(FakeSettings):
                def get(self):
                    return {**super().get(), **change}
            with self.subTest(change=change), patch("studio.provider._open") as fake:
                with self.assertRaises(ProviderError) as caught:
                    Provider(ChangedSettings()).generate("主题", {})
                self.assertFalse(caught.exception.uncertain)
                fake.assert_not_called()

    def test_timeout_is_uncertain_and_no_automatic_retry(self):
        with patch("studio.provider._open", side_effect=socket.timeout(API_KEY)) as fake:
            with self.assertRaises(ProviderError) as caught:
                self.provider.generate("主题", {})
        self.assertTrue(caught.exception.uncertain)
        self.assertEqual(fake.call_count, 1)
        self.assertNotIn(API_KEY, str(caught.exception))

    def test_4xx_definite_failure_and_5xx_uncertain_with_safe_messages(self):
        for status in (400, 401, 403, 429, 500, 503):
            headers = Message()
            headers["X-Tt-Logid"] = "safe-request-456"
            error = HTTPError("https://ark.cn-beijing.volces.com/api/v3/images/generations",
                              status, API_KEY, headers, io.BytesIO(json.dumps({"error": {"message": API_KEY}}).encode()))
            with self.subTest(status=status), patch("studio.provider._open", side_effect=error):
                with self.assertRaises(ProviderError) as caught:
                    self.provider.generate("主题", {})
                self.assertEqual(caught.exception.uncertain, status >= 500)
                self.assertEqual(caught.exception.request_id, "safe-request-456")
                self.assertNotIn(API_KEY, str(caught.exception))

    def test_known_rejection_codes_are_mapped_to_safe_messages(self):
        # 同一固定错误码无论由 HTTP 错误还是顶层 error 返回，说明和结算性质都一致。
        cases = {
            "InputTextSensitiveContentDetected": "创作提示词未通过内容安全审核",
            "InputTextSensitiveContentDetected.PolicyViolation": "可能涉及版权限制",
            "OutputImageSensitiveContentDetected": "生成的图片未通过内容安全审核",
            "OutputImageSensitiveContentDetected.DeepFake": "可能涉及伪造内容风险",
            "OutputImageSensitiveContentDetected.PolicyViolation": "可能涉及版权限制",
            "InvalidParameter": "绘图请求参数不受支持或不正确",
            "InvalidParameter.UnsupportedParameter": "绘图请求参数不受支持或不正确",
            "MissingParameter": "绘图请求缺少必要参数",
        }
        prompt = "仅用于测试的学生隐私提示词"
        for code, description in cases.items():
            body = json.dumps({"error": {"code": code, "message": API_KEY + prompt,
                                         "param": prompt}}).encode()
            for is_http_error in (True, False):
                with self.subTest(code=code, http_error=is_http_error):
                    if is_http_error:
                        response = HTTPError("https://ark.cn-beijing.volces.com/api/v3/images/generations",
                                             400, prompt, Message(), io.BytesIO(body))
                        mocked_open = patch("studio.provider._open", side_effect=response)
                    else:
                        mocked_open = patch("studio.provider._open", return_value=FakeResponse(body))
                    with mocked_open as fake, self.assertRaises(ProviderError) as caught:
                        self.provider.generate(prompt, {})
                    self.assertFalse(caught.exception.uncertain)
                    self.assertIn(description, str(caught.exception))
                    self.assertNotIn(API_KEY, str(caught.exception))
                    self.assertNotIn(prompt, str(caught.exception))
                    self.assertNotIn(code, str(caught.exception))
                    self.assertEqual(fake.call_count, 1)

    def test_unknown_or_malformed_rejection_never_exposes_upstream_fields(self):
        prompt = "仅用于测试的学生隐私提示词"
        # 不能把名称相似的任意子码误判成已确认的安全审核错误。
        unknown_code = "InputTextSensitiveContentDetected." + API_KEY
        for body in (json.dumps({"error": {"code": unknown_code, "message": prompt}}).encode(),
                     json.dumps({"error": {"code": [API_KEY], "message": prompt}}).encode(),
                     b"<html>not json</html>", b"[" * 2000 + b"]" * 2000):
            with self.subTest(body_type=type(body).__name__, length=len(body)):
                response = HTTPError("https://ark.cn-beijing.volces.com/api/v3/images/generations",
                                     422, prompt, Message(), io.BytesIO(body))
                with patch("studio.provider._open", side_effect=response) as fake, self.assertRaises(ProviderError) as caught:
                    self.provider.generate(prompt, {})
                message = str(caught.exception)
                self.assertFalse(caught.exception.uncertain)
                self.assertIn("HTTP 422", message)
                self.assertNotIn("未通过内容安全审核", message)
                self.assertNotIn(API_KEY, message)
                self.assertNotIn(prompt, message)
                self.assertEqual(fake.call_count, 1)
        body = json.dumps({"error": {"code": unknown_code, "message": prompt}}).encode()
        with patch("studio.provider._open", return_value=FakeResponse(body)), self.assertRaises(ProviderError) as caught:
            self.provider.generate(prompt, {})
        self.assertFalse(caught.exception.uncertain)
        self.assertIn("HTTP 200", str(caught.exception))
        self.assertNotIn(API_KEY, str(caught.exception))
        self.assertNotIn(prompt, str(caught.exception))

    def test_status_specific_errors_and_uncertain_server_errors_take_precedence(self):
        # 不能因正文声称输入被拒而把 5xx 错误错误地改成确定失败并退还算力。
        body = json.dumps({"error": {"code": "InputTextSensitiveContentDetected", "message": API_KEY}}).encode()
        for status, description in ((401, "密钥无效"), (403, "权限不足"),
                                    (429, "当前繁忙或暂不可用"), (503, "待管理员核对")):
            with self.subTest(status=status):
                response = HTTPError("https://ark.cn-beijing.volces.com/api/v3/images/generations",
                                     status, API_KEY, Message(), io.BytesIO(body))
                with patch("studio.provider._open", side_effect=response) as fake, self.assertRaises(ProviderError) as caught:
                    self.provider.generate("主题", {})
                self.assertEqual(caught.exception.uncertain, status >= 500)
                self.assertIn(description, str(caught.exception))
                self.assertNotIn("内容安全审核", str(caught.exception))
                self.assertNotIn(API_KEY, str(caught.exception))
                self.assertEqual(fake.call_count, 1)

    def test_error_body_read_is_bounded_and_fault_tolerant(self):
        class ErrorBody(io.BytesIO):
            bytes_read = 0

            def read(self, amount=-1):
                self.assert_bounded_read(amount)
                data = super().read(amount)
                self.bytes_read += len(data)
                return data

            def assert_bounded_read(self, amount):
                if not 0 < amount <= 65536 or self.bytes_read + amount > 65537:
                    raise AssertionError("错误正文读取超过 64 KiB 上限")

        body = ErrorBody(json.dumps({"error": {"code": "InvalidParameter", "message": "x" * 100000}}).encode())
        response = HTTPError("https://ark.cn-beijing.volces.com/api/v3/images/generations",
                             400, "bad", Message(), body)
        with patch("studio.provider._open", side_effect=response), self.assertRaises(ProviderError) as caught:
            self.provider.generate("主题", {})
        self.assertFalse(caught.exception.uncertain)
        self.assertIn("HTTP 400", str(caught.exception))
        self.assertNotIn("参数不受支持", str(caught.exception))
        self.assertTrue(body.closed)

        class BrokenBody(io.BytesIO):
            def read(self, amount=-1):
                raise OSError(API_KEY)

        body = BrokenBody()
        response = HTTPError("https://ark.cn-beijing.volces.com/api/v3/images/generations",
                             400, "bad", Message(), body)
        with patch("studio.provider._open", side_effect=response), self.assertRaises(ProviderError) as caught:
            self.provider.generate("主题", {})
        self.assertFalse(caught.exception.uncertain)
        self.assertIn("HTTP 400", str(caught.exception))
        self.assertNotIn(API_KEY, str(caught.exception))
        self.assertTrue(body.closed)

    def test_invalid_or_error_payload_never_becomes_an_image(self):
        for content in (b'{"error":{"message":"secret"}}', b"not json", b'{"data":[]}',
                        b'{"data":[{"b64_json":"!!"}]}', b'{"data":[{"b64_json":"e30="}]}'):
            with self.subTest(content=content), patch("studio.provider._open", return_value=FakeResponse(content)):
                with self.assertRaises(ProviderError):
                    self.provider.generate("主题", {})

    def test_response_and_image_limits(self):
        with patch("studio.provider.MAX_RESPONSE_BYTES", 64), patch("studio.provider._open", return_value=self.response()):
            with self.assertRaises(ProviderError) as caught:
                self.provider.generate("主题", {})
        self.assertTrue(caught.exception.uncertain)
        with patch("studio.provider.MAX_IMAGE_BYTES", 20), patch("studio.provider._open", return_value=self.response()):
            with self.assertRaises(ProviderError):
                self.provider.generate("主题", {})

    def test_direct_binary_response_is_validated(self):
        with patch("studio.provider._open", return_value=FakeResponse(png(2, 3), "image/png")):
            image = self.provider.generate("主题", {})
        self.assertEqual((image.width, image.height), (2, 3))

    def test_safe_official_tos_url_is_downloaded_without_authorization(self):
        payload = FakeResponse(json.dumps({"data": [{"url": "https://test.tos-cn-beijing.volces.com/image.png?sig=example"}]}).encode())
        public_dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch("studio.provider.socket.getaddrinfo", return_value=public_dns), patch("studio.provider._open", side_effect=[payload, FakeResponse(png(), "image/png")]) as fake:
            image = self.provider.generate("主题", {})
        self.assertEqual(image.mime, "image/png")
        download_request = fake.call_args.args[0]
        self.assertIsNone(download_request.get_header("Authorization"))
        self.assertEqual(fake.call_args.kwargs["pinned_ips"], ("8.8.8.8",))

    def test_unsafe_urls_and_private_dns_never_downloaded(self):
        urls = ["http://test.tos-cn-beijing.volces.com/a", "https://127.0.0.1/a",
                "https://169.254.169.254/latest/meta-data", "https://evil.example/a",
                "https://test.tos-cn-beijing.volces.com.evil.example/a",
                "https://test.tos-cn-beijing.volces.com:8443/a", "https://user:pass@test.tos-cn-beijing.volces.com/a"]
        for url in urls:
            with self.subTest(url=url), patch("studio.provider._open", return_value=FakeResponse(json.dumps({"data": [{"url": url}]}).encode())) as fake:
                with self.assertRaises(ProviderError) as caught:
                    self.provider.generate("主题", {})
                self.assertTrue(caught.exception.uncertain)
                self.assertEqual(fake.call_count, 1)
        private_dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        payload = FakeResponse(json.dumps({"data": [{"url": "https://test.tos-cn-beijing.volces.com/a"}]}).encode())
        with patch("studio.provider.socket.getaddrinfo", return_value=private_dns), patch("studio.provider._open", return_value=payload) as fake:
            with self.assertRaises(ProviderError):
                self.provider.generate("主题", {})
            self.assertEqual(fake.call_count, 1)

    def test_download_redirect_is_not_followed_and_status_stays_uncertain(self):
        handler = _NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "Found", {}, "https://127.0.0.1/"))
        payload = FakeResponse(json.dumps({"data": [{"url": "https://test.tos-cn-beijing.volces.com/a"}]}).encode())
        public_dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        redirect = HTTPError("https://test.tos-cn-beijing.volces.com/a", 302, "Found", Message(), io.BytesIO())
        self.addCleanup(redirect.close)
        with patch("studio.provider.socket.getaddrinfo", return_value=public_dns), patch("studio.provider._open", side_effect=[payload, redirect]) as fake:
            with self.assertRaises(ProviderError) as caught:
                self.provider.generate("主题", {})
            self.assertTrue(caught.exception.uncertain)
            self.assertEqual(fake.call_count, 2)

    def test_pinned_https_uses_public_ip_and_preserves_original_tls_host(self):
        handler = _PinnedHTTPSHandler(("8.8.8.8",))
        with patch.object(handler, "do_open") as fake_open:
            handler.https_open(object())
        connection_factory = fake_open.call_args.args[0]
        connection = connection_factory("test.tos-cn-beijing.volces.com", context=ssl.create_default_context())
        self.assertEqual(connection.host, "test.tos-cn-beijing.volces.com")
        with patch("studio.provider.socket.create_connection") as connect:
            connection._create_connection((connection.host, 443), 3)
            self.assertEqual(connect.call_args.args[0], ("8.8.8.8", 443))


class ImageHeaderTests(unittest.TestCase):
    def test_png_and_corrupt_image(self):
        self.assertEqual(inspect_image(png(3, 2)), ("image/png", 3, 2))
        for content in (b"{}", png()[:25], png()[:-8], b"\x89PNG\r\n\x1a\n" + b"x" * 50):
            with self.subTest(content=content[:10]), self.assertRaises(ValueError):
                inspect_image(content)

    def test_jpeg_dimensions_and_webp_dimensions(self):
        # 小型结构样本仅测试头部解析，真实图片由上游负责编码。
        jpeg = b"\xff\xd8\xff\xc0" + struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", 30, 40) + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00" + b"\xff\xda\x00\x0c\x03\x01\x00\x02\x11\x03\x11\x00\x3f\x00\x01\xff\xd9"
        self.assertEqual(inspect_image(jpeg), ("image/jpeg", 40, 30))
        content = b"\x2f" + ((39) | (29 << 14)).to_bytes(4, "little") + b"\x00"
        chunk = b"VP8L" + struct.pack("<I", len(content)) + content
        webp = b"RIFF" + struct.pack("<I", 4 + len(chunk)) + b"WEBP" + chunk
        self.assertEqual(inspect_image(webp), ("image/webp", 40, 30))

    def test_webp_canvas_header_without_image_data_is_rejected(self):
        content = b"\x00\x00\x00\x00" + (39).to_bytes(3, "little") + (29).to_bytes(3, "little")
        chunk = b"VP8X" + struct.pack("<I", len(content)) + content
        webp = b"RIFF" + struct.pack("<I", 4 + len(chunk)) + b"WEBP" + chunk
        with self.assertRaises(ValueError):
            inspect_image(webp)


if __name__ == "__main__":
    unittest.main()
