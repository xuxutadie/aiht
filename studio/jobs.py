"""后台生成任务：预占一次、单次上游调用、结果明确后结算。"""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import logging
import hashlib
import json
import os
import re
import threading
import uuid

from .contracts import DomainError, MODEL_DEFAULT
from .plans import build_prompt, build_summary
from .provider import ProviderError
from .secrets import BASE_URL_DEFAULT, validate_base_url, config_fingerprint

LOGGER = logging.getLogger("creation.jobs")


class JobManager:
    def __init__(self, store, provider, settings, data_dir: Path):
        self.store, self.provider, self.settings = store, provider, settings
        self.artwork_dir = Path(data_dir) / "artworks"
        self.artwork_dir.mkdir(parents=True, exist_ok=True)
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="draw")
        self.lock = threading.Lock()
        self.scheduled = set()
        self.futures = {}
        self.closed = False

    def submit(self, user_id: str, plan_id: str, request_key: str):
        if not isinstance(request_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", request_key):
            raise DomainError(400, "invalid_request_key", "生成请求编号不正确，请刷新页面后重新确认。")
        if not isinstance(plan_id, str) or not 1 <= len(plan_id) <= 100:
            raise DomainError(400, "invalid_plan", "请选择有效的创作方案。")
        # 网络断开后的原请求查找优先，不要求旧方案仍已确认或接口配置仍启用。
        existing = self.store.get_job_by_request(user_id, request_key)
        if existing is not None:
            if existing["plan_id"] != plan_id:
                raise DomainError(409, "request_conflict", "这个请求编号已用于其他方案，请先核对原任务。")
            return existing
        plan = self.store.get_plan(user_id, plan_id)
        if not plan["confirmed"]:
            raise DomainError(409, "plan_not_confirmed", "请先完成并确认创作方案。")
        prompt = build_prompt(plan["answers"])
        # 在预占前只读取一次完整配置；任务仅保存不可逆指纹，不保存明文密钥。
        config = self.settings.get()
        if not isinstance(config, dict) or not config.get("api_key"):
            raise DomainError(409, "generation_not_configured", "绘图服务尚未配置，请联系老师。")
        service_fingerprint = config_fingerprint(config)
        options = {"ratio": plan["answers"]["ratio"], "style": plan["answers"]["style"],
                   "base_url": validate_base_url(config.get("base_url", BASE_URL_DEFAULT)),
                   "model": config.get("model", MODEL_DEFAULT), "watermark": config.get("watermark", True),
                   "quality": config.get("quality", "low"), "config_fingerprint": service_fingerprint}
        encoded = json.dumps({"title": plan["title"], "answers": plan["answers"]},
                             ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        fingerprint = hashlib.sha256(encoded).hexdigest()
        job = self.store.reserve_generation(user_id, plan_id, request_key, prompt, options,
                                            expected_plan_hash=fingerprint)
        with self.lock:
            if self.closed:
                self.store.fail_generation(job["id"], "服务正在关闭，本次尚未发送绘图请求，算力不扣除。")
                return self.store.get_job(user_id, job["id"])
            if job["status"] == "queued" and job["id"] not in self.scheduled:
                self.scheduled.add(job["id"])
                try:
                    self.futures[job["id"]] = self.executor.submit(self._run, job["id"])
                except RuntimeError:
                    self.store.fail_generation(job["id"], "服务正在关闭，请稍后重新生成。")
                    self.scheduled.discard(job["id"])
        return self.store.get_job(user_id, job["id"])

    def _run(self, job_id: str):
        temporary = None
        try:
            with self.lock:
                if self.closed:
                    self.store.fail_generation(job_id, "服务正在关闭，本次尚未发送绘图请求，算力不扣除。")
                    return
                if not self.store.mark_job_running(job_id):
                    return
            job = self.store.get_job_internal(job_id)
            image = self.provider.generate(job["prompt"], job["options"])
            self.store.record_provider_result(job_id, image.upstream_request_id, image.usage)
            extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(image.mime)
            if not extension:
                raise ProviderError("绘图服务返回了不支持的图片格式，请联系老师核对。", uncertain=True)
            filename = uuid.uuid4().hex + extension
            destination = self.artwork_dir / filename
            temporary = self.artwork_dir / (filename + ".partial")
            with temporary.open("xb") as handle:
                handle.write(image.data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
            self.store.complete_generation(job_id, {
                "image_path": filename, "mime": image.mime, "width": image.width, "height": image.height,
                "title": job["title"], "prompt": job["prompt"], "answers": job["answers"],
                "description": build_summary(job["answers"]), "reflection": "",
            })
        except ProviderError as error:
            self.store.record_provider_result(job_id, error.request_id)
            self.store.fail_generation(job_id, error.message, uncertain=error.uncertain)
        except Exception:
            # 原始异常可能含本地路径或上游信息，不向学生返回，也不自动再调付费接口。
            LOGGER.error("生成任务出现内部异常，任务=%s，已转待核对", job_id)
            self.store.fail_generation(job_id, "生成结果需要老师核对，请勿重复提交。", uncertain=True)
        finally:
            if temporary is not None and temporary.exists():
                try:
                    temporary.unlink()
                except OSError:
                    pass
            with self.lock:
                self.scheduled.discard(job_id)
                self.futures.pop(job_id, None)

    def close(self):
        with self.lock:
            self.closed = True
            canceled = [job_id for job_id, future in self.futures.items() if future.cancel()]
            for job_id in canceled:
                self.store.fail_generation(job_id, "服务已关闭，本次尚未发送绘图请求，算力不扣除。")
                self.scheduled.discard(job_id)
        # 等已发出的请求完成结算后，Application才能释放数据库实例锁。
        self.executor.shutdown(wait=True, cancel_futures=True)
