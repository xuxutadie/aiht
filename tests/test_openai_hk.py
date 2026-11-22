"""OpenAI-HK绘图适配：仅使用临时配置、模拟响应和测试密钥。"""

import base64
from email.message import Message
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import zlib

from studio.contracts import DomainError
from studio import secrets
from studio.provider import Provider, ProviderError


KEY = "hk-test-key-only-0123456789"
ARK_KEY = "ark-test-key-only-0123456789"
HK_URL = "https://api.openai-hk.com/v1"


def png(extra=b""):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + (chunk(b"tEXt", extra) if extra else b"") + chunk(b"IDAT", zlib.compress(b"\0\x44\x88\xaa"))
            + chunk(b"IEND", b""))


class Response(io.BytesIO):
    def __init__(self, body, mime="application/json"):
        super().__init__(body)
        self.headers = Message()
        self.headers["Content-Type"] = mime
        self.headers["X-Request-Id"] = "hk-test-request"


class HKSettings:
    def __init__(self, **changes):
        self.values = {"api_key": KEY, "model": "gpt-image-2", "base_url": HK_URL,
                       "quality": "low", "watermark": True, **changes}

    def get(self):
        return dict(self.values)


class HKSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.settings = secrets.SecretSettings(self.folder)
        self.env = patch.dict(os.environ, {"SEEDREAM_API_KEY": ""})
        self.env.start()
        self.addCleanup(self.env.stop)

    def hk(self, **changes):
        return self.settings.update({"base_url": HK_URL, "model": "gpt-image-2", "api_key": KEY, **changes})

    def test_canonical_endpoint_model_and_quality_roundtrip(self):
        for base in ("https://api.openai-hk.com", "https://api.openai-hk.com/", HK_URL, HK_URL + "/"):
            result = self.hk(base_url=base, quality="medium")
            self.assertEqual(result["base_url"], HK_URL)
            self.assertEqual(result["provider"], "openai-hk")
            self.assertEqual(result["quality"], "medium")
            self.assertNotIn(KEY, json.dumps(result))
        restored = secrets.SecretSettings(self.folder).get()
        self.assertEqual(restored["api_key"], KEY)
        self.assertEqual(restored["quality"], "medium")

    def test_switching_service_requires_new_key_in_both_directions(self):
        self.settings.update({"api_key": ARK_KEY})
        before = self.settings.path.read_bytes()
        with self.assertRaises(DomainError):
            self.hk(api_key="")
        self.assertEqual(self.settings.path.read_bytes(), before)
        self.hk()
        self.settings.update({"api_key": "", "quality": "high"})
        self.assertEqual(self.settings.get()["api_key"], KEY)
        with self.assertRaises(DomainError):
            self.settings.update({"base_url": secrets.BASE_URL_DEFAULT,
                                  "model": "doubao-seedream-5-0-flash-260915", "api_key": ""})

    def test_environment_key_is_never_used_for_hk(self):
        self.settings.path.write_text(json.dumps({"base_url": HK_URL, "model": "gpt-image-2"}), encoding="utf-8")
        with patch.dict(os.environ, {"SEEDREAM_API_KEY": ARK_KEY}):
            self.assertFalse(self.settings.configured())
            self.assertEqual(self.settings.get()["api_key"], "")

    def test_unapproved_url_model_quality_and_provider_are_rejected(self):
        self.hk()
        changes = [{"base_url": item} for item in (
            "http://api.openai-hk.com/v1", "https://api.openai-hk.com.evil.test/v1",
            "https://api.openai-hk.com:8443/v1", "https://user:pass@api.openai-hk.com/v1",
            HK_URL + "?next=x", HK_URL + "#frag", HK_URL + "?", HK_URL + "#", HK_URL + "/images/generations",
        )]
        changes += [{"model": "gpt-4"}, {"model": "gpt-image-1"}, {"quality": "auto"},
                    {"quality": None}, {"provider": "ark"}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(DomainError):
                self.settings.update(change)

    def test_fingerprint_uses_canonical_config_and_changes_with_secrets(self):
        config = HKSettings().get()
        expected = hashlib.sha256(json.dumps([HK_URL, "gpt-image-2", True, "low", KEY],
                                            ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(secrets.config_fingerprint(config), expected)
        self.assertEqual(secrets.config_fingerprint({**config, "base_url": "https://api.openai-hk.com"}), expected)
        for change in ({"quality": "high"}, {"api_key": ARK_KEY}, {"watermark": False}):
            self.assertNotEqual(secrets.config_fingerprint({**config, **change}), expected)


class HKProviderTests(unittest.TestCase):
    def setUp(self):
        self.settings = HKSettings()
        self.provider = Provider(self.settings)

    def options(self, **changes):
        return {"ratio": "16:9", "config_fingerprint": secrets.config_fingerprint(self.settings.get()), **changes}

    def response(self, encoded=None):
        return Response(json.dumps({"data": [{"b64_json": encoded or base64.b64encode(png()).decode()}]}).encode())

    def test_single_image_request_is_hk_specific_for_each_supported_ratio(self):
        for ratio, size in {"1:1": "1024x1024", "4:3": "1024x768", "3:4": "768x1024",
                            "16:9": "1280x720", "9:16": "720x1280"}.items():
            with self.subTest(ratio=ratio), patch("studio.provider._open", return_value=self.response()) as opened:
                image = self.provider.generate("温暖的未来", self.options(ratio=ratio))
            req = opened.call_args.args[0]
            body = json.loads(req.data)
            self.assertEqual(req.full_url, HK_URL + "/images/generations")
            self.assertEqual(body, {"model": "gpt-image-2", "prompt": "温暖的未来", "n": 1,
                                    "size": size, "quality": "low", "response_format": "b64_json"})
            self.assertEqual(image.mime, "image/png")
            self.assertEqual(opened.call_count, 1)

    def test_data_uri_is_strict_and_mime_matches_actual_image(self):
        encoded = base64.b64encode(png()).decode()
        with patch("studio.provider._open", return_value=self.response("data:image/png;base64," + encoded)):
            self.assertEqual(self.provider.generate("主题", self.options()).mime, "image/png")
        for value in ("data:text/html;base64," + encoded, "data:image/jpeg;base64," + encoded,
                      "data:image/png;charset=utf-8;base64," + encoded, "data:image/png;base64," + encoded + "\n"):
            with self.subTest(value=value[:30]), patch("studio.provider._open", return_value=self.response(value)):
                with self.assertRaises(ProviderError) as caught:
                    self.provider.generate("主题", self.options())
                self.assertTrue(caught.exception.uncertain)

    def test_config_change_or_legacy_hk_job_is_rejected_without_request(self):
        previous = self.options()
        self.settings.values["quality"] = "high"
        for options in (previous, {"ratio": "1:1"}, self.options(config_fingerprint="invalid")):
            with self.subTest(options=options), patch("studio.provider._open") as opened:
                with self.assertRaises(ProviderError) as caught:
                    self.provider.generate("主题", options)
                self.assertFalse(caught.exception.uncertain)
                opened.assert_not_called()

    def test_download_only_approved_hk_host_without_credentials(self):
        payload = Response(json.dumps({"data": [{"url": "https://myfile.addmao.com/test.png?signature=fixture"}]}).encode())
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch("studio.provider.socket.getaddrinfo", return_value=public), patch("studio.provider._open", side_effect=[payload, Response(png(), "image/png")]) as opened:
            self.provider.generate("主题", self.options())
        self.assertIsNone(opened.call_args.args[0].get_header("Authorization"))
        self.assertEqual(opened.call_args.kwargs["pinned_ips"], ("8.8.8.8",))
        for host in ("myfile.addmao.com.evil.test", "evil.addmao.com", "api.openai-hk.com", "test.tos-cn-beijing.volces.com"):
            response = Response(json.dumps({"data": [{"url": "https://" + host + "/test.png"}]}).encode())
            with self.subTest(host=host), patch("studio.provider._open", return_value=response) as opened:
                with self.assertRaises(ProviderError):
                    self.provider.generate("主题", self.options())
                self.assertEqual(opened.call_count, 1)

    def test_hk_private_dns_and_download_redirect_are_not_followed(self):
        def payload():
            return Response(json.dumps({"data": [{"url": "https://myfile.addmao.com/test.png"}]}).encode())
        private = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch("studio.provider.socket.getaddrinfo", return_value=private), patch("studio.provider._open", return_value=payload()) as opened:
            with self.assertRaises(ProviderError) as caught:
                self.provider.generate("主题", self.options())
            self.assertTrue(caught.exception.uncertain)
            self.assertEqual(opened.call_count, 1)
        redirect = HTTPError("https://myfile.addmao.com/test.png", 302, "Found", Message(), io.BytesIO())
        self.addCleanup(redirect.close)
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch("studio.provider.socket.getaddrinfo", return_value=public), patch("studio.provider._open", side_effect=[payload(), redirect]) as opened:
            with self.assertRaises(ProviderError) as caught:
                self.provider.generate("主题", self.options())
            self.assertTrue(caught.exception.uncertain)
            self.assertEqual(opened.call_count, 2)
            self.assertIsNone(opened.call_args.args[0].get_header("Authorization"))

    def test_json_base64_overhead_does_not_reject_a_valid_large_image(self):
        # 16MiB图片的base64响应超过旧20MiB JSON上限，仍应在原图20MiB边界内接收。
        image = png(b"x" * (16 * 1024 * 1024))
        with patch("studio.provider._open", return_value=self.response(base64.b64encode(image).decode())):
            result = self.provider.generate("主题", self.options())
        self.assertEqual(result.data, image)


if __name__ == "__main__":
    unittest.main()
