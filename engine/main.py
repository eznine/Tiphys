"""TIPHYS spatial engine — FastAPI + MCP tools (M2-lite).

Start:
  npm run engine
  # MCP stdio (spawned by agent):
  engine/.venv/bin/python -m mcp_server   # from engine/ dir (Windows: engine\.venv\Scripts\python -m mcp_server)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from geo_ops import start_buffer_job
from jobs import JobRegistry
from layers import LayerStore

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
STORE = LayerStore(DATA_DIR)
JOBS = JobRegistry()

import contextlib


@contextlib.asynccontextmanager
async def _lifespan(_app):
    m = globals().get("mcp")
    if m is not None:
        async with m.session_manager.run():
            yield
    else:
        yield


app = FastAPI(title="tiphys-engine", version="0.2.0", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class AddDataBody(BaseModel):
    path: str
    name: str | None = None


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
        return {"ok": True, "layer": STORE.add_from_path(body.path, name=body.name)}
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
        port=8765,
        streamable_http_path="/",
        stateless_http=True,
    )

    @mcp.tool()
    def ping() -> dict[str, Any]:
        """Health check for the TIPHYS spatial engine."""
        return {"ok": True, "service": "tiphys-engine"}

    @mcp.tool()
    def list_layers() -> dict[str, Any]:
        """List layers currently loaded in the GIS workspace."""
        return {"layers": STORE.list()}

    @mcp.tool()
    def add_data(path: str, name: str | None = None) -> dict[str, Any]:
        """Load a local GeoJSON or shapefile into the workspace and return layer info + URL for the map.

        Args:
            path: Absolute or project-relative path to GeoJSON / shapefile.
            name: Optional layer display name (defaults to file stem).
        """
        layer = STORE.add_from_path(path, name=name)
        return {"ok": True, "layer": layer}

    @mcp.tool()
    def describe_layer(layer: str) -> dict[str, Any]:
        """Describe a layer: CRS, bounds, columns, sample rows.

        Args:
            layer: Layer id or name.
        """
        lid = STORE.resolve(layer)
        return STORE.describe(lid)

    @mcp.tool()
    def buffer(
        layer: str,
        distance: float,
        units: str = "meters",
        dissolve: bool = False,
        output_name: str | None = None,
    ) -> dict[str, Any]:
        """Buffer a layer (geopandas). Returns a job_id immediately; poll job_status / job_cancel.

        Parameter shape follows RustGIS analysis buffer (input/distance/units/dissolve/output)
        and GeoLibre unit names (meters|kilometers|miles). Implementation is geopandas.

        Args:
            layer: Source layer id or name.
            distance: Buffer distance.
            units: meters (default), kilometers, or miles.
            dissolve: Merge all buffers into one polygon.
            output_name: Optional output layer name.
        """
        return start_buffer_job(
            STORE,
            JOBS,
            layer,
            distance,
            units=units,
            dissolve=dissolve,
            output_name=output_name,
        )

    @mcp.tool()
    def job_status(job_id: str) -> dict[str, Any]:
        """Get status/progress/result of a long-running job.

        Args:
            job_id: Id returned by buffer (or other async tools).
        """
        return JOBS.status(job_id)

    @mcp.tool()
    def job_cancel(job_id: str) -> dict[str, Any]:
        """Request cancellation of a running job.

        Args:
            job_id: Job to cancel.
        """
        return JOBS.cancel(job_id)

    @mcp.tool()
    def remove_layer(layer: str) -> dict[str, Any]:
        """DESTRUCTIVE: remove a layer from the workspace and delete its file. Requires user approval.

        Args:
            layer: Layer id or name.
        """
        return STORE.remove(layer)

    # Mount streamable HTTP app under /mcp
    app.mount("/mcp", mcp.streamable_http_app())
except Exception as _mcp_err:  # noqa: BLE001 — keep FastAPI up if MCP optional deps fail
    import sys

    print(f"[tiphys-engine] MCP mount skipped: {_mcp_err}", file=sys.stderr)
