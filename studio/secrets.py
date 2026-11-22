"""服务器端配置；Windows 密钥用当前用户 DPAPI 保护。

非 Windows 系统不模拟加密：配置采用仅属主可读写的 0600 文件。
这类系统应限制服务器数据目录权限，或通过 SEEDREAM_API_KEY 注入密钥。
"""

import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from urllib.parse import urlsplit

from .contracts import DomainError, MODEL_DEFAULT


BASE_URL_DEFAULT = "https://ark.cn-beijing.volces.com/api/v3"
HK_BASE_URL = "https://api.openai-hk.com/v1"
_MODEL_PATTERN = re.compile(r"doubao-seedream-5-0-flash(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?\Z")


def validate_base_url(value):
    """管理员只能选择已经适配的固定服务地址，不能凭配置访问任意主机。"""
    message = "接口地址仅支持火山方舟或 OpenAI-HK 的固定 HTTPS 地址。"
    if (not isinstance(value, str) or any(ord(char) <= 32 for char in value)
            or "?" in value or "#" in value or "\\" in value):
        raise DomainError(400, "invalid_settings", message)
    try:
        parsed = urlsplit(value)
        common = parsed.scheme == "https" and not parsed.query and not parsed.fragment
        if common and parsed.netloc == "ark.cn-beijing.volces.com" and parsed.path in ("", "/", "/api/v3", "/api/v3/"):
            return BASE_URL_DEFAULT
        if common and parsed.netloc == "api.openai-hk.com" and parsed.path in ("", "/", "/v1", "/v1/"):
            return HK_BASE_URL
    except ValueError:
        pass
    raise DomainError(400, "invalid_settings", message)


def provider_from_base(base_url):
    return "openai-hk" if validate_base_url(base_url) == HK_BASE_URL else "ark"


def validate_model(value, base_url=BASE_URL_DEFAULT):
    provider = provider_from_base(base_url)
    valid = isinstance(value, str) and len(value) <= 128
    valid = valid and (value == "gpt-image-2" if provider == "openai-hk" else bool(_MODEL_PATTERN.fullmatch(value)))
    if not valid:
        message = "OpenAI-HK 当前仅支持 gpt-image-2 图片模型。" if provider == "openai-hk" else "火山方舟当前仅支持 Seedream 5.0 Flash 图片模型。"
        raise DomainError(400, "invalid_settings", message)
    return value


def validate_quality(value):
    if value not in ("low", "medium", "high"):
        raise DomainError(400, "invalid_settings", "绘图质量仅支持 low、medium 或 high。")
    return value


def config_fingerprint(config):
    """任务只保存不可逆配置指纹，避免排队期间被改用另一套绘图服务。"""
    if not isinstance(config, dict):
        raise DomainError(400, "invalid_settings", "出图设置格式不正确。")
    base_url = validate_base_url(config.get("base_url", BASE_URL_DEFAULT))
    model = validate_model(config.get("model", MODEL_DEFAULT), base_url)
    watermark = config.get("watermark", True)
    if type(watermark) is not bool:
        raise DomainError(400, "invalid_settings", "水印设置必须为开启或关闭。")
    quality = validate_quality(config.get("quality", "low"))
    key = config.get("api_key", "")
    if key:
        _validate_key(key)
    elif not isinstance(key, str):
        _validate_key(key)
    encoded = json.dumps([base_url, model, watermark, quality, key], ensure_ascii=False,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_key(value):
    # 密钥最终进入 HTTP 请求头，因此禁止空格、控制符和非 ASCII 字符。
    if (not isinstance(value, str) or not 16 <= len(value) <= 512
            or any(not 33 <= ord(char) <= 126 for char in value)):
        raise DomainError(400, "invalid_settings", "API 密钥格式不正确，请粘贴完整密钥（16 至 512 个可见字符）。")
    return value


def _dpapi(data, protect):
    """不使用机器级保护：只有保存密钥的 Windows 当前账户可解开。"""
    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    source_buffer = ctypes.create_string_buffer(data)
    source = DataBlob(len(data), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = DataBlob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL
    if protect:
        function = crypt32.CryptProtectData
        function.argtypes = [ctypes.POINTER(DataBlob), wintypes.LPCWSTR, ctypes.c_void_p,
                             ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob)]
        arguments = (ctypes.byref(source), "作品创作台 API 密钥", None, None, None, 1, ctypes.byref(target))
    else:
        function = crypt32.CryptUnprotectData
        function.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
                             ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob)]
        arguments = (ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target))
    function.restype = wintypes.BOOL
    if not function(*arguments):
        raise OSError("当前 Windows 账户无法保护或读取密钥")
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(target.pbData, wintypes.HLOCAL))


