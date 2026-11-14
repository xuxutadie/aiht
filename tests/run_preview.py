"""独立浏览器验收环境。只用测试账号和固定测试图片，不调用真实绘图API。"""

import argparse
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studio.web import Application, StudioServer
from studio.provider import GeneratedImage, ProviderError
from test_plans import complete_answers
from test_provider import png as png_bytes


class PreviewSettings:
    def configured(self):
        return True

    def public(self):
        return {"configured": True, "model": "doubao-seedream-5-0-flash-260915",
                "base_url": "https://ark.cn-beijing.volces.com/api/v3", "watermark": True,
                "key_hint": "测试配置，不使用真实密钥"}

    def update(self, payload):
        return self.public()


class PreviewProvider:
    def __init__(self, data_dir):
        self.data_dir = data_dir

    def generate(self, prompt, options):
        time.sleep(0.5)
        mode_file = self.data_dir / "preview-mode.txt"
        mode = mode_file.read_text().strip() if mode_file.exists() else "success"
        if mode == "failed":
            raise ProviderError("测试接口明确失败，算力不扣除。", uncertain=False)
        if mode == "uncertain":
            raise ProviderError("测试接口状态未知，请老师核对。", uncertain=True)
        return GeneratedImage(png_bytes(32, 32), "image/png", 32, 32, {}, "qa-only")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8322)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    app = Application(args.data_dir, settings=PreviewSettings(), provider=PreviewProvider(args.data_dir), test_mode=True)
    password = "Preview2026!"
    if not app.store.has_admin():
        app.store.create_user({"name": "验收老师", "phone": "19900000001"}, password, role="admin")
    student = app.store.authenticate("19900000002", password)
    if not student:
        student = app.store.create_user({"name": "验收同学", "phone": "19900000002", "region": "测试地区",
                                         "school": "测试学校", "grade": "小学五年级"}, password)
    if not app.store.list_plans(student["id"]):
        plan = app.store.create_plan(student["id"], "给小鸟让路的城市", complete_answers())
        app.store.save_plan(student["id"], plan["id"], complete_answers(), 2)
    server = StudioServer(("127.0.0.1", args.port), app)
    print(f"独立测试环境：http://127.0.0.1:{args.port}（不是真实生图）", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()


if __name__ == "__main__":
    main()
