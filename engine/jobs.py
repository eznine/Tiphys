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
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    _cancel: threading.Event = field(default_factory=threading.Event)
    _future: Future | None = field(default=None, repr=False)


class JobRegistry:
    def __init__(self, max_workers: int = 2) -> None:
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="tiphys-job")
        self._listeners: list[Callable[[dict[str, Any]], None]] = []

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

        def run() -> None:
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
                if job._cancel.is_set():
                    job.status = "cancelled"
                    job.message = "cancelled"
                else:
                    job.status = "completed"
                    job.progress = 1.0
                    job.result = result
                    job.message = job.message or "done"
            except InterruptedError:
                job.status = "cancelled"
                job.message = "cancelled"
            except Exception as e:
                job.status = "failed"
                job.error = str(e)
                job.message = str(e)
            job.updated_at = time.time()
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
            }

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(f"unknown job: {job_id}")
            job._cancel.set()
            if job.status in ("queued", "running"):
                job.status = "cancelled"
                job.message = "cancel requested"
                job.updated_at = time.time()
            return self.status(job_id)

    def pending_ids(self) -> list[str]:
        with self._lock:
            return [j.id for j in self._jobs.values() if j.status in ("queued", "running")]