class SecretSettings:
    """仅后台可调用 get；public/update 的返回值永远不含完整密钥。"""

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / "provider-settings.json"
        self._lock = threading.RLock()

    def _read(self):
        config = {"model": MODEL_DEFAULT, "base_url": BASE_URL_DEFAULT, "watermark": True, "quality": "low"}
        if not self.path.exists():
            return config
        try:
            if self.path.stat().st_size > 32768:
                raise ValueError("配置过大")
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("配置结构错误")
            config["base_url"] = validate_base_url(payload.get("base_url", BASE_URL_DEFAULT))
            config["model"] = validate_model(payload.get("model", MODEL_DEFAULT), config["base_url"])
            config["quality"] = validate_quality(payload.get("quality", "low"))
            watermark = payload.get("watermark", True)
            if type(watermark) is not bool:
                raise ValueError("水印设置错误")
            config["watermark"] = watermark
            if payload.get("protected_key"):
                raw = base64.b64decode(payload["protected_key"], validate=True)
                if payload.get("key_protection") == "dpapi-current-user" and os.name == "nt":
                    raw = _dpapi(raw, False)
                elif payload.get("key_protection") != "private-file" or os.name == "nt":
                    raise ValueError("密钥保护类型不兼容")
                config["api_key"] = _validate_key(raw.decode("utf-8"))
            return config
        except (OSError, ValueError, TypeError, KeyError, UnicodeError, DomainError):
            raise DomainError(500, "settings_unreadable", "无法读取出图配置，请使用保存配置的系统账户重新配置。") from None

    def get(self):
        with self._lock:
            config = self._read()
            # 保存的密钥优先。环境密钥只作为外部来源，绝不自动落盘。
            if not config.get("api_key") and provider_from_base(config["base_url"]) == "ark":
                external = os.environ.get("SEEDREAM_API_KEY", "")
                config["api_key"] = _validate_key(external) if external else ""
            config.setdefault("api_key", "")
            return dict(config)

    def configured(self):
        return bool(self.get()["api_key"])

    def public(self):
        config = self.get()
        key = config["api_key"]
        return {"configured": bool(key), "model": config["model"], "base_url": config["base_url"],
                "provider": provider_from_base(config["base_url"]), "quality": config["quality"],
                "watermark": config["watermark"], "key_hint": "••••" + key[-4:] if key else ""}

    def update(self, payload):
        if not isinstance(payload, dict):
            raise DomainError(400, "invalid_settings", "出图设置格式不正确。")
        with self._lock:
            current = self._read()
            base_url = validate_base_url(payload.get("base_url", current["base_url"]))
            provider = provider_from_base(base_url)
            if "provider" in payload and payload["provider"] != provider:
                raise DomainError(400, "invalid_settings", "绘图服务与接口地址不一致。")
            model = validate_model(payload.get("model", current["model"]), base_url)
            quality = validate_quality(payload.get("quality", current["quality"]))
            watermark = payload.get("watermark", current["watermark"])
            if type(watermark) is not bool:
                raise DomainError(400, "invalid_settings", "水印设置必须为开启或关闭。")
            new_key = payload.get("api_key", "")
            if not isinstance(new_key, str):
                _validate_key(new_key)
            # 跨服务商时必须明确输入新密钥，绝不把原服务商的密钥送给另一方。
            if provider != provider_from_base(current["base_url"]) and not new_key:
                raise DomainError(400, "invalid_settings", "切换绘图服务时请填写对应服务的新 API 密钥。")
            key = _validate_key(new_key) if new_key else current.get("api_key", "")
            stored = {"model": model, "base_url": base_url, "watermark": watermark, "quality": quality}
            temp_path = None
            try:
                if key:
                    raw = key.encode("utf-8")
                    if os.name == "nt":
                        raw = _dpapi(raw, True)
                    stored["key_protection"] = "dpapi-current-user" if os.name == "nt" else "private-file"
                    stored["protected_key"] = base64.b64encode(raw).decode("ascii")
                self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                descriptor, name = tempfile.mkstemp(prefix=".provider-", suffix=".tmp", dir=self.data_dir)
                temp_path = Path(name)
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                    json.dump(stored, handle, ensure_ascii=False, indent=2)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(temp_path, 0o600)
                os.replace(temp_path, self.path)
            except (OSError, ValueError, TypeError):
                raise DomainError(500, "settings_write_failed", "无法保存出图设置，请检查服务器数据目录权限。") from None
            finally:
                if temp_path is not None and temp_path.exists():
                    try:
                        temp_path.unlink()
                    except OSError:
                        pass
            return self.public()
