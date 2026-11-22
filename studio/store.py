"""作品创作台的账号、方案和作品存储。每次操作使用独立数据库连接。"""

import hashlib
import re
import secrets
import sqlite3
import time

from .auth import hash_password, validate_profile, verify_password
from .contracts import DomainError, INITIAL_CREDITS, SESSION_SECONDS
from ._store_database import (Database, artwork_record, display_system_text, json_object, new_id, now,
                              plan_record, text_value, user_record)
from ._store_jobs import GenerationStore


def _session_hash(token):
    if not isinstance(token, str) or not 16 <= len(token) <= 256:
        return None
    try:
        return hashlib.sha256(token.encode("ascii")).hexdigest()
    except UnicodeError:
        return None


def _authorization_code_hash(value):
    """完整授权码只在输入或生成时短暂使用，持久化只保存摘要与尾号。"""
    if value is None or isinstance(value, str) and not value.strip():
        raise DomainError(400, "authorization_code_required", "请填写老师提供的8位数字授权码。")
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{7}", value.strip()):
        raise DomainError(400, "invalid_authorization_code", "授权码无效或已使用，请联系老师获取有效授权码。")
    return hashlib.sha256(value.strip().encode("ascii")).hexdigest()


def _authorization_code_record(row):
    result = {key: row[key] for key in ("id", "code_hint", "created_at", "used_at", "used_by")}
    result["status"] = "used" if result["used_by"] is not None else "unused"
    return result


