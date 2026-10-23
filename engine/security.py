"""Shared local service credential; never put it in URLs or logs."""
import os
import secrets
from pathlib import Path

ALLOWED_ORIGINS = {"http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost",
                   "http://tauri.localhost", "https://tauri.localhost"}


def service_token() -> str:
    if os.environ.get("TIPHYS_SERVICE_TOKEN"):
        return os.environ["TIPHYS_SERVICE_TOKEN"]
    root = Path(os.environ.get("TIPHYS_STATE_DIR", Path(__file__).resolve().parent.parent / ".tiphys"))
    root.mkdir(parents=True, exist_ok=True)
    p = root / "service-token"
    try:
        with p.open("x", encoding="utf-8") as f:
            os.chmod(p, 0o600)
            f.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    value = p.read_text(encoding="utf-8").strip()
    if len(value) < 32:
        raise ValueError("Invalid local service token")
    return value
