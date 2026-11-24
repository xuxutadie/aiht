"""作品创作台本地启动入口，不需要额外安装依赖。"""

import argparse
import logging
import os
import signal
from pathlib import Path
import sys
import threading
import webbrowser

from studio.contracts import PROJECT_ROOT
from studio.contracts import DomainError
from studio.web import Application, StudioServer


def main():
    parser = argparse.ArgumentParser(description="启动作品创作台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8321)
    parser.add_argument("--data-dir", type=Path, default=PROJECT_ROOT / "data")
    parser.add_argument("--public-url", default="", help="正式HTTPS访问地址；配置反向代理后使用")
    parser.add_argument("--icp-number", default="", help="本网站真实的ICP备案号；留空不显示备案信息")
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    if args.public_url and not args.public_url.startswith("https://"):
        parser.error("正式访问地址必须使用HTTPS。")
    try:
        app = Application(args.data_dir, public_url=args.public_url, icp_number=args.icp_number)
    except DomainError as error:
        print(error.message, file=sys.stderr)
        return 1
    if (args.public_url or args.host not in {"127.0.0.1", "localhost"}) and not app.store.has_admin():
        app.close()
        parser.error("请先使用默认本机地址启动并完成管理员初始化，再设置公开访问。")
    try:
        server = StudioServer((args.host, args.port), app)
    except OSError:
        app.close()
        print(f"端口{args.port}暂不可用，请换用其他端口。", file=sys.stderr)
        return 1
    url = args.public_url or f"http://127.0.0.1:{args.port}"
    print(f"作品创作台已启动：{url}", flush=True)
    print("关闭此进程即可停止服务。", flush=True)
    if args.open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    def stop_service(signum, frame):
        # systemd 默认发送 SIGTERM；复用正常退出流程，等待在途任务完成结算。
        raise KeyboardInterrupt

    previous_sigterm = signal.signal(signal.SIGTERM, stop_service)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()
        signal.signal(signal.SIGTERM, previous_sigterm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
