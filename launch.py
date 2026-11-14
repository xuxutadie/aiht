"""双击启动器使用的后台启动逻辑，避免用户每次手动打开终端。"""

from pathlib import Path
import json
import os
import socket
import subprocess
import sys
import time
from urllib import request, error
import webbrowser
from studio.contracts import data_identity

ROOT = Path(__file__).resolve().parent


def health(port):
    try:
        with request.urlopen(f"http://127.0.0.1:{port}/api/bootstrap", timeout=0.5) as response:
            value = json.loads(response.read(32768))
        return (isinstance(value, dict) and value.get("service") == "creation-studio"
                and value.get("test_mode") is False
                and value.get("instance_id") == data_identity(ROOT / "data"))
    except (OSError, ValueError, error.URLError):
        return False


def free_port(port):
    try:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def main():
    # 优先复用已启动的本机服务，不能靠重复启动来重新领取或重置数据。
    for port in range(8321, 8332):
        if health(port):
            webbrowser.open(f"http://127.0.0.1:{port}")
            return 0
    selected = next((port for port in range(8321, 8332) if free_port(port)), None)
    if selected is None:
        print("本机端口暂不可用，请稍后再试。")
        return 1
    data_dir = ROOT / "data"
    data_dir.mkdir(exist_ok=True)
    kwargs = {"cwd": str(ROOT)}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    with (data_dir / "运行日志.txt").open("ab") as output:
        process = subprocess.Popen([sys.executable, "-u", str(ROOT / "server.py"), "--port", str(selected)],
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=output, **kwargs)
    (data_dir / "server.pid").write_text(str(process.pid), encoding="utf-8")
    for _ in range(40):
        if health(selected):
            webbrowser.open(f"http://127.0.0.1:{selected}")
            return 0
        if process.poll() is not None:
            break
        time.sleep(0.25)
    print("服务未能正常启动，请查看 data/运行日志.txt；不要删除账户数据。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
