"""配置校验、脱敏和本机密钥保护。"""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from studio.contracts import DomainError
from studio.secrets import SecretSettings


API_KEY = "test-key-for-unit-tests-0123456789"


class SecretSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {"SEEDREAM_API_KEY": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.folder = Path(self.temp.name)
        self.settings = SecretSettings(self.folder)

    def test_unconfigured_defaults_do_not_expose_key(self):
        public = self.settings.public()
        self.assertFalse(public["configured"])
        self.assertEqual(public["model"], "doubao-seedream-5-0-flash-260915")
        self.assertEqual(public["base_url"], "https://ark.cn-beijing.volces.com/api/v3")
        self.assertTrue(public["watermark"])
        self.assertNotIn("api_key", public)

    def test_roundtrip_is_masked_and_blank_key_keeps_existing_key(self):
        public = self.settings.update({"api_key": API_KEY, "watermark": False})
        self.assertTrue(public["configured"])
        self.assertNotIn(API_KEY, json.dumps(public))
        self.assertTrue(public["key_hint"].endswith(API_KEY[-4:]))
        self.settings.update({"api_key": "", "watermark": True})
        restored = SecretSettings(self.folder)
        self.assertEqual(restored.get()["api_key"], API_KEY)
        self.assertTrue(restored.get()["watermark"])
        stored = b"".join(item.read_bytes() for item in self.folder.iterdir() if item.is_file())
        if os.name == "nt":
            self.assertNotIn(API_KEY.encode(), stored)
        else:
            for item in self.folder.iterdir():
                if item.is_file():
                    self.assertEqual(item.stat().st_mode & 0o777, 0o600)

    def test_environment_key_is_external_and_never_persisted_by_blank_update(self):
        with patch.dict(os.environ, {"SEEDREAM_API_KEY": API_KEY}):
            self.assertTrue(self.settings.configured())
            self.settings.update({"api_key": "", "watermark": False})
            self.assertEqual(self.settings.get()["api_key"], API_KEY)
        self.assertFalse(self.settings.configured())

    def test_forbids_other_models_and_ssrf_base_url(self):
        for model in ("gpt-4", "doubao-seedream-4-0", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-flash\r\nx"):
            with self.subTest(model=model), self.assertRaises(DomainError):
                self.settings.update({"model": model})
        for url in ("http://ark.cn-beijing.volces.com/api/v3", "https://127.0.0.1/api/v3", "https://ark.cn-beijing.volces.com.evil.example/api/v3", "https://ark.cn-beijing.volces.com/api/v3?next=x", "https://user:pass@ark.cn-beijing.volces.com/api/v3", "https://ark.cn-beijing.volces.com:8443/api/v3", "https://ark.cn-beijing.volces.com/anything"):
            with self.subTest(url=url), self.assertRaises(DomainError):
                self.settings.update({"base_url": url})

    def test_invalid_key_and_watermark_are_rejected_without_leaking_values(self):
        for key in ("short", "a" * 513, API_KEY + "\r\n", API_KEY + " x", 123):
            with self.subTest(key_type=type(key).__name__), self.assertRaises(DomainError) as caught:
                self.settings.update({"api_key": key})
            self.assertNotIn(API_KEY, str(caught.exception))
        for value in ("false", 1, None):
            with self.subTest(value=value), self.assertRaises(DomainError):
                self.settings.update({"watermark": value})

    def test_official_root_is_canonicalized(self):
        public = self.settings.update({"base_url": "https://ark.cn-beijing.volces.com/"})
        self.assertEqual(public["base_url"], "https://ark.cn-beijing.volces.com/api/v3")


if __name__ == "__main__":
    unittest.main()
