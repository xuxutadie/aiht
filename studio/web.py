"""同源网页与JSON接口；私有文件从不通过静态目录提供。"""

from collections import defaultdict, deque
from contextlib import contextmanager
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, unquote
import ipaddress
import json
import logging
import mimetypes
import os
import re
import socket
import threading
import time

from .contracts import COOKIE_NAME, DomainError, PROJECT_ROOT, SESSION_SECONDS, data_identity
from .jobs import JobManager
from .instance import InstanceLock
from .plans import DEFAULT_ANSWERS, build_prompt, build_preview, sanitize_answers
from .provider import Provider
from .secrets import SecretSettings
from .store import Store

LOGGER = logging.getLogger("creation.web")
FILE_CHUNK_BYTES = 64 * 1024
REJECTED_BODY_DRAIN_BYTES = 128 * 1024
REJECTED_BODY_DRAIN_SECONDS = 0.1


class RateLimiter:
    def __init__(self):
        self.lock = threading.Lock()
        self.events = defaultdict(deque)

    def check(self, key, limit=60, period=60):
        with self.lock:
            timestamp = time.monotonic()
            queue = self.events[key]
            while queue and queue[0] <= timestamp - period:
                queue.popleft()
            if len(queue) >= limit:
                raise DomainError(429, "rate_limited", "操作较频繁，请稍后再试。")
            queue.append(timestamp)
            if len(self.events) > 5000:
                self.events = defaultdict(deque, {k: v for k, v in self.events.items() if v and v[-1] > timestamp - 600})


class Application:
    def __init__(self, data_dir, *, public_url="", provider=None, settings=None, test_mode=False):
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.instance_lock = InstanceLock(self.data_dir)
        self.instance_lock.acquire()
        self.instance_id = data_identity(self.data_dir)
        try:
            self.data_dir.chmod(0o700)
        except OSError:
            pass
        try:
            self.store = Store(self.data_dir / "creation.sqlite3")
            self.settings = settings or SecretSettings(self.data_dir)
            self.provider = provider or Provider(self.settings)
            self.jobs = JobManager(self.store, self.provider, self.settings, self.data_dir)
        except Exception:
            self.instance_lock.release()
            raise
        self.activated = False
        self.public_url = public_url.rstrip("/")
        self.test_mode = test_mode
        self.limiter = RateLimiter()
        # 两核服务器只同时运行两次 scrypt，排队不额外分配密码计算内存。
        self.auth_slots = threading.BoundedSemaphore(2)
        self.auth_wait_seconds = 10

    @contextmanager
    def password_work(self):
        if not self.auth_slots.acquire(timeout=self.auth_wait_seconds):
            raise DomainError(503, "authentication_busy", "登录或注册人数较多，请稍后重试。")
        try:
            yield
        finally:
            self.auth_slots.release()

    def close(self):
        try:
            self.jobs.close()
        finally:
            self.instance_lock.release()

    def activate(self):
        if not self.activated:
            self.store.mark_interrupted_jobs_uncertain()
            self.activated = True