class Store(GenerationStore, Database):
    def has_admin(self):
        with self.connection() as connection:
            return connection.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone() is not None

    def create_user(self, profile: dict, password: str, role="student", authorization_code=None) -> dict:
        values = validate_profile(profile, role)
        code_hash = _authorization_code_hash(authorization_code) if role == "student" else None
        encoded = hash_password(password)
        user_id = new_id()
        try:
            with self.transaction() as connection:
                if role == "admin" and connection.execute("SELECT 1 FROM users WHERE role = 'admin'").fetchone():
                    raise DomainError(409, "setup_complete", "管理员已完成初始化，请直接登录。")
                if role == "student":
                    code = connection.execute(
                        "SELECT id FROM authorization_codes WHERE code_hash = ? AND used_by IS NULL",
                        (code_hash,)).fetchone()
                    if code is None:
                        raise DomainError(400, "invalid_authorization_code", "授权码无效或已使用，请联系老师获取有效授权码。")
                timestamp = now()
                connection.execute("""INSERT INTO users
                    (id,name,phone,region,school,grade,role,password_hash,credits,reserved_credits,created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,0,?)""",
                    (user_id, values["name"], values["phone"], values["region"], values["school"],
                     values["grade"], role, encoded, INITIAL_CREDITS, timestamp))
                self._ledger_in(connection, user_id, "grant", INITIAL_CREDITS, None, "首次注册赠送10点算力")
                if role == "student":
                    # 与开户和赠送共用写事务；任一步失败会一并回滚，不能耗掉授权码。
                    connection.execute("UPDATE authorization_codes SET used_by = ?, used_at = ? WHERE id = ?",
                                       (user_id, timestamp, code["id"]))
                return self._user_in(connection, user_id)
        except sqlite3.IntegrityError as error:
            if str(error) == "UNIQUE constraint failed: users.phone":
                raise DomainError(409, "phone_registered", "该手机号已注册，请直接登录。") from None
            raise

    def _authorization_admin_in(self, connection, admin_user_id):
        admin = self._user_in(connection, admin_user_id)
        if admin["role"] != "admin":
            raise DomainError(403, "admin_required", "此功能仅供老师管理员使用。")

    def create_authorization_codes(self, admin_user_id, count=1):
        if type(count) is not int or not 1 <= count <= 100:
            raise DomainError(400, "invalid_authorization_code_count", "每批授权码数量须为1至100之间的整数。")
        with self.transaction() as connection:
            self._authorization_admin_in(connection, admin_user_id)
            timestamp, created = now(), []
            # 碰撞可以重试，但必须限制单次请求占用写锁的时间。
            for _ in range(max(1000, count * 20)):
                code = str(secrets.randbelow(90_000_000) + 10_000_000)
                result = connection.execute("""INSERT INTO authorization_codes
                    (code_hash,code_hint,created_by,created_at) VALUES (?,?,?,?)
                    ON CONFLICT(code_hash) DO NOTHING""",
                    (hashlib.sha256(code.encode("ascii")).hexdigest(), code[-4:], admin_user_id, timestamp))
                if result.rowcount == 0:
                    continue
                # 仅本次生成响应携带完整码，查询接口不再提供完整码或摘要。
                created.append({"id": result.lastrowid, "code": code, "code_hint": code[-4:],
                                "status": "unused", "created_at": timestamp, "used_at": None, "used_by": None})
                if len(created) == count:
                    return created
            raise DomainError(503, "authorization_code_generation_failed", "授权码暂时生成失败，请稍后重试。")

    def list_authorization_codes(self, admin_user_id, limit=50, before=None):
        if (type(limit) is not int or not 1 <= limit <= 100
                or before is not None and (type(before) is not int or not 1 <= before <= 9_007_199_254_740_991)):
            raise DomainError(400, "invalid_pagination", "分页数量或游标格式不正确。")
        with self.connection() as connection:
            self._authorization_admin_in(connection, admin_user_id)
            condition = "WHERE id < ?" if before is not None else ""
            parameters = (before, limit + 1) if before is not None else (limit + 1,)
            rows = connection.execute(
                f"SELECT id,code_hint,created_at,used_at,used_by FROM authorization_codes {condition} ORDER BY id DESC LIMIT ?",
                parameters).fetchall()
            codes = [_authorization_code_record(row) for row in rows[:limit]]
            return {"codes": codes, "next_cursor": codes[-1]["id"] if len(rows) > limit else None}

    def authenticate(self, phone, password):
        if (not isinstance(phone, str) or len(phone) > 11
                or not re.fullmatch(r"1[3-9][0-9]{9}", phone.strip())):
            return None
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM users WHERE phone = ?", (phone.strip(),)).fetchone()
            if row is None or not verify_password(password, row["password_hash"]):
                return None
            return user_record(row)

    def create_session(self, user_id) -> str:
        token = secrets.token_urlsafe(32)
        with self.transaction() as connection:
            self._user_in(connection, user_id)
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
            connection.execute("INSERT INTO sessions VALUES (?,?,?,?)",
                               (_session_hash(token), user_id, int(time.time()) + SESSION_SECONDS, now()))
        return token

    def get_user_by_session(self, token):
        token_hash = _session_hash(token)
        if token_hash is None:
            return None
        with self.connection() as connection:
            row = connection.execute("""SELECT users.* FROM users JOIN sessions ON users.id = sessions.user_id
                                      WHERE sessions.token_hash = ? AND sessions.expires_at > ?""",
                                     (token_hash, int(time.time()))).fetchone()
            return user_record(row) if row is not None else None

    def delete_session(self, token):
        token_hash = _session_hash(token)
        if token_hash is not None:
            with self.transaction() as connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    def get_user(self, user_id):
        with self.connection() as connection:
            return self._user_in(connection, user_id)

    def list_users(self):
        # 仅 HTTP 管理员路由可调用；该接口永远只返回公开资料字段。
        with self.connection() as connection:
            return [user_record(row) for row in connection.execute("SELECT * FROM users ORDER BY created_at DESC, rowid DESC")]

    def create_plan(self, user_id, title, answers=None):
        title = text_value(title, "方案标题", 120) or "我的创作方案"
        encoded = json_object({} if answers is None else answers)
        plan_id, timestamp = new_id(), now()
        with self.transaction() as connection:
            self._user_in(connection, user_id)
            connection.execute("INSERT INTO plans VALUES (?,?,?,?,0,0,?,?)",
                               (plan_id, user_id, title, encoded, timestamp, timestamp))
            return plan_record(connection.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone())

    def list_plans(self, user_id):
        with self.connection() as connection:
            return [plan_record(row) for row in connection.execute(
                "SELECT * FROM plans WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC", (user_id,))]

    def get_plan(self, user_id, plan_id):
        with self.connection() as connection:
            return plan_record(connection.execute("SELECT * FROM plans WHERE id = ? AND user_id = ?",
                                                   (plan_id, user_id)).fetchone())

    def save_plan(self, user_id, plan_id, answers, step, confirmed=False, title=None):
        if type(step) is not int or not 0 <= step <= 6:
            raise DomainError(400, "invalid_step", "创作步骤须为0至6之间的整数。")
        if type(confirmed) is not bool:
            raise DomainError(400, "invalid_confirmation", "请使用勾选确认状态。")
        encoded = json_object(answers)
        if title is not None:
            title = text_value(title, "方案标题", 120) or "我的创作方案"
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM plans WHERE id = ? AND user_id = ?",
                                     (plan_id, user_id)).fetchone()
            previous = plan_record(row)
            title = previous["title"] if title is None else title
            content_changed = encoded != row["answers"] or title != previous["title"]
            # 已确认方案内容变动后必须重新确认，单纯切换页面不算内容修改。
            if previous["confirmed"] and content_changed:
                confirmed = False
            connection.execute("UPDATE plans SET title = ?, answers = ?, step = ?, confirmed = ?, updated_at = ? WHERE id = ?",
                               (title, encoded, step, int(confirmed), now(), plan_id))
            return plan_record(connection.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone())

    def list_artworks(self, user_id):
        with self.connection() as connection:
            return [artwork_record(row) for row in connection.execute(
                "SELECT * FROM artworks WHERE user_id = ? ORDER BY created_at DESC, rowid DESC", (user_id,))]

    def get_artwork(self, user_id, artwork_id):
        with self.connection() as connection:
            return artwork_record(connection.execute("SELECT * FROM artworks WHERE id = ? AND user_id = ?",
                                                      (artwork_id, user_id)).fetchone())

    def get_artwork_for_admin(self, admin_user_id, artwork_id):
        """管理员图片审核专用，普通的本人作品接口始终保持归属隔离。"""
        with self.connection() as connection:
            admin = self._user_in(connection, admin_user_id)
            if admin["role"] != "admin":
                raise DomainError(403, "admin_required", "仅管理员可以审核其他学员的作品。")
            return artwork_record(connection.execute("SELECT * FROM artworks WHERE id = ?", (artwork_id,)).fetchone())

    def update_artwork(self, user_id, artwork_id, reflection, description):
        reflection = text_value(reflection, "作品反思", 5000)
        description = text_value(description, "作品说明", 5000)
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM artworks WHERE id = ? AND user_id = ?",
                                     (artwork_id, user_id)).fetchone()
            artwork_record(row)
            connection.execute("UPDATE artworks SET reflection = ?, description = ? WHERE id = ?",
                               (reflection, description, artwork_id))
            return artwork_record(connection.execute("SELECT * FROM artworks WHERE id = ?", (artwork_id,)).fetchone())

    def ledger(self, user_id):
        with self.connection() as connection:
            rows = connection.execute("""SELECT id,kind,delta,balance_after,job_id,note,created_at
                                        FROM ledger WHERE user_id = ? ORDER BY rowid DESC""", (user_id,))
            return [{**dict(row), "note": display_system_text(row["note"])} for row in rows]
