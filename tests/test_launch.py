"""启动器不能误开另一份数据或测试绘图环境。"""

import io
import json
import unittest
from unittest.mock import patch

import launch


class LaunchTests(unittest.TestCase):
    def health_with(self, value):
        with patch.object(launch.request, "urlopen", return_value=io.BytesIO(json.dumps(value).encode())):
            return launch.health(8321)

    def test_other_directory_is_not_reused(self):
        self.assertFalse(self.health_with({"service": "creation-studio", "instance_id": "another-folder", "test_mode": False}))

    def test_test_environment_is_never_reused(self):
        self.assertFalse(self.health_with({"service": "creation-studio", "instance_id": "another-folder", "test_mode": True}))

    def test_unrelated_json_does_not_crash_launcher(self):
        self.assertFalse(self.health_with(["not-this-service"]))

    def test_matching_real_service_can_be_reused(self):
        self.assertTrue(self.health_with({"service": "creation-studio", "test_mode": False,
                                         "instance_id": launch.data_identity(launch.ROOT / "data")}))

    def test_even_matching_folder_cannot_reuse_fake_provider(self):
        self.assertFalse(self.health_with({"service": "creation-studio", "test_mode": True,
                                          "instance_id": launch.data_identity(launch.ROOT / "data")}))


if __name__ == "__main__":
    unittest.main()
