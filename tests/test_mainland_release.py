"""部署包边界检查：私有数据不能随源码包发布。"""

import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from scripts.build_mainland_release import EXTRA_FILES, PUBLIC_FILES, build_release
from scripts.mainland_load_test import summarize


class MainlandReleaseTests(unittest.TestCase):
    def fixture(self, root):
        names = list(EXTRA_FILES) + ["public/" + name for name in PUBLIC_FILES] + ["studio/__init__.py", "studio/web.py"]
        for name in names:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# synthetic source\n", encoding="utf-8")
        return set(names)

    def test_only_explicit_sources_and_verified_manifest_are_packaged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            expected = self.fixture(root)
            for name in (".env", "data/creation.sqlite3", "data/provider-settings.json", "public/unexpected-key.json", "node_modules/key.txt", "tests/private-fixture.py"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("synthetic-private-content", encoding="utf-8")
            first = build_release(root, Path(temporary) / "first.tar.gz")
            second = build_release(root, Path(temporary) / "second.tar.gz")
            self.assertEqual(first["sha256"], second["sha256"])
            with tarfile.open(first["archive"], "r:gz") as archive:
                self.assertEqual(set(archive.getnames()), expected | {"RELEASE-MANIFEST.json"})
                manifest = json.load(archive.extractfile("RELEASE-MANIFEST.json"))
                self.assertFalse(manifest["contains_user_data"])
                for entry in manifest["files"]:
                    payload = archive.extractfile(entry["path"]).read()
                    self.assertEqual(hashlib.sha256(payload).hexdigest(), entry["sha256"])
                    self.assertEqual(len(payload), entry["bytes"])
                    self.assertEqual(archive.getmember(entry["path"]).mode, 0o644)

    def test_missing_source_or_existing_output_does_not_destroy_a_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary) / "source", Path(temporary) / "existing.tar.gz"
            self.fixture(root)
            output.write_bytes(b"previous-release")
            with self.assertRaises(ValueError):
                build_release(root, output)
            self.assertEqual(output.read_bytes(), b"previous-release")
            (root / "server.py").unlink()
            fresh = Path(temporary) / "fresh.tar.gz"
            with self.assertRaises(ValueError):
                build_release(root, fresh)
            self.assertFalse(fresh.exists())

    def test_a_busy_first_response_is_not_hidden_by_a_successful_retry(self):
        report = summarize([
            {"phase": "login", "attempt": 1, "http": 503, "expected": 200, "ms": 10},
            {"phase": "login", "attempt": 2, "http": 200, "expected": 200, "ms": 20},
            {"phase": "isolation", "attempt": 1, "http": 404, "expected": 404, "ms": 1},
        ])
        self.assertEqual(report["login"]["first_attempt_errors"], 1)
        self.assertEqual(report["login"]["retry_requests"], 1)
        self.assertEqual(report["isolation"]["all_attempt_errors"], 0)


if __name__ == "__main__":
    unittest.main()
