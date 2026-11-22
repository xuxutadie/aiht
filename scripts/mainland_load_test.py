"""60 人本机模拟验收：临时库、假图片、真实密码哈希，绝不调用外部绘图。"""

import argparse
from collections import Counter, defaultdict
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.client import HTTPConnection
from http.cookies import SimpleCookie
import json
from pathlib import Path
import signal
import sqlite3
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zlib

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def fixture_png(size):
    """有效 PNG 加可忽略的注释块，模拟原图传输大小，不把随机文件冒充图片。"""
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    image = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
             + chunk(b"IDAT", zlib.compress((b"\0" + b"\x55\x88\xaa" * 32) * 32)))
    comment_length = max(1, size - len(image) - 12 - 12 - 5)
    return image + chunk(b"tEXt", b"test\0" + b"x" * comment_length) + chunk(b"IEND", b"")


class MockSettings:
    def get(self):
        return {"api_key": "synthetic-load-test-not-a-real-key", "model": "doubao-seedream-5-0-flash-260915",
                "base_url": "https://ark.cn-beijing.volces.com/api/v3", "watermark": True, "quality": "low"}

    def configured(self):
        return True

    def public(self):
        return {"configured": True, "model": self.get()["model"], "base_url": self.get()["base_url"],
                "watermark": True, "quality": "low", "key_hint": "独立模拟服务"}


class MockProvider:
    def __init__(self, image, delay):
        self.image, self.delay = image, delay
        self.calls = self.active = self.peak_active = 0
        self.lock = threading.Lock()

    def generate(self, prompt, options):
        from studio.provider import GeneratedImage
        with self.lock:
            self.calls += 1
            self.active += 1
            self.peak_active = max(self.peak_active, self.active)
        try:
            time.sleep(self.delay)
            return GeneratedImage(self.image, "image/png", 32, 32, {}, "mock-no-paid-api")
        finally:
            with self.lock:
                self.active -= 1


def serve_mock(args):
    from studio.web import Application, StudioServer
    data_dir = args.serve_mock
    # 即使误用内部子进程入口，也拒绝打开既有目录，不能激活或污染生产数据。
    data_dir.mkdir(parents=False, exist_ok=False, mode=0o700)
    image = fixture_png(int(args.image_mib * 1024 * 1024))
    provider = MockProvider(image, args.provider_delay)
    app = Application(data_dir, settings=MockSettings(), provider=provider, test_mode=True)
    app.store.create_user({"name": "模拟管理员", "phone": "19900000000"}, "SyntheticTeacher2026!", role="admin")
    server = StudioServer(("127.0.0.1", 0), app)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    print(json.dumps({"port": server.server_address[1], "pid": __import__("os").getpid(),
                      "image_bytes": len(image), "image_sha256": hashlib.sha256(image).hexdigest()}), flush=True)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        while not stop.wait(0.1) and not (data_dir / ".stop-test").exists():
            pass
    finally:
        server.shutdown()
        server.server_close()
        thread.join(10)
        app.close()
    print(json.dumps({"provider_calls": provider.calls, "provider_peak_active": provider.peak_active,
                      "real_paid_calls": 0}), flush=True)


def answers(index):
    return {"task_understanding": "用画面表达互相帮助", "theme": "未来的敬老院",
            "reason": "希望老人生活更方便", "message": "人与机器和谐相处", "message_detail": "机器人帮助老人到花园散步",
            "subject": "坐轮椅的老人和机器人", "scene": "明亮的敬老院花园", "action": "机器人为老人推轮椅",
            "details": "远处的机器人也在照顾老人", "ratio": "16:9", "style": "动漫",
            "style_reason": "亲切的色彩方便表达温暖", "innovation_type": "新的故事",
            "innovation": "把机器助老的未来画出来", "innovation_visible": "机器人的帮助动作",
            "subject_framing": "全身", "scene_distance": "中景",
            "custom_prompt": f"模拟作品{index}：动漫风格的未来敬老院，机器人为老人推轮椅，温暖阳光，16:9。"}


