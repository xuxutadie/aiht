"""Seedream 5.0 Flash 单图适配器，仅使用 Python 标准库。

参数依据：https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
不自动重试：请求超时后可能已计费，需要管理员核对后处理预留算力。
"""

import base64
import binascii
from dataclasses import dataclass
import http.client
import ipaddress
import json
import re
import socket
import ssl
import struct
from urllib import error, request
from urllib.parse import urlsplit
import zlib

from .contracts import DomainError
from .secrets import validate_base_url, validate_model


MAX_RESPONSE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
TIMEOUT_SECONDS = 180
RATIO_SIZES = {"1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368",
               "16:9": "2816x1584", "9:16": "1584x2816"}
_DOWNLOAD_HOST = re.compile(r"(?:[a-z0-9-]+\.)+tos(?:-s)?-cn-[a-z0-9-]+\.volces\.com\Z")


@dataclass(frozen=True)
class GeneratedImage:
    data: bytes
    mime: str
    width: int
    height: int
    usage: dict
    upstream_request_id: str


class ProviderError(Exception):
    def __init__(self, message: str, uncertain: bool = False, request_id: str = ""):
        super().__init__(message)
        self.message = message
        self.uncertain = bool(uncertain)
        self.request_id = request_id


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # API 和图片下载都不跟随重定向，防止请求头或访问权限被转送。
        return None


class _PinnedHTTPSHandler(request.HTTPSHandler):
    def __init__(self, ips):
        super().__init__(context=ssl.create_default_context())
        self.ips = ips

    def https_open(self, req):
        def connection(host, **kwargs):
            result = http.client.HTTPSConnection(host, **kwargs)

            def connect_public_address(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, **unused):
                # 验证后的公网 IP 直接连接；TLS 证书及 SNI 仍校验原始域名。
                return socket.create_connection((self.ips[0], address[1]), timeout, source_address)

            result._create_connection = connect_public_address
            return result

        return self.do_open(connection, req, context=self._context)


def _open(req, *, pinned_ips=None):
    handlers = [request.ProxyHandler({}), _NoRedirect()]
    if pinned_ips:
        handlers.append(_PinnedHTTPSHandler(pinned_ips))
    else:
        handlers.append(request.HTTPSHandler(context=ssl.create_default_context()))
    return request.build_opener(*handlers).open(req, timeout=TIMEOUT_SECONDS)


def _request_id(headers, secret=""):
    for name in ("X-Request-Id", "X-Tt-Logid", "X-Tt-Request-Id"):
        value = headers.get(name, "") if headers else ""
        if (isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value)
                and (not secret or secret not in value)):
            return value
    return ""


def _read_limited(response, maximum):
    length = response.headers.get("Content-Length") if response.headers else None
    if length:
        try:
            if int(length) > maximum:
                raise ValueError("响应过大")
        except (TypeError, ValueError):
            raise ValueError("响应长度不合法或超过限制") from None
    parts = []
    total = 0
    while True:
        part = response.read(min(65536, maximum + 1 - total))
        if not part:
            break
        total += len(part)
        if total > maximum:
            raise ValueError("响应超过限制")
        parts.append(part)
    return b"".join(parts)


def _safe_download_ips(url):
    if not isinstance(url, str) or len(url) > 8192 or any(ord(char) <= 32 for char in url):
        raise ValueError("图片下载链接不合法")
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if (parsed.scheme != "https" or not _DOWNLOAD_HOST.fullmatch(host)
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443) or parsed.fragment):
            raise ValueError("图片下载地址不在允许范围")
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        ips = tuple(dict.fromkeys(item[4][0] for item in addresses))
        if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
            raise ValueError("图片地址未解析为公网")
        return ips
    except (OSError, TypeError):
        raise ValueError("无法验证图片地址") from None


def _dimensions(width, height):
    if not 1 <= width <= 16384 or not 1 <= height <= 16384 or width * height > 50_000_000:
        raise ValueError("图片像素范围不合法")
    return width, height


