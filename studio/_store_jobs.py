"""生成任务的原子预占、幂等结算与管理员核对。"""

import hashlib
import json
import re

from .contracts import DomainError
from ._store_database import (artwork_record, job_record, json_object, new_id, now,
                              plan_record, text_value)


class GenerationStore:
    def reserve_generation(self, user_id, plan_id, request_key, prompt, options, expected_plan_hash=None):
        request_key = text_value(request_key, "请求标识", 128, False)
        prompt = text_value(prompt, "绘图提示词", 20000, False)
        encoded_options = json_object(options, "绘图选项", 8192)
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM plans WHERE id = ? AND user_id = ?",
                                     (plan_id, user_id)).fetchone()
            plan = plan_record(row)
            if expected_plan_hash is not None:
                # 调用者先按方案整理提示词，事务内再核对版本，防止把旧提示词配给新答案。
                snapshot = json.dumps({"title": plan["title"], "answers": plan["answers"]},
                                      ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                actual_hash = hashlib.sha256(snapshot.encode("utf-8")).hexdigest()
                if expected_plan_hash != actual_hash:
                    raise DomainError(409, "plan_changed", "创作方案刚刚被修改，请重新查看并确认后再生成。")
            # 快照参与指纹，防止同一请求标识被拿来提交另一份创作内容。
            payload = json_object({"plan_id": plan_id, "prompt": prompt, "options": options,
                                   "answers": plan["answers"], "title": plan["title"]}, "生成请求", 65536)
            fingerprint = hashlib.sha256(payload.encode("utf-8")).hexdigest()
            existing = connection.execute("SELECT * FROM jobs WHERE user_id = ? AND request_key = ?",
                                          (user_id, request_key)).fetchone()
            if existing is not None:
                if existing["request_hash"] != fingerprint:
                    raise DomainError(409, "request_conflict", "该请求标识已用于其他内容，请重新发起创作。")
                return job_record(existing)
            if not plan["confirmed"]:
                raise DomainError(409, "plan_unconfirmed", "请先完成自查并确认创作方案。")
            user = self._user_in(connection, user_id)
            if user["available_credits"] < 1:
                message = ("算力已用完，请联系管理员进行补充算力。" if user["credits"] == 0
                           else "当前算力已全部预留，请等待生成结果或联系老师核对。")
                raise DomainError(409, "insufficient_credits", message)
            job_id, timestamp = new_id(), now()
            connection.execute("""INSERT INTO jobs
                (id,user_id,plan_id,request_key,request_hash,prompt,options,snapshot_answers,snapshot_title,
                 status,error_message,artwork_id,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,'queued',NULL,NULL,?,?)""",
                (job_id, user_id, plan_id, request_key, fingerprint, prompt, encoded_options,
                 row["answers"], plan["title"], timestamp, timestamp))
            connection.execute("UPDATE users SET reserved_credits = reserved_credits + 1 WHERE id = ?", (user_id,))
            self._ledger_in(connection, user_id, "reserve", 0, job_id, "已预留1点算力，生成成功后扣除")
            return job_record(connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())

    def mark_job_running(self, job_id):
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            job_record(row)
            result = connection.execute("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'",
                                        (now(), job_id))
            return result.rowcount == 1

    def get_job(self, user_id, job_id):
        with self.connection() as connection:
            return job_record(connection.execute("SELECT * FROM jobs WHERE id = ? AND user_id = ?",
                                                 (job_id, user_id)).fetchone())

    def get_job_by_request(self, user_id, request_key):
        """仅按本人请求号找回公开任务状态，不受后来修改草稿或配置的影响。"""
        if not isinstance(request_key, str) or len(request_key) > 128:
            return None
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE user_id = ? AND request_key = ?",
                                     (user_id, request_key)).fetchone()
            return job_record(row) if row is not None else None

    def get_job_internal(self, job_id):
        """仅供后台执行者加载已预占的快照，HTTP 路由不得直接返回。"""
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            result = job_record(row)
            result.update(prompt=row["prompt"], options=json.loads(row["options"]),
                          answers=json.loads(row["snapshot_answers"]), title=row["snapshot_title"],
                          usage=json.loads(row["usage_json"]))
            return result

    def record_provider_result(self, job_id, upstream_request_id, usage=None):
        """记录上游核对依据，不改变任务状态与任何额度。"""
        if (not isinstance(upstream_request_id, str)
                or not re.fullmatch(r"[A-Za-z0-9_.:-]{0,160}", upstream_request_id)):
            raise DomainError(400, "invalid_upstream_request_id", "上游请求编号格式不正确。")
        encoded_usage = None
        if usage is not None:
            # 先限制整个输入体积，再只保留数字白名单，避免把上游任意文字或密钥写入数据库。
            json_object(usage, "上游用量信息", 4096)
            clean_usage = {key: usage[key] for key in
                           ("generated_images", "input_images", "output_tokens", "total_tokens")
                           if type(usage.get(key)) is int and 0 <= usage[key] <= 10**12}
            encoded_usage = json_object(clean_usage, "上游用量信息", 4096)
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            job_record(row)
            connection.execute("""UPDATE jobs SET upstream_request_id = ?, usage_json = ?, updated_at = ?
                                  WHERE id = ?""",
                               (upstream_request_id or row["upstream_request_id"],
                                row["usage_json"] if encoded_usage is None else encoded_usage, now(), job_id))

    def complete_generation(self, job_id, artifact: dict):
        with self.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            job_record(job)
            if job["status"] == "succeeded":
                return artwork_record(connection.execute("SELECT * FROM artworks WHERE job_id = ?", (job_id,)).fetchone())
            if job["status"] not in ("queued", "running"):
                raise DomainError(409, "job_closed", "任务已结束或正等待老师核对。")
            if not isinstance(artifact, dict):
                raise DomainError(400, "invalid_artifact", "作品元信息格式不正确。")
            image_path = text_value(artifact.get("image_path"), "作品图片路径", 4096, False)
            mime = artifact.get("mime")
            if mime not in ("image/png", "image/jpeg", "image/webp"):
                raise DomainError(400, "invalid_artifact", "作品图片格式不受支持。")
            width, height = artifact.get("width"), artifact.get("height")
            if any(type(value) is not int or not 1 <= value <= 20000 for value in (width, height)):
                raise DomainError(400, "invalid_artifact", "作品图片尺寸不正确。")
            description = text_value(artifact.get("description", ""), "作品说明", 5000)
            reflection = text_value(artifact.get("reflection", ""), "作品反思", 5000)
            artwork_id, timestamp = new_id(), now()
            connection.execute("INSERT INTO artworks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (artwork_id, job["user_id"], job_id, job["plan_id"], job["snapshot_title"], image_path,
                 mime, width, height, job["prompt"], job["snapshot_answers"], description, reflection, timestamp))
            connection.execute("UPDATE users SET credits = credits - 1, reserved_credits = reserved_credits - 1 WHERE id = ?",
                               (job["user_id"],))
            connection.execute("UPDATE jobs SET status = 'succeeded', artwork_id = ?, error_message = NULL, updated_at = ? WHERE id = ?",
                               (artwork_id, timestamp, job_id))
            self._ledger_in(connection, job["user_id"], "consume", -1, job_id, "单张作品生成成功，扣除1点算力")
            return artwork_record(connection.execute("SELECT * FROM artworks WHERE id = ?", (artwork_id,)).fetchone())

    def fail_generation(self, job_id, message, uncertain=False):
        if type(uncertain) is not bool:
            raise DomainError(400, "invalid_input", "任务状态格式不正确。")
        message = text_value(message, "任务说明", 1000) or "生成未完成，请联系老师。"
        with self.transaction() as connection:
            job = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            job_record(job)
            # 终态或待核对状态的迟到回调不会二次扣除或释放预占。
            if job["status"] not in ("queued", "running"):
                return
            status = "uncertain" if uncertain else "failed"
            connection.execute("UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?",
                               (status, message, now(), job_id))
            if not uncertain:
                connection.execute("UPDATE users SET reserved_credits = reserved_credits - 1 WHERE id = ?", (job["user_id"],))
            self._ledger_in(connection, job["user_id"], "freeze" if uncertain else "release", 0, job_id,
                            "结果待核对，保留预留的1点算力" if uncertain else "生成明确失败，不扣算力，已释放预留的1点算力")

    def list_uncertain_jobs(self):
        with self.connection() as connection:
            return [job_record(row) for row in connection.execute(
                "SELECT * FROM jobs WHERE status = 'uncertain' ORDER BY created_at, rowid")]

    def resolve_uncertain_job(self, job_id, consume, admin_user_id, reason):
        if type(consume) is not bool:
            raise DomainError(400, "invalid_input", "请选择扣除或返还算力。")
        reason = text_value(reason, "核对原因", 1000, False)
        with self.transaction() as connection:
            admin = self._user_in(connection, admin_user_id)
            if admin["role"] != "admin":
                raise DomainError(403, "admin_required", "仅管理员可以核对生成结果。")
            job = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            job_record(job)
            if job["status"] != "uncertain":
                raise DomainError(409, "job_already_resolved", "该任务无需核对或已经完成核对。")
            connection.execute("UPDATE users SET credits = credits - ?, reserved_credits = reserved_credits - 1 WHERE id = ?",
                               (int(consume), job["user_id"]))
            connection.execute("UPDATE jobs SET status = 'settled', updated_at = ? WHERE id = ?", (now(), job_id))
            connection.execute("INSERT INTO audit VALUES (?,?,?,?,?,?)",
                               (new_id(), job_id, admin_user_id, int(consume), reason, now()))
            self._ledger_in(connection, job["user_id"], "manual_consume" if consume else "manual_release",
                            -1 if consume else 0, job_id, f"老师核对：{reason}")

    def mark_interrupted_jobs_uncertain(self):
        with self.transaction() as connection:
            jobs = connection.execute("SELECT * FROM jobs WHERE status IN ('queued','running')").fetchall()
            for job in jobs:
                connection.execute("UPDATE jobs SET status = 'uncertain', error_message = ?, updated_at = ? WHERE id = ?",
                                   ("服务已重启，生成结果待老师核对。", now(), job["id"]))
                self._ledger_in(connection, job["user_id"], "freeze", 0, job["id"], "服务重启，保留预留的1点算力等待老师核对")
