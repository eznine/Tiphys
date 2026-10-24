"""Background job registry (M2-lite).

Inspired by deepseek-harness `@deepseek-ai/dsh-jobs` surface:
  - tools return job_id immediately
  - job_status / job_cancel
  - progress events
  - no fixed short timeout

This is a thin in-process skeleton, not a port of dsh-jobs.
See THIRD_PARTY_NOTICES.md / docs/AGENT_ARCH.md.
"""

from __future__ import annotations

import threading
import time
import uuid
import json
from pathlib import Path
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class Job:
    id: str
    kind: str
    label: str
    status: str  # queued | running | completed | cancelled | failed
    progress: float = 0.0
    message: str = ""
    result: dict[str, Any] | None = None
    error: str | None = None
    # Unified cross-engine error taxonomy (shared/contracts ErrorClass, frozen in stage 1).
    error_class: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    _cancel: threading.Event = field(default_factory=threading.Event)
    _future: Future | None = field(default=None, repr=False)
    _committed: bool = False


ERROR_CLASSES = (
    "INPUT_ERROR",
    "UNSUPPORTED",
    "RESOURCE_LIMIT",
    "EXECUTION_ERROR",
    "VALIDATION_ERROR",
    "USER_CANCELLED",
)


def classify_error(message: str, *, cancelled: bool = False, timeout: bool = False) -> str:
    """Map an engine failure onto the taxonomy shared with the browser executor.

    Mirrors classifyError() in shared/plans.ts; keep both in sync when editing.
    """
    if cancelled:
        return "USER_CANCELLED"
    if timeout:
        return "RESOURCE_LIMIT"
    text = message or ""
    if any(k in text for k in ("已取消", "cancelled", "canceled", "abort")) or "abort" in text.lower():
        return "USER_CANCELLED"
    if any(k in text.lower() for k in ("timeout", "超时", "上限", "内存", "out of memory", "limit exceeded")):
        return "RESOURCE_LIMIT"
    if "验收" in text or "validation" in text.lower():
        return "VALIDATION_ERROR"
    if any(k in text for k in ("找不到图层", "找不到指定字段", "不合法", "无效", "必须是", "只适用", "请提供", "距离必须", "坐标系", "EPSG", "参数", "掩膜")):
        return "INPUT_ERROR"
    if any(k in text for k in ("不支持", "降级")) or "unsupported" in text.lower():
        return "UNSUPPORTED"
    return "EXECUTION_ERROR"


class JobRegistry:
    def __init__(self, max_workers: int = 2, state_path: Path | None = None) -> None:
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="tiphys-job")
        self._listeners: list[Callable[[dict[str, Any]], None]] = []
        self._state_path = state_path
        if state_path and state_path.exists():
            for row in json.loads(state_path.read_text(encoding="utf-8")):
                job = Job(**row)
                if job.status in ("queued", "running", "cancelling"):
                    job.status = "interrupted"
                    job.message = "Engine restarted before the job settled; inspect outputs before retrying"
                self._jobs[job.id] = job
            self._save()

    def _save(self) -> None:
        if self._state_path:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            rows = [{k: v for k, v in vars(j).items() if not k.startswith("_")} for j in self._jobs.values()]
            tmp = self._state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(rows, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            tmp.replace(self._state_path)

    def commit(self, job: Job, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        """Cancellation and publishing an output share one ordered commit boundary."""
        with self._lock:
            if job._cancel.is_set():
                raise InterruptedError("cancelled")
            result = fn()
            job.result = result
            job._committed = True
            job.status = "completed"
            job.progress = 1.0
            job.message = "done"
            self._save()
            return result

    def close(self) -> None:
        for jid in self.pending_ids():
            self.cancel(jid)
        self._pool.shutdown(wait=True, cancel_futures=True)

    def on_event(self, fn: Callable[[dict[str, Any]], None]) -> None:
        self._listeners.append(fn)

    def _emit(self, event: dict[str, Any]) -> None:
        for fn in list(self._listeners):
            try:
                fn(event)
            except Exception:
                pass

    def start(
        self,
        kind: str,
        label: str,
        worker: Callable[[Job, Callable[[float, str], None]], dict[str, Any]],
    ) -> dict[str, Any]:
        jid = f"job_{uuid.uuid4().hex[:10]}"
        job = Job(id=jid, kind=kind, label=label, status="queued")
        with self._lock:
            self._jobs[jid] = job
            self._save()

        def run() -> None:
            with self._lock:
                if job._cancel.is_set():
                    job.status = "cancelled"
                    self._save()
                    return
                job.status = "running"
                job.updated_at = time.time()
            self._emit({"type": "job_progress", "job_id": jid, "progress": 0.0, "message": "started", "status": "running"})

            def report(p: float, msg: str = "") -> None:
                if job._cancel.is_set():
                    raise InterruptedError("cancelled")
                job.progress = max(0.0, min(1.0, p))
                if msg:
                    job.message = msg
                job.updated_at = time.time()
                self._emit(
                    {
                        "type": "job_progress",
                        "job_id": jid,
                        "progress": job.progress,
                        "message": job.message,
                        "status": job.status,
                    }
                )

            try:
                result = worker(job, report)
                with self._lock:
                    if not job._committed:
                        if job._cancel.is_set():
                            job.status = "cancelled"
                            job.message = "cancelled"
                        else:
                            job.status = "completed"
                            job.progress = 1.0
                            job.result = result
                            job.message = "done"
            except InterruptedError:
                job.status = "cancelled"
                job.message = "cancelled"
                job.error_class = "USER_CANCELLED"
            except Exception as e:
                job.status = "failed"
                job.error = str(e)
                job.message = str(e)
                job.error_class = classify_error(str(e))
            job.updated_at = time.time()
            with self._lock:
                self._save()
            self._emit(
                {
                    "type": "job_progress",
                    "job_id": jid,
                    "progress": job.progress,
                    "message": job.message,
                    "status": job.status,
                    "result": job.result,
                    "error": job.error,
                }
            )

        job._future = self._pool.submit(run)
        self._emit({"type": "job_registered", "job_id": jid, "kind": kind, "label": label})
        return {"job_id": jid, "status": "queued", "kind": kind, "label": label}

    def status(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(f"unknown job: {job_id}")
            return {
                "job_id": job.id,
                "kind": job.kind,
                "label": job.label,
                "status": job.status,
                "progress": job.progress,
                "message": job.message,
                "result": job.result,
                "error": job.error,
                "error_class": job.error_class,
            }

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(f"unknown job: {job_id}")
            if job.status in ("queued", "running", "cancelling"):
                job._cancel.set()
                queued = job.status == "queued"
                job.status = "cancelled" if queued else "cancelling"
                if queued and job._future:
                    job._future.cancel()
                job.message = "cancel requested"
                job.updated_at = time.time()
                self._save()
            return self.status(job_id)

    def pending_ids(self) -> list[str]:
        with self._lock:
            return [j.id for j in self._jobs.values() if j.status in ("queued", "running", "cancelling")]