def _png_dimensions(data):
    position = 8
    width = height = None
    has_data = False
    while position + 12 <= len(data):
        size = struct.unpack_from(">I", data, position)[0]
        kind = data[position + 4:position + 8]
        end = position + 12 + size
        if end > len(data):
            raise ValueError("PNG 数据不完整")
        content = data[position + 8:position + 8 + size]
        checksum = struct.unpack_from(">I", data, position + 8 + size)[0]
        if zlib.crc32(kind + content) != checksum:
            raise ValueError("PNG 校验错误")
        if width is None:
            if kind != b"IHDR" or size != 13:
                raise ValueError("PNG 缺少尺寸信息")
            width, height = _dimensions(*struct.unpack_from(">II", content))
            depth, color, compression, filtering, interlace = content[8:]
            allowed_depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            if depth not in allowed_depths.get(color, ()) or compression or filtering or interlace not in (0, 1):
                raise ValueError("PNG 头部不合法")
        elif kind == b"IHDR":
            raise ValueError("PNG 头部重复")
        if kind == b"IDAT" and content:
            has_data = True
        if kind == b"IEND":
            if size or not has_data or end != len(data):
                raise ValueError("PNG 数据不完整")
            return width, height
        position = end
    raise ValueError("PNG 缺少结束标记")


def _jpeg_dimensions(data):
    if not data.endswith(b"\xff\xd9"):
        raise ValueError("JPEG 数据不完整")
    position = 2
    dimensions = None
    while position < len(data):
        if data[position] != 0xFF:
            raise ValueError("JPEG 段结构不合法")
        while position < len(data) and data[position] == 0xFF:
            position += 1
        if position >= len(data):
            break
        marker = data[position]
        position += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if position + 2 > len(data):
            break
        size = struct.unpack_from(">H", data, position)[0]
        if size < 2 or position + size > len(data):
            raise ValueError("JPEG 数据不完整")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if size < 8:
                raise ValueError("JPEG 尺寸信息不完整")
            height, width = struct.unpack_from(">HH", data, position + 3)
            dimensions = _dimensions(width, height)
        if marker == 0xDA:
            if dimensions is None or size < 6:
                raise ValueError("JPEG 缺少尺寸信息")
            return dimensions
        position += size
    raise ValueError("JPEG 缺少图像数据")