class LoadClient:
    def __init__(self, port, timeout, metrics):
        self.port, self.timeout, self.metrics = port, timeout, metrics
        self.cookie = ""

    def request(self, phase, method, path, payload=None, expected=200):
        for attempt in range(1, 4):
            headers = {"Cookie": self.cookie} if self.cookie else {}
            body = None
            if method in {"POST", "PUT"}:
                headers.update({"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json"})
                body = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
            start, status, code = time.monotonic(), 0, ""
            connection = HTTPConnection("127.0.0.1", self.port, timeout=self.timeout)
            try:
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                content = response.read()
                status = response.status
                if response.getheader("Set-Cookie"):
                    cookie = SimpleCookie(response.getheader("Set-Cookie"))
                    self.cookie = "; ".join(f"{k}={m.value}" for k, m in cookie.items() if m.value)
                value = json.loads(content) if response.getheader("Content-Type", "").startswith("application/json") else content
                if isinstance(value, dict):
                    code = value.get("error", {}).get("code", "")
            except (OSError, ValueError) as error:
                value, code = None, type(error).__name__
            finally:
                connection.close()
            self.metrics.append({"phase": phase, "attempt": attempt, "http": status, "expected": expected,
                                 "ms": round((time.monotonic() - start) * 1000, 2), "error": code})
            if status == expected:
                return value
            # 只重试服务器明确拒绝处理的繁忙响应。网络异常或 500 不能当成未执行，禁止自动重发写入。
            if status in {429, 503} and attempt < 3:
                time.sleep(attempt * 0.4)
                continue
            raise RuntimeError(f"{phase}: HTTP {status}, {code}")


def parallel(items, operation, clients):
    with ThreadPoolExecutor(max_workers=clients) as pool:
        futures = [pool.submit(operation, item) for item in items]
        results, failures = [], []
        for future in futures:
            try:
                results.append(future.result())
            except Exception as error:
                failures.append(str(error))
    if failures:
        raise RuntimeError("; ".join(failures[:8]) + f" (失败数 {len(failures)})")
    return results


def memory_sampler(pid, stop, samples):
    # Linux 读取单独服务进程的 RSS，包含其 HTTP/绘图线程，不把压测客户端算到服务端。
    path = Path(f"/proc/{pid}/status")
    while not stop.wait(0.05):
        try:
            values = {}
            for line in path.read_text().splitlines():
                if line.startswith(("VmRSS:", "VmHWM:", "VmSwap:", "Threads:")):
                    key, value = line.split(":", 1)
                    values[key] = int(value.split()[0])
            if values:
                samples.append(values)
        except (OSError, ValueError):
            return


