"""TIPHYS spatial engine — FastAPI + MCP tools (M2-lite).

Start:
  npm run engine
  # MCP stdio (spawned by agent):
  engine/.venv/bin/python -m mcp_server   # from engine/ dir; Windows uses Scripts/python.exe
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from security import ALLOWED_ORIGINS, service_token

from geo_ops import start_buffer_job
from jobs import JobRegistry
from layers import LayerStore

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("TIPHYS_DATA_DIR", ROOT / "data"))
STORE = LayerStore(DATA_DIR)
JOBS = JobRegistry(state_path=DATA_DIR / "jobs.json")
TOKEN = service_token()

import contextlib


@contextlib.asynccontextmanager
async def _lifespan(_app):
    m = globals().get("mcp")
    if m is not None:
        async with m.session_manager.run():
            try:
                yield
            finally:
                JOBS.close()
    else:
        try:
            yield
        finally:
            JOBS.close()


app = FastAPI(title="tiphys-engine", version="0.2.0", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def local_access(request, call_next):
    origin = request.headers.get("origin")
    if origin and origin not in ALLOWED_ORIGINS:
        return JSONResponse({"error": "untrusted origin"}, status_code=403)
    if request.method != "OPTIONS" and request.url.path != "/ping":
        bearer = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not secrets.compare_digest(bearer, TOKEN):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


class AddDataBody(BaseModel):
    path: str
    name: str | None = None
    source_crs: str | None = None


class BufferBody(BaseModel):
    layer: str
    distance: float
    units: str = "meters"
    dissolve: bool = False
    output_name: str | None = None
    async_job: bool = True


@app.get("/ping")
def ping() -> dict[str, object]:
    return {"ok": True, "service": "tiphys-engine", "version": "0.2.0"}


@app.get("/layers")
def list_layers() -> dict[str, Any]:
    return {"layers": STORE.list()}


@app.get("/layers/{layer_id}.geojson")
def get_layer_geojson(layer_id: str) -> FileResponse:
    L = STORE.get(layer_id)
    if not L or not L.path or not Path(L.path).exists():
        raise HTTPException(404, "layer not found")
    return FileResponse(L.path, media_type="application/geo+json")


@app.get("/layers/{layer_id}/describe")
def describe_layer_http(layer_id: str) -> dict[str, Any]:
    try:
        return STORE.describe(layer_id)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


@app.post("/layers/add")
def add_data_http(body: AddDataBody) -> dict[str, Any]:
    try:
        return {"ok": True, "layer": STORE.add_from_path(body.path, name=body.name, source_crs=body.source_crs)}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        raise HTTPException(400, str(e)) from e


@app.post("/tools/buffer")
def buffer_http(body: BufferBody) -> dict[str, Any]:
    try:
        if body.async_job:
            return start_buffer_job(
                STORE,
                JOBS,
                body.layer,
                body.distance,
                units=body.units,
                dissolve=body.dissolve,
                output_name=body.output_name,
            )
        from geo_ops import buffer_sync

        return buffer_sync(
            STORE,
            body.layer,
            body.distance,
            units=body.units,
            dissolve=body.dissolve,
            output_name=body.output_name,
        )
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        raise HTTPException(400, str(e)) from e


@app.get("/jobs/{job_id}")
def job_status_http(job_id: str) -> dict[str, Any]:
    try:
        return JOBS.status(job_id)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


@app.post("/jobs/{job_id}/cancel")
def job_cancel_http(job_id: str) -> dict[str, Any]:
    try:
        return JOBS.cancel(job_id)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


@app.get("/workspace")
def workspace_snapshot() -> dict[str, Any]:
    snap = STORE.snapshot()
    snap["pending_jobs"] = JOBS.pending_ids()
    return snap


# ---------------------------------------------------------------------------
# MCP (streamable HTTP mounted at /mcp) — same tools as stdio server
# ---------------------------------------------------------------------------
try:
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP(
        "tiphys-engine",
        instructions=(
            "TIPHYS spatial engine tools. Use add_data to load local GeoJSON/shp, "
            "buffer to start a long job (returns job_id; poll job_status), "
            "list_layers / describe_layer for workspace state."
        ),
        host="127.0.0.1",
        port=8971,
        streamable_http_path="/",
        stateless_http=True,
    )

    from tools import register_tools

    register_tools(mcp, STORE, JOBS)

    # Mount streamable HTTP app under /mcp
    app.mount("/mcp", mcp.streamable_http_app())
except Exception as _mcp_err:  # noqa: BLE001 — keep FastAPI up if MCP optional deps fail
    import sys

    print(f"[tiphys-engine] MCP mount skipped: {_mcp_err}", file=sys.stderr)
