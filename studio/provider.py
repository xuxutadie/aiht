"""固定服务商的单图适配器，仅使用 Python 标准库。

参数依据：https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
不自动重试：请求超时后可能已计费，需要管理员核对后处理预留算力。
"""

import base64
import binascii
from dataclasses import dataclass
import http.client
import hmac
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
from .secrets import validate_base_url, validate_model, validate_quality, provider_from_base, config_fingerprint


MAX_IMAGE_BYTES = 20 * 1024 * 1024
# JSON中的base64会膨胀至原图的4/3，另留64KiB外壳；解码后仍限20MiB。
MAX_RESPONSE_BYTES = 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 64 * 1024
MAX_ERROR_BODY_BYTES = 64 * 1024
TIMEOUT_SECONDS = 180
RATIO_SIZES = {"1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368",
               "16:9": "2816x1584", "9:16": "1584x2816"}
HK_RATIO_SIZES = {"1:1": "1024x1024", "4:3": "1024x768", "3:4": "768x1024",
                  "16:9": "1280x720", "9:16": "720x1280"}
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


# 仅识别火山方舟文档列出的固定错误码；不输出任何上游自由文本、字段或未知子码。
# https://docs.volcengine.com/docs/ark/error-codes
_INPUT_REJECTED = "创作提示词未通过内容安全审核，请检查创作内容是否符合使用规范。"
_OUTPUT_REJECTED = "生成的图片未通过内容安全审核，请检查创作内容是否符合使用规范。"
_INVALID_PARAMETER = "绘图请求参数不受支持或不正确，请联系管理员检查模型配置。"
_REJECTION_MESSAGES = {
    "SensitiveContentDetected": _INPUT_REJECTED,
    "SensitiveContentDetected.SevereViolation": _INPUT_REJECTED,
    "SensitiveContentDetected.Violence": _INPUT_REJECTED,
    "InputTextSensitiveContentDetected": _INPUT_REJECTED,
    "InputTextRiskDetection": _INPUT_REJECTED,
    "OutputImageSensitiveContentDetected": _OUTPUT_REJECTED,
    "OutputImageRiskDetection": _OUTPUT_REJECTED,
    "InputTextSensitiveContentDetected.PolicyViolation": "创作提示词可能涉及版权限制，请使用符合授权要求的创作内容。",
    "OutputImageSensitiveContentDetected.PolicyViolation": "生成的图片可能涉及版权限制，请检查创作内容是否符合授权要求。",
    "OutputImageSensitiveContentDetected.DeepFake": "生成的图片可能涉及伪造内容风险，请检查创作内容是否符合使用规范。",
    "InvalidParameter": _INVALID_PARAMETER,
    "InvalidParameter.UnsupportedParameter": _INVALID_PARAMETER,
    "InvalidParameter.TaskTypeConstraint": _INVALID_PARAMETER,
    "InvalidParameter.TaskTypeMismatch": _INVALID_PARAMETER,
    "MissingParameter": "绘图请求缺少必要参数，请联系管理员检查模型配置。",
}


def _rejection_message(payload, status, fallback):
    detail = payload.get("error") if isinstance(payload, dict) else None
    code = detail.get("code") if isinstance(detail, dict) else None
    if isinstance(code, str) and len(code) <= 128:
        message = _REJECTION_MESSAGES.get(code)
        if message:
            return message
    # HTTP 状态来自响应本身，而不是可能携带隐私信息的 JSON 正文。
    suffix = f"（HTTP {status}）" if type(status) is int and 100 <= status <= 599 else ""
    return fallback + suffix + "，请检查方案或联系管理员。"


def _http_error_payload(exc):
    try:
        return json.loads(_read_limited(exc, MAX_ERROR_BODY_BYTES))
    except (ValueError, TypeError, OSError, http.client.HTTPException, RecursionError):
        # 已经收到明确的 4xx；读取或解析正文失败不改变原有的失败结算性质。
        return None