def _webp_dimensions(data):
    if len(data) < 26 or struct.unpack_from("<I", data, 4)[0] + 8 != len(data):
        raise ValueError("WebP 数据不完整")
    position = 12
    canvas = None
    dimensions = None
    while position + 8 <= len(data):
        kind = data[position:position + 4]
        size = struct.unpack_from("<I", data, position + 4)[0]
        content = data[position + 8:position + 8 + size]
        if len(content) != size or position + 8 + size + (size % 2) > len(data):
            raise ValueError("WebP 数据不完整")
        if kind == b"VP8X" and size == 10:
            if content[0] & 0x02:
                raise ValueError("不支持动画 WebP")
            canvas = _dimensions(int.from_bytes(content[4:7], "little") + 1,
                                 int.from_bytes(content[7:10], "little") + 1)
        elif kind == b"VP8 " and size >= 10 and content[3:6] == b"\x9d\x01\x2a":
            width, height = struct.unpack_from("<HH", content, 6)
            dimensions = _dimensions(width & 0x3FFF, height & 0x3FFF)
        elif kind == b"VP8L" and size >= 5 and content[0] == 0x2F:
            bits = int.from_bytes(content[1:5], "little")
            if bits >> 29:
                raise ValueError("WebP 版本不受支持")
            dimensions = _dimensions((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        position += 8 + size + (size % 2)
    if dimensions and position == len(data) and (canvas is None or canvas == dimensions):
        return dimensions
    raise ValueError("WebP 缺少尺寸信息")


def inspect_image(data):
    """根据二进制结构读取真实格式及尺寸，不相信扩展名或上游 JSON 尺寸。"""
    if not isinstance(data, bytes) or not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片为空或超过大小限制")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ("image/png", *_png_dimensions(data))
    if data.startswith(b"\xff\xd8"):
        return ("image/jpeg", *_jpeg_dimensions(data))
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ("image/webp", *_webp_dimensions(data))
    raise ValueError("未收到受支持的图片格式")


class Provider:
    def __init__(self, settings):
        self.settings = settings

    def generate(self, prompt: str, options: dict) -> GeneratedImage:
        try:
            settings = self.settings.get()
            key = settings.get("api_key", "")
            if not key:
                raise ProviderError("请先由管理员配置 Seedream API 密钥。")
            base_url = validate_base_url(settings["base_url"])
            model = validate_model(settings["model"])
        except DomainError:
            raise ProviderError("出图配置无法使用，请联系管理员检查设置。") from None
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
            raise ProviderError("创作提示词为空或过长，请检查创作方案。")
        if (not isinstance(options, dict) or not isinstance(options.get("ratio", "1:1"), str)
                or options.get("ratio", "1:1") not in RATIO_SIZES):
            raise ProviderError("画面比例不受支持，请重新选择。")
        payload = {"model": model, "prompt": prompt, "size": RATIO_SIZES[options.get("ratio", "1:1")],
                   "output_format": "png", "response_format": "b64_json",
                   "watermark": settings.get("watermark", True), "layer_decomposition": False}
        try:
            encoded_payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        except UnicodeError:
            raise ProviderError("创作提示词包含无法识别的字符，请重新输入。") from None
        req = request.Request(base_url + "/images/generations", method="POST", data=encoded_payload,
                              headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                       "Accept": "application/json, image/png, image/jpeg, image/webp"})
        request_id = ""
        try:
            with _open(req) as response:
                request_id = _request_id(response.headers, key)
                raw = _read_limited(response, MAX_RESPONSE_BYTES)
                content_type = response.headers.get("Content-Type", "").split(";")[0].lower()
        except error.HTTPError as exc:
            request_id = _request_id(exc.headers, key)
            status = exc.code
            exc.close()
            # 不转发可能包含密钥、提示词或其他隐私的上游错误正文。
            if 400 <= status < 500:
                messages = {401: "出图密钥无效，请联系管理员检查配置。", 403: "出图权限不足，请联系管理员检查模型权限。",
                            429: "出图服务当前繁忙或暂不可用，请联系老师。"}
                raise ProviderError(messages.get(status, "出图服务未接受本次请求，请检查方案或联系管理员。"),
                                    request_id=request_id) from None
            raise ProviderError("出图服务暂时异常，本次生成状态待管理员核对。", uncertain=True,
                                request_id=request_id) from None
        except (error.URLError, TimeoutError, OSError, ValueError, http.client.HTTPException):
            raise ProviderError("出图响应未完整收到，本次生成状态待管理员核对。", uncertain=True,
                                request_id=request_id) from None
        try:
            usage = {}
            if content_type.startswith("image/"):
                image_data = raw
            else:
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError("响应格式不正确")
                if payload.get("error"):
                    # 官方顶层 error 表示整次请求未生成任何图片。
                    raise ProviderError("出图服务未能生成本次图片，请检查方案或联系管理员。", request_id=request_id)
                entries = payload.get("data")
                if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
                    raise ValueError("单图响应结构不正确")
                entry = entries[0]
                usage_raw = payload.get("usage", {})
                if isinstance(usage_raw, dict):
                    # 用量仅收录数字白名单，避免把任意上游文本存入记录。
                    usage = {name: usage_raw[name] for name in ("generated_images", "input_images", "output_tokens", "total_tokens")
                             if type(usage_raw.get(name)) is int and 0 <= usage_raw[name] <= 10**12}
                if entry.get("b64_json"):
                    encoded = entry["b64_json"]
                    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
                        raise ValueError("图片编码超过限制")
                    image_data = base64.b64decode(encoded, validate=True)
                elif entry.get("url"):
                    url = entry["url"]
                    ips = _safe_download_ips(url)
                    # 下载请求不携带 API 密钥，且只连接已验证的公网地址。
                    with _open(request.Request(url, headers={"Accept": "image/png, image/jpeg, image/webp"}), pinned_ips=ips) as response:
                        image_data = _read_limited(response, MAX_IMAGE_BYTES)
                else:
                    raise ValueError("响应中没有图片")
            mime, width, height = inspect_image(image_data)
            return GeneratedImage(image_data, mime, width, height, usage, request_id)
        except ProviderError:
            raise
        except error.HTTPError as exc:
            exc.close()
            raise ProviderError("图片下载未完成，本次生成状态待管理员核对。", uncertain=True,
                                request_id=request_id) from None
        except (ValueError, TypeError, UnicodeError, binascii.Error, error.URLError, OSError, http.client.HTTPException):
            raise ProviderError("图片响应无法安全保存，本次生成状态待管理员核对。", uncertain=True,
                                request_id=request_id) from None
