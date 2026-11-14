"""密码校验和注册资料校验，不接触 HTTP 或数据库。"""

import hashlib
import hmac
import re
import secrets

from .contracts import DomainError

_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1


def _valid_password(password):
    return (isinstance(password, str) and 8 <= len(password) <= 128
            and not any(0xD800 <= ord(char) <= 0xDFFF for char in password))


def hash_password(password: str) -> str:
    """每个密码使用独立随机盐，限制输入长度后才进行昂贵运算。"""
    if not _valid_password(password):
        raise DomainError(400, "invalid_password", "密码长度须为8至128个字符。")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_SCRYPT_N,
                            r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    if not _valid_password(password) or not isinstance(encoded, str) or len(encoded) > 300:
        return False
    try:
        algorithm, n, r, p, salt_hex, digest_hex = encoded.split("$")
        if (algorithm, n, r, p) != ("scrypt", str(_SCRYPT_N), str(_SCRYPT_R), str(_SCRYPT_P)):
            return False
        salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(digest_hex)
        if len(salt) != 16 or len(expected) != 32:
            return False
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_SCRYPT_N,
                                r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError, UnicodeError):
        return False


def validate_profile(profile: dict, role: str) -> dict:
    if not isinstance(profile, dict) or role not in ("student", "admin"):
        raise DomainError(400, "invalid_profile", "账号资料格式不正确。")
    result = {}
    limits = {"name": 50, "phone": 11, "region": 100, "school": 100, "grade": 30}
    labels = {"name": "姓名", "phone": "手机号", "region": "地区", "school": "学校", "grade": "年级"}
    for key, limit in limits.items():
        value = profile.get(key, "")
        if not isinstance(value, str) or len(value) > limit:
            raise DomainError(400, "invalid_profile", f"请填写有效的{labels[key]}。")
        value = value.strip()
        required = key in ("name", "phone") or role == "student"
        if ((required and not value)
                or any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
            raise DomainError(400, "invalid_profile", f"请填写有效的{labels[key]}。")
        result[key] = value
    if not re.fullmatch(r"1[3-9][0-9]{9}", result["phone"]):
        raise DomainError(400, "invalid_phone", "请填写11位中国大陆手机号。")
    return result
