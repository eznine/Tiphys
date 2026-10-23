"""Bounded structured operation logs for manual tools and background jobs."""
import json
import logging
import os
import re
import time
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_PATH = Path(os.environ.get("TIPHYS_DATA_DIR", Path(__file__).resolve().parent / "data")) / "operations.jsonl"
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logger = logging.getLogger("tiphys.operations")
logger.setLevel(logging.INFO)
logger.propagate = False
if not logger.handlers:
    logger.addHandler(RotatingFileHandler(LOG_PATH, maxBytes=2_000_000, backupCount=1, encoding="utf-8"))


def redact(value):
    if isinstance(value, dict):
        return {k: "[REDACTED]" if re.search(r"api.?key|authorization|token|password|secret", k, re.I) else redact(v)
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return re.sub(r"Bearer\s+[^\s\"']+|\bsk-[A-Za-z0-9_-]+", "[REDACTED]", value)[:12000]
    return value


def record(kind: str, summary: str, detail, level: str = "info") -> None:
    try:
        logger.info(json.dumps({"id": f"engine-{uuid.uuid4().hex}", "ts": int(time.time() * 1000),
                               "source": "Engine", "kind": kind, "level": level,
                               "summary": redact(summary), "detail": redact(detail)}, ensure_ascii=False, default=str))
    except Exception:
        logger.exception("Unable to write operation log")


def read_entries() -> list[dict]:
    entries = []
    for log_path in (LOG_PATH.with_name(LOG_PATH.name + ".1"), LOG_PATH):
        if not log_path.exists():
            continue
        with log_path.open("rb") as stream:
            stream.seek(max(0, log_path.stat().st_size - 512000))
            for line in stream.read().decode("utf-8", errors="replace").splitlines():
                try:
                    entries.append(json.loads(line))
                except ValueError:
                    pass
    return entries[-500:]
