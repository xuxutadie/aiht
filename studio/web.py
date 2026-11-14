"""同源网页与JSON接口；私有文件从不通过静态目录提供。"""

from collections import defaultdict, deque
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote
import ipaddress
import json
import logging
import mimetypes
import threading
import time

from .contracts import COOKIE_NAME, DomainError, PROJECT_ROOT, SESSION_SECONDS, data_identity
from .jobs import JobManager
from .instance import InstanceLock
from .plans import DEFAULT_ANSWERS, build_prompt, build_summary, missing_fields, sanitize_answers
from .provider import Provider
from .secrets import SecretSettings
from .store import Store

LOGGER = logging.getLogger("creation.web")


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
        self.auth_slots = threading.BoundedSemaphore(4)

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
    daemon_threads = True
    block_on_close = False
    request_queue_size = 32

    def __init__(self, address, app):
        self.app = app
        super().__init__(address, Handler)
        app.activate()

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(20)
        return sock, address


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
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except Exception:
            LOGGER.error("请求处理失败，未记录敏感请求内容")
            self._json(500, {"error": {"code": "internal_error", "message": "服务暂时遇到问题，请稍后再试。"}})

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
            value = json.loads(self.rfile.read(length) or b"{}")
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
            with self.app.auth_slots:
                user = store.create_user(profile, self.body.get("password", ""), role="admin")
            self._login(user)
            return
        if route == ["register"] and method == "POST":
            if not store.has_admin():
                raise DomainError(409, "setup_required", "请先由老师完成平台初始化。")
            self.app.limiter.check(("register", self.client_address[0]), 120, 600)
            profile = {key: self.body.get(key, "") for key in ("name", "phone", "region", "school", "grade")}
            with self.app.auth_slots:
                user = store.create_user(profile, self.body.get("password", ""), role="student")
            self._login(user)
            return
        if route == ["login"] and method == "POST":
            phone = self.body.get("phone", "")
            self.app.limiter.check(("login", self.client_address[0]), 600, 600)
            if isinstance(phone, str):
                self.app.limiter.check(("phone", phone[:32]), 8, 600)
            with self.app.auth_slots:
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
            missing = missing_fields(plan["answers"])
            self._json(200, {"prompt": "" if missing else build_prompt(plan["answers"]), "missing": missing,
                             "summary": build_summary(plan["answers"])})
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
            payload = path.read_bytes()
            self._bytes(200, payload, artwork["mime"], download=("作品图片" + path.suffix) if route[2] == "download" else None)
        else:
            raise DomainError(404, "not_found", "没有找到此内容。")

    def _public_artwork(self, artwork):
        result = dict(artwork)
        result["image_path"] = f"/api/artworks/{artwork['id']}/image"
        return result

    def _admin(self, route, user):
        if route == ["settings"] and self.command == "GET":
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
        self._bytes(200, path.read_bytes(), mime)

    def _headers(self, status, content_type, length, *, cookie=None, download=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
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
        self.end_headers()

    def _json(self, status, payload, cookie=None):
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(encoded), cookie=cookie)
        self.wfile.write(encoded)

    def _bytes(self, status, payload, mime, download=None):
        self._headers(status, mime, len(payload), download=download)
        self.wfile.write(payload)