def summarize(metrics):
    phases = defaultdict(list)
    for metric in metrics:
        phases[metric["phase"]].append(metric)
    result = {}
    for name, rows in phases.items():
        durations = sorted(r["ms"] for r in rows)
        result[name] = {"requests": len(rows), "first_attempt_errors": sum(r["attempt"] == 1 and r["http"] != r["expected"] for r in rows),
                        "retry_requests": sum(r["attempt"] > 1 for r in rows),
                        "all_attempt_errors": sum(r["http"] != r["expected"] for r in rows),
                        "status_counts": dict(Counter(str(r["http"]) for r in rows)),
                        "mean_ms": round(statistics.mean(durations), 2),
                        "p95_ms": durations[max(0, (len(durations) * 95 + 99) // 100 - 1)], "max_ms": durations[-1]}
    return result


def run_workload(args, ready, metrics):
    count, port = args.clients, ready["port"]
    teacher = LoadClient(port, args.timeout, metrics)
    teacher.request("teacher_login", "POST", "/api/login", {
        "phone": "19900000000", "password": "SyntheticTeacher2026!"})
    codes = []
    # 走真实管理员发码接口，不为负载测试绕过新注册校验。
    while len(codes) < count:
        batch = teacher.request("authorization_codes", "POST", "/api/admin/authorization-codes", {
            "count": min(100, count - len(codes))})
        codes.extend(item["code"] for item in batch["codes"])
    students = [{"index": i, "client": LoadClient(port, args.timeout, metrics)} for i in range(count)]
    def register(student):
        i, client = student["index"], student["client"]
        client.request("bootstrap", "GET", "/api/bootstrap")
        value = client.request("register", "POST", "/api/register", {
            "name": f"模拟学生{i + 1}", "phone": f"199{(i + 1):08d}", "password": "SyntheticStudent2026!",
            "region": "模拟测试地区", "school": "模拟测试学校", "grade": "七年级",
            "authorization_code": codes[i]})
        student["user_id"] = value["user"]["id"]
        return student
    students = parallel(students, register, count)
    def login(student):
        client = student["client"] = LoadClient(port, args.timeout, metrics)
        value = client.request("login", "POST", "/api/login", {
            "phone": f"199{(student['index'] + 1):08d}", "password": "SyntheticStudent2026!"})
        if value["user"]["credits"] != 10:
            raise RuntimeError("登录后初始余额不正确")
    parallel(students, login, count)
    def create_plan(student):
        client = student["client"]
        content = answers(student["index"])
        plan = client.request("create_plan", "POST", "/api/plans", {"title": "人机共生模拟作品", "answers": content}, 201)["plan"]
        plan = client.request("save_confirm", "PUT", "/api/plans/" + plan["id"],
                              {"title": plan["title"], "answers": content, "step": 5, "confirmed": True})["plan"]
        saved = client.request("reload_plan", "GET", "/api/plans/" + plan["id"])["plan"]
        if saved["answers"]["custom_prompt"] != content["custom_prompt"] or not saved["confirmed"]:
            raise RuntimeError("手改提示词或确认状态没有保存")
        student["plan"] = plan
    parallel(students, create_plan, count)
    def generate(student):
        student["key"] = uuid.uuid4().hex
        value = student["client"].request("generate", "POST", "/api/generate",
                                          {"plan_id": student["plan"]["id"], "request_key": student["key"]}, 202)
        student["job_id"] = value["job"]["id"]
    parallel(students, generate, count)
    def poll(student):
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            value = student["client"].request("poll", "GET", "/api/jobs/" + student["job_id"])
            if value["job"]["status"] not in {"queued", "running"}:
                if value["job"]["status"] != "succeeded" or value["user"]["credits"] != 9 or value["user"]["reserved_credits"] != 0:
                    raise RuntimeError("任务终态或扣点不正确")
                student["artwork_id"] = value["job"]["artwork_id"]
                return
            time.sleep(args.poll_interval)
        raise RuntimeError("任务轮询超时")
    parallel(students, poll, count)
    def list_artworks(student):
        value = student["client"].request("list_artworks", "GET", "/api/artworks")
        if len(value["artworks"]) != 1:
            raise RuntimeError("作品数量不正确")
    parallel(students, list_artworks, count)
    download_start = threading.Barrier(count, timeout=min(args.timeout, 30))
    def download(student):
        download_start.wait()
        content = student["client"].request("download", "GET", "/api/artworks/" + student["artwork_id"] + "/download")
        if len(content) != ready["image_bytes"] or hashlib.sha256(content).hexdigest() != ready["image_sha256"]:
            raise RuntimeError("下载文件大小或哈希不一致")
    parallel(students, download, count)
    def repeat_request(student):
        value = student["client"].request("idempotency", "POST", "/api/generate",
                                          {"plan_id": student["plan"]["id"], "request_key": student["key"]}, 202)
        if value["job"]["id"] != student["job_id"]:
            raise RuntimeError("同一请求生成了新任务")
    parallel(students, repeat_request, count)
    if count > 1:
        students[1]["client"].request("isolation", "GET", "/api/artworks/" + students[0]["artwork_id"] + "/image", expected=404)


def run_test(args):
    metrics, samples, failure, service_stats, audit = [], [], "", {}, {}
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="aiht-mainland-load-") as temporary:
        data_dir = Path(temporary) / "test-data"
        command = [sys.executable, "-u", str(Path(__file__).resolve()), "--serve-mock", str(data_dir),
                   "--image-mib", str(args.image_mib), "--provider-delay", str(args.provider_delay)]
        process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding="utf-8")
        line, errors = [], []
        def read_ready():
            try:
                line.append(process.stdout.readline())
            except Exception as error:
                errors.append(type(error).__name__)
        reader = threading.Thread(target=read_ready, daemon=True)
        reader.start()
        reader.join(20)
        if reader.is_alive() or not line or not line[0]:
            process.terminate()
            process.wait(10)
            raise RuntimeError("本机模拟服务未能在20秒内启动：" + ",".join(errors))
        ready = json.loads(line[0])
        stop_sample = threading.Event()
        sampler = threading.Thread(target=memory_sampler, args=(ready["pid"], stop_sample, samples), daemon=True)
        sampler.start()
        try:
            run_workload(args, ready, metrics)
        except Exception as error:
            failure = str(error)
        finally:
            (data_dir / ".stop-test").touch()
            try:
                tail, stderr = process.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                tail, stderr = process.communicate()
                failure = failure or "模拟服务未能优雅停止"
            stop_sample.set()
            sampler.join(2)
            for value in tail.splitlines():
                try:
                    service_stats.update(json.loads(value))
                except ValueError:
                    pass
            if process.returncode:
                failure = failure or f"模拟服务退出码 {process.returncode}"
            # 不抄录日志中的请求内容，只统计 SQLite 锁错误与内部错误提示。
            service_stats["sqlite_locked_log_count"] = stderr.lower().count("database is locked")
            service_stats["internal_error_log_count"] = stderr.count("请求处理失败")
        with closing(sqlite3.connect(data_dir / "creation.sqlite3")) as connection:
            audit = {"students": connection.execute("SELECT count(*) FROM users WHERE role='student'").fetchone()[0],
                     "correct_final_balances": connection.execute("SELECT count(*) FROM users WHERE role='student' AND credits=9 AND reserved_credits=0").fetchone()[0],
                     "jobs": connection.execute("SELECT count(*) FROM jobs").fetchone()[0],
                     "succeeded_jobs": connection.execute("SELECT count(*) FROM jobs WHERE status='succeeded'").fetchone()[0],
                     "artworks": connection.execute("SELECT count(*) FROM artworks").fetchone()[0],
                     "ledger_balance_mismatches": connection.execute("SELECT count(*) FROM users u WHERE role='student' AND credits != (SELECT coalesce(sum(delta),0) FROM ledger WHERE user_id=u.id)").fetchone()[0],
                     "grant_entries": connection.execute("SELECT count(*) FROM ledger l JOIN users u ON u.id=l.user_id WHERE u.role='student' AND l.kind='grant'").fetchone()[0],
                     "consume_entries": connection.execute("SELECT count(*) FROM ledger l JOIN users u ON u.id=l.user_id WHERE u.role='student' AND l.kind='consume'").fetchone()[0],
                     "foreign_key_errors": len(connection.execute("PRAGMA foreign_key_check").fetchall()),
                     "integrity_check": connection.execute("PRAGMA integrity_check").fetchone()[0]}
    phases = summarize(metrics)
    first_errors = sum(p["first_attempt_errors"] for p in phases.values())
    reconciled = (all(audit.get(k) == args.clients for k in ("students", "correct_final_balances", "jobs", "succeeded_jobs", "artworks", "grant_entries", "consume_entries"))
                  and audit.get("foreign_key_errors") == 0 and audit.get("integrity_check") == "ok"
                  and audit.get("ledger_balance_mismatches") == 0
                  and service_stats.get("provider_calls") == args.clients and service_stats.get("provider_peak_active", 99) <= 2)
    return {"test": "mainland-local-synthetic-only-v1", "clients": args.clients, "real_paid_calls": 0,
            "image_bytes": ready["image_bytes"], "elapsed_seconds": round(time.monotonic() - started, 2),
            "functional_reconciliation_passed": not failure and reconciled,
            "first_attempt_all_passed": not failure and reconciled and first_errors == 0,
            "failure": failure, "phases": phases, "database_audit": audit, "service": service_stats,
            "sqlite_lock_wait_measured": False,
            "server_memory": {"source": "Linux /proc separate mock service process" if samples else "unavailable on this platform",
                              "peak_rss_kib": max((s.get("VmRSS", 0) for s in samples), default=None),
                              "peak_hwm_kib": max((s.get("VmHWM", 0) for s in samples), default=None),
                              "peak_swap_kib": max((s.get("VmSwap", 0) for s in samples), default=None),
                              "peak_threads": max((s.get("Threads", 0) for s in samples), default=None)},
            "limits": ["本机临时服务，不证明公网4Mbps或真实学生网络速度", "固定假图片，不验证付费模型速度与并发",
                       "出现繁忙重试时，最终对账通过也不表示首次请求全部通过"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clients", type=int, default=60)
    parser.add_argument("--image-mib", type=float, default=2)
    parser.add_argument("--provider-delay", type=float, default=0.05)
    parser.add_argument("--poll-interval", type=float, default=2.2)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--serve-mock", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.clients <= 120 or not 0.01 <= args.image_mib <= 20 or not 0 <= args.provider_delay <= 5 or not 0.01 <= args.poll_interval <= 10 or not 5 <= args.timeout <= 300:
        parser.error("客户端1—120、图片0.01—20MiB、模拟延迟0—5秒、轮询0.01—10秒、超时5—300秒")
    if args.serve_mock:
        serve_mock(args)
        return
    if args.output and args.output.exists():
        parser.error("报告已存在，请使用新文件名")
    result = run_test(args)
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as handle:
            handle.write(encoded + "\n")
    print(encoded)
    raise SystemExit(0 if result["first_attempt_all_passed"] else 1)


if __name__ == "__main__":
    main()