def _safe_download_ips(url, provider="ark"):
    if not isinstance(url, str) or len(url) > 8192 or "\\" in url or any(ord(char) <= 32 for char in url):
        raise ValueError("图片下载链接不合法")
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        allowed = (bool(_DOWNLOAD_HOST.fullmatch(host)) if provider == "ark"
                   else provider == "openai-hk" and host == "myfile.addmao.com")
        if (parsed.scheme != "https" or not allowed
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


def _decode_image_base64(value):
    """只接受标准base64或明确声明图片类型的data URI，不信任声明替代图片校验。"""
    if not isinstance(value, str):
        raise ValueError("图片编码格式不正确")
    declared_mime = None
    if value.startswith("data:"):
        match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})", value)
        if not match:
            raise ValueError("图片data URI格式不正确")
        declared_mime, value = match.groups()
    if len(value) > 4 * ((MAX_IMAGE_BYTES + 2) // 3) or len(value) % 4:
        raise ValueError("图片编码超过限制或格式不正确")
    data = base64.b64decode(value, validate=True)
    if len(data) > MAX_IMAGE_BYTES or base64.b64encode(data).decode("ascii") != value:
        raise ValueError("图片编码超过限制或不规范")
    return data, declared_mime


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
                raise ProviderError("请先由管理员配置绘图服务 API 密钥。")
            base_url = validate_base_url(settings["base_url"])
            model = validate_model(settings["model"], base_url)
            provider = provider_from_base(base_url)
            quality = validate_quality(settings.get("quality", "low"))
            fingerprint = config_fingerprint(settings)
        except DomainError:
            raise ProviderError("出图配置无法使用，请联系管理员检查设置。") from None
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
            raise ProviderError("创作提示词为空或过长，请检查创作方案。")
        if (not isinstance(options, dict) or not isinstance(options.get("ratio", "1:1"), str)
                or options.get("ratio", "1:1") not in RATIO_SIZES):
            raise ProviderError("画面比例不受支持，请重新选择。")
        expected = options.get("config_fingerprint")
        if "config_fingerprint" in options:
            if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected) or not hmac.compare_digest(expected, fingerprint):
                raise ProviderError("绘图配置已变更，本次尚未调用模型，请重新确认方案后再生成。")
        elif provider != "ark":
            # 兼容升级前的Ark任务，但绝不能把这些旧任务默默转发给新服务商。
            raise ProviderError("旧任务未记录当前绘图配置，本次尚未调用模型，请重新发起生成。")
        if provider == "openai-hk":
            payload = {"model": model, "prompt": prompt, "n": 1,
                       "size": HK_RATIO_SIZES[options.get("ratio", "1:1")],
                       "quality": quality, "response_format": "b64_json"}
        else:
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
                status = getattr(response, "status", None)
                content_type = response.headers.get("Content-Type", "").split(";")[0].lower()
                raw = _read_limited(response, MAX_IMAGE_BYTES if content_type.startswith("image/") else MAX_RESPONSE_BYTES)
        except error.HTTPError as exc:
            request_id = _request_id(exc.headers, key)
            status = exc.code
            try:
                if 400 <= status < 500:
                    messages = {401: "出图密钥无效，请联系管理员检查配置。", 403: "出图权限不足，请联系管理员检查模型权限。",
                                429: "出图服务当前繁忙或暂不可用，请联系老师。"}
                    message = messages.get(status)
                    if message is None:
                        message = _rejection_message(_http_error_payload(exc), status, "出图服务未接受本次请求")
                    raise ProviderError(message, request_id=request_id) from None
            finally:
                exc.close()
            raise ProviderError("出图服务暂时异常，本次生成状态待管理员核对。", uncertain=True,
                                request_id=request_id) from None
        except (error.URLError, TimeoutError, OSError, ValueError, http.client.HTTPException):
            raise ProviderError("出图响应未完整收到，本次生成状态待管理员核对。", uncertain=True,
                                request_id=request_id) from None
        try:
            usage = {}
            declared_mime = None
            if content_type.startswith("image/"):
                image_data = raw
            else:
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError("响应格式不正确")
                if payload.get("error"):
                    # 官方顶层 error 表示整次请求未生成任何图片。
                    raise ProviderError(_rejection_message(payload, status, "出图服务未能生成本次图片"), request_id=request_id)
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
                    image_data, declared_mime = _decode_image_base64(entry["b64_json"])
                elif entry.get("url"):
                    url = entry["url"]
                    ips = _safe_download_ips(url, provider)
                    # 下载请求不携带 API 密钥，且只连接已验证的公网地址。
                    with _open(request.Request(url, headers={"Accept": "image/png, image/jpeg, image/webp"}), pinned_ips=ips) as response:
                        image_data = _read_limited(response, MAX_IMAGE_BYTES)
                else:
                    raise ValueError("响应中没有图片")
            mime, width, height = inspect_image(image_data)
            if declared_mime is not None and declared_mime != mime:
                raise ValueError("图片data URI类型与实际图片不一致")
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
