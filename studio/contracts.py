"""各模块共用的业务约定，避免接口含义不一致。"""

from pathlib import Path
import hashlib
import os

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INITIAL_CREDITS = 10
ADMIN_UNLIMITED_RESERVE_NOTE = "管理员无限算力，无需预留点数"
COOKIE_NAME = "creation_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
MODEL_DEFAULT = "doubao-seedream-5-0-flash-260915"


def data_identity(path: Path) -> str:
    """识别同一份本机数据，不向浏览器泄露实际文件路径。"""
    normalized = os.path.normcase(str(Path(path).resolve())).encode("utf-8")
    return hashlib.sha256(normalized).hexdigest()[:24]


class DomainError(Exception):
    """可安全展示给使用者的业务错误，不携带密码或上游密钥。"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