class StudioServer(ThreadingHTTPServer):
    # 关闭监听后先等已接收请求结束，再由入口关闭任务和释放数据库实例锁。
    daemon_threads = False
    block_on_close = True
    request_queue_size = 128

    def __init__(self, address, app, *, max_connections=128, request_timeout=20):
        if not isinstance(max_connections, int) or max_connections < 1 or request_timeout <= 0:
            raise ValueError("连接数量和请求超时必须为正数。")
        self.app = app
        self.request_slots = threading.BoundedSemaphore(max_connections)
        self.request_timeout = request_timeout
        super().__init__(address, Handler)
        app.activate()

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(self.request_timeout)
        return sock, address

    def process_request(self, request, client_address):
        # 不能让连接数直接决定线程和内存数量；超载请求不再创建线程。
        if not self.request_slots.acquire(blocking=False):
            body = json.dumps({"error": {"code": "server_busy", "message": "当前访问人数较多，请稍后重试。"}},
                              ensure_ascii=False).encode("utf-8")
            response = ("HTTP/1.1 503 Service Unavailable\r\n"
                        "Content-Type: application/json; charset=utf-8\r\n"
                        f"Content-Length: {len(body)}\r\n"
                        "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                        "Retry-After: 2\r\nConnection: close\r\n\r\n").encode("ascii")
            try:
                request.settimeout(min(1, self.request_timeout))
                request.sendall(response + body)
                request.shutdown(socket.SHUT_WR)
                # 清掉已发送来的小请求，避免带未读数据直接 close 导致 TCP reset 吞掉 503。
                # 接收总量和等待时间均有限；超载连接不会占用新的请求线程。
                request.settimeout(min(0.1, self.request_timeout))
                remaining = 128 * 1024
                deadline = time.monotonic() + 0.1
                while remaining and time.monotonic() < deadline:
                    received = request.recv(min(FILE_CHUNK_BYTES, remaining))
                    if not received:
                        break
                    remaining -= len(received)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "CreationStudio"
    sys_version = ""

    @property
    def app(self):
        return self.server.app

    def log_message(self, format, *args):
        # 不记录完整URL、请求正文、手机号、密码和绘图密钥。
        return

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def do_OPTIONS(self):
        self._json(403, {"error": {"code": "cross_origin", "message": "不允许跨站调用。"}})

    def _handle(self):
        self.response_started = False
        self.request_body_consumed = False
        try:
            self._check_host()
            self.path_parts = [part for part in unquote(urlsplit(self.path).path).split("/") if part]
            if self.command in {"POST", "PUT"}:
                self._check_origin()
                self.body = self._read_json()
            else:
                self.body = {}
            if self.path_parts and self.path_parts[0] == "api":
                self._api(self.path_parts[1:])
            elif self.command == "GET":
                self._static()
            else:
                raise DomainError(405, "method_not_allowed", "不支持此操作。")
        except DomainError as error:
            self._json(error.status, {"error": {"code": error.code, "message": error.message}})
            if not self.request_body_consumed:
                self._drain_rejected_body()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except Exception:
            LOGGER.error("请求处理失败，未记录敏感请求内容")
            # 图片传输中断后只关闭连接，不能在图片正文中再追加一个 JSON 响应。
            if not self.response_started:
                self._json(500, {"error": {"code": "internal_error", "message": "服务暂时遇到问题，请稍后再试。"}})
            self.close_connection = True

    def _drain_rejected_body(self):
        if self.command not in {"POST", "PUT"}:
            return
        self.close_connection = True
        try:
            # 先完整送出错误响应，再收走少量未读正文，避免 Windows 关闭连接时用 RST 吞掉提示。
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_WR)
            remaining = REJECTED_BODY_DRAIN_BYTES
            deadline = time.monotonic() + REJECTED_BODY_DRAIN_SECONDS
            while remaining:
                seconds_left = deadline - time.monotonic()
                if seconds_left <= 0:
                    break
                self.connection.settimeout(seconds_left)
                chunk = self.rfile.read1(min(FILE_CHUNK_BYTES, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            # 超时或发送者已断开都直接结束；不等待无限正文，也不再追加错误响应。
            pass

    def _check_host(self):
        host = self.headers.get("Host", "")
        if not host or any(char in host for char in "\r\n/@\\"):
            raise DomainError(400, "invalid_host", "访问地址不正确。")
        local_hosts = {"127.0.0.1", "localhost", "::1"}
        try:
            parsed = urlsplit("http://" + host)
            hostname = parsed.hostname
            _ = parsed.port
        except ValueError:
            raise DomainError(400, "invalid_host", "访问地址不正确。") from None
        allowed = set(local_hosts)
        if self.app.public_url:
            allowed.add(urlsplit(self.app.public_url).hostname)
        if hostname not in allowed:
            raise DomainError(403, "invalid_host", "此访问地址尚未获准。")

    def _check_origin(self):
        origin = self.headers.get("Origin", "")
        expected = self.app.public_url or ("http://" + self.headers.get("Host", ""))
        if origin != expected or self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise DomainError(403, "cross_origin", "请从作品创作台页面内操作。")
        user = self._user(required=False)
        if user:
            self.app.limiter.check(("write-user", user["id"]), 180, 60)
            self.app.limiter.check(("shared-ip", self.client_address[0]), 3000, 60)
        else:
            self.app.limiter.check(("anonymous-write", self.client_address[0]), 180, 60)

    def _read_json(self):
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            raise DomainError(415, "json_required", "请求必须使用JSON格式。")
        if self.headers.get("Transfer-Encoding"):
            raise DomainError(400, "invalid_body", "请求格式不正确。")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise DomainError(400, "invalid_body", "请求长度不正确。") from None
        if not 0 <= length <= 65536:
            raise DomainError(413, "body_too_large", "提交内容过多，请适当精简。")
        try:
            payload = self.rfile.read(length)
            self.request_body_consumed = True
            value = json.loads(payload or b"{}")
        except (UnicodeDecodeError, ValueError):
            raise DomainError(400, "invalid_json", "提交内容格式不正确。") from None
        if not isinstance(value, dict):
            raise DomainError(400, "invalid_json", "提交内容格式不正确。")
        return value

    def _session_token(self):
        try:
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            return cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else ""
        except CookieError:
            return ""

    def _user(self, *, required=True, admin=False):
        user = self.app.store.get_user_by_session(self._session_token())
        if required and user is None:
            raise DomainError(401, "login_required", "请先注册或登录后使用。")
        if admin and (user is None or user["role"] != "admin"):
            raise DomainError(403, "admin_required", "此功能仅供老师管理员使用。")
        return user

    def _login(self, user):
        token = self.app.store.create_session(user["id"])
        self._json(200, {"user": user}, cookie=token)

    def _api(self, route):
        store, method = self.app.store, self.command
        if route == ["bootstrap"] and method == "GET":
            self._json(200, {"service": "creation-studio", "version": "1.0", "instance_id": self.app.instance_id,
                             "setup_required": not store.has_admin(), "user": self._user(required=False),
                             "generation_configured": self.app.settings.configured(), "test_mode": self.app.test_mode})
            return
        if route == ["setup"] and method == "POST":
            if self.app.public_url or self.headers.get("Host", "").split(":")[0] not in {"localhost", "127.0.0.1"}:
                raise DomainError(403, "local_setup_only", "请先在服务器本机初始化管理员。")
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                raise DomainError(403, "local_setup_only", "请在本机初始化管理员。")
            profile = {key: self.body.get(key, "") for key in ("name", "phone")}
            with self.app.password_work():
                user = store.create_user(profile, self.body.get("password", ""), role="admin")
            self._login(user)
            return
        if route == ["register"] and method == "POST":
            if not store.has_admin():
                raise DomainError(409, "setup_required", "请先由老师完成平台初始化。")
            self.app.limiter.check(("register", self.client_address[0]), 120, 600)
            profile = {key: self.body.get(key, "") for key in ("name", "phone", "region", "school", "grade")}
            with self.app.password_work():
                user = store.create_user(profile, self.body.get("password", ""), role="student",
                                         authorization_code=self.body.get("authorization_code"))
            self._login(user)
            return
        if route == ["login"] and method == "POST":
            phone = self.body.get("phone", "")
            self.app.limiter.check(("login", self.client_address[0]), 600, 600)
            if isinstance(phone, str):
                self.app.limiter.check(("phone", phone[:32]), 8, 600)
            with self.app.password_work():
                user = store.authenticate(phone, self.body.get("password", ""))
            if user is None:
                raise DomainError(401, "invalid_credentials", "手机号或密码不正确。")
            self._login(user)
            return
        if route == ["logout"] and method == "POST":
            store.delete_session(self._session_token())
            self._json(200, {"ok": True}, cookie="")
            return
        user = self._user()
        user_id = user["id"]
        if route == ["me"] and method == "GET":
            self._json(200, {"user": user})
        elif route == ["credits"] and method == "GET":
            self._json(200, {"user": user, "entries": store.ledger(user_id)})
        elif route == ["plans"] and method == "GET":
            self._json(200, {"plans": store.list_plans(user_id)})
        elif route == ["plans"] and method == "POST":
            answers = dict(DEFAULT_ANSWERS)
            answers.update(sanitize_answers(self.body.get("answers", {})))
            self._json(201, {"plan": store.create_plan(user_id, self.body.get("title", "我的新作品"), answers)})
        elif len(route) == 2 and route[0] == "plans" and method == "GET":
            self._json(200, {"plan": store.get_plan(user_id, route[1])})
        elif len(route) == 2 and route[0] == "plans" and method == "PUT":
            answers = sanitize_answers(self.body.get("answers", {}))
            confirmed = self.body.get("confirmed", False)
            if not isinstance(confirmed, bool):
                raise DomainError(400, "invalid_confirmation", "方案确认状态不正确。")
            if confirmed:
                build_prompt(answers)
            plan = store.save_plan(user_id, route[1], answers, self.body.get("step", 0), confirmed,
                                   title=self.body.get("title"))
            self._json(200, {"plan": plan})
        elif len(route) == 3 and route[0] == "plans" and route[2] == "preview" and method == "POST":
            plan = store.get_plan(user_id, route[1])
            self._json(200, build_preview(plan["answers"]))
        elif route == ["generate"] and method == "POST":
            self.app.limiter.check(("generate", user_id), 20, 60)
            job = self.app.jobs.submit(user_id, self.body.get("plan_id", ""), self.body.get("request_key", ""))
            self._json(202, {"job": job, "user": store.get_user(user_id)})
        elif len(route) == 2 and route[0] == "jobs" and method == "GET":
            self._json(200, {"job": store.get_job(user_id, route[1]), "user": store.get_user(user_id)})
        elif route == ["artworks"] and method == "GET":
            self._json(200, {"artworks": [self._public_artwork(a) for a in store.list_artworks(user_id)]})
        elif len(route) >= 2 and route[0] == "artworks":
            self._artwork(route, user)
        elif route and route[0] == "admin":
            self._admin(route[1:], self._user(admin=True))
        else:
            raise DomainError(404, "not_found", "没有找到此内容。")

    def _artwork(self, route, user):
        store = self.app.store
        if user["role"] == "admin":
            artwork = store.get_artwork_for_admin(user["id"], route[1])
        else:
            artwork = store.get_artwork(user["id"], route[1])
        if len(route) == 2 and self.command == "GET":
            self._json(200, {"artwork": self._public_artwork(artwork)})
        elif len(route) == 2 and self.command == "PUT":
            # 修改作品说明仍限制作者本人，老师可以查看而不代改。
            result = store.update_artwork(user["id"], route[1], self.body.get("reflection", ""), self.body.get("description", ""))
            self._json(200, {"artwork": self._public_artwork(result)})
        elif len(route) == 3 and route[2] in {"image", "download"} and self.command == "GET":
            base = (self.app.data_dir / "artworks").resolve()
            path = (base / artwork["image_path"]).resolve()
            if path.parent != base or not path.is_file():
                raise DomainError(404, "image_missing", "图片文件暂不可用，请联系老师恢复。")
            self._file(path, artwork["mime"], download=("作品图片" + path.suffix) if route[2] == "download" else None)
        else:
            raise DomainError(404, "not_found", "没有找到此内容。")

    def _public_artwork(self, artwork):
        result = dict(artwork)
        result["image_path"] = f"/api/artworks/{artwork['id']}/image"
        return result

    def _admin(self, route, user):
        if route == ["authorization-codes"] and self.command == "GET":
            try:
                query = parse_qs(urlsplit(self.path).query, keep_blank_values=True, max_num_fields=20)
                values = {}
                for key, default in (("limit", "50"), ("before", None)):
                    candidates = query.get(key, [default])
                    value = candidates[0]
                    if len(candidates) != 1 or value is not None and not re.fullmatch(r"[1-9][0-9]{0,15}", value):
                        raise ValueError
                    values[key] = int(value) if value is not None else None
            except ValueError:
                raise DomainError(400, "invalid_pagination", "分页数量或游标格式不正确。") from None
            self._json(200, self.app.store.list_authorization_codes(user["id"], **values))
        elif route == ["authorization-codes"] and self.command == "POST":
            self._json(201, {"codes": self.app.store.create_authorization_codes(user["id"], self.body.get("count", 1))})
        elif route == ["settings"] and self.command == "GET":
            self._json(200, self.app.settings.public())
        elif route == ["settings"] and self.command == "PUT":
            self._json(200, self.app.settings.update(self.body))
        elif route == ["overview"] and self.command == "GET":
            users = self.app.store.list_users()
            uncertain = self.app.store.list_uncertain_jobs()
            self._json(200, {"users": users, "uncertain_jobs": uncertain,
                             "stats": {"users": len(users), "uncertain_jobs": len(uncertain),
                                       "remaining_credits": sum(u["credits"] for u in users)}})
        elif len(route) == 3 and route[0] == "jobs" and route[2] == "resolve" and self.command == "POST":
            consume = self.body.get("consume")
            if not isinstance(consume, bool):
                raise DomainError(400, "invalid_decision", "请选择实际核对结果。")
            self.app.store.resolve_uncertain_job(route[1], consume, user["id"], self.body.get("reason", ""))
            self._json(200, {"ok": True})
        else:
            raise DomainError(404, "not_found", "没有找到此管理功能。")

    def _static(self):
        relative = "/".join(self.path_parts) or "index.html"
        base = (PROJECT_ROOT / "public").resolve()
        path = (base / relative).resolve()
        if not path.is_relative_to(base) or not path.is_file() or any(part.startswith(".") for part in Path(relative).parts):
            raise DomainError(404, "not_found", "页面不存在。")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix in {".js", ".css", ".html"}:
            mime += "; charset=utf-8"
        self._file(path, mime)

    def _headers(self, status, content_type, length, *, cookie=None, download=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        if status == 503:
            self.send_header("Retry-After", "2")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if self.app.public_url.startswith("https://"):
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        if cookie is not None:
            maximum = SESSION_SECONDS if cookie else 0
            value = f"{COOKIE_NAME}={cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age={maximum}"
            if self.app.public_url.startswith("https://"):
                value += "; Secure"
            self.send_header("Set-Cookie", value)
        if download:
            from urllib.parse import quote
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(download))
        self.response_started = True
        self.end_headers()

    def _json(self, status, payload, cookie=None):
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(encoded), cookie=cookie)
        self.wfile.write(encoded)

    def _bytes(self, status, payload, mime, download=None):
        self._headers(status, mime, len(payload), download=download)
        self.wfile.write(payload)

    def _file(self, path, mime, download=None):
        try:
            handle = path.open("rb")
        except FileNotFoundError:
            raise DomainError(404, "file_missing", "文件暂不可用，请联系老师恢复。") from None
        with handle:
            remaining = os.fstat(handle.fileno()).st_size
            self._headers(200, mime, remaining, download=download)
            # 每个下载连接最多持有一个小块，不随图片大小增加内存占用。
            while remaining:
                chunk = handle.read(min(FILE_CHUNK_BYTES, remaining))
                if not chunk:
                    raise OSError("文件在传输过程中变短")
                self.wfile.write(chunk)
                remaining -= len(chunk)
