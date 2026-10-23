"""Frozen engine entry point; datasets and credentials are supplied by the desktop host."""
import os
import uvicorn
from main import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TIPHYS_ENGINE_PORT", "8971")), log_level="warning")
