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

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from security import ALLOWED_ORIGINS, service_token
from diagnostics import record, read_entries

from geo_ops import start_buffer_job, start_zonal_statistics_job
from jobs import JobRegistry
from layers import LayerStore

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("TIPHYS_DATA_DIR", ROOT / "data"))
STORE = LayerStore(DATA_DIR)
JOBS = JobRegistry(state_path=DATA_DIR / "jobs.json")
JOBS.on_event(lambda event: record("job", f"{event.get('job_id')} · {event.get('status', event['type'])}", event,
                                 "error" if event.get("status") == "failed" else "info"))
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


class ZonalStatisticsBody(BaseModel):
    layer: str
    zones_layer: str
    statistic: str = "mean"
    value_field: str | None = None
    ignore_nodata: bool = True
    output_name: str | None = None
    async_job: bool = True


class ToolRunBody(BaseModel):
    name: str
    arguments: dict[str, Any] = {}


class RenameFieldBody(BaseModel):
    field: str
    new_field: str


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


@app.post("/layers/{layer_id}/reload")
def reload_layer_http(layer_id: str) -> dict[str, Any]:
    try:
        layer = STORE.reload(layer_id)
        return {"ok": True, "reloaded": layer_id, "layer": layer,
                "reloaded_from": layer.get("source_path"),
                "message": "已重新读取原始文件并保留图层 ID、名称与工作区顺序。"}
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        raise HTTPException(400, str(e)) from e


@app.get("/layers/{layer_id}/download")
def download_layer_http(layer_id: str) -> FileResponse:
    layer = STORE.get(layer_id)
    if not layer:
        raise HTTPException(404, "layer not found")
    dataset = Path(layer.meta["dataset_path"])
    if not dataset.is_file():
        raise HTTPException(404, "layer work copy is missing")
    suffix = dataset.suffix.lower()
    media_type = "image/tiff" if suffix in {".tif", ".tiff"} else "application/octet-stream"
    return FileResponse(dataset, media_type=media_type, filename=f"{layer.name}{suffix}")


@app.post("/layers/add")
def add_data_http(body: AddDataBody) -> dict[str, Any]:
    try:
        return {"ok": True, "layer": STORE.add_from_path(body.path, name=body.name, source_crs=body.source_crs)}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        raise HTTPException(400, str(e)) from e


@app.get("/layers/{layer_id}/attributes")
def layer_attributes(layer_id: str, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500),
                     search: str = "", sort: str | None = None, descending: bool = False,
                     filter_field: str = "", filter_op: str = "", filter_value: str | None = None) -> dict[str, Any]:
    """Paged attributes from the analysis dataset with a single-field definition query."""
    try:
        return STORE.attributes_page(layer_id, offset=offset, limit=limit, search=search, sort=sort,
                                     descending=descending, filter_field=filter_field,
                                     filter_op=filter_op, filter_value=filter_value)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/layers/{layer_id}/attributes/rename-field")
def rename_field_http(layer_id: str, body: RenameFieldBody) -> dict[str, Any]:
    """Rename a vector field in the layer's managed analysis work copy."""
    try:
        return STORE.rename_field(layer_id, body.field, body.new_field)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/layers/import")
async def import_vector(request: Request, filename: str, source_crs: str | None = None) -> dict[str, Any]:
    """Browser file picker upload; desktop uses native paths through add_data."""
    import tempfile
    import geopandas as gpd

    suffix = Path(filename).suffix.lower()
    if suffix not in (".geojson", ".json", ".gpkg", ".zip", ".fgb", ".kml"):
        raise HTTPException(400, "Use GeoJSON/GPKG/FGB/KML, or a ZIP containing a shapefile")
    try:
        with tempfile.TemporaryDirectory(prefix="tiphys-import-") as tmp:
            target = Path(tmp) / f"input{suffix}"
            size = 0
            with target.open("wb") as stream:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 128 * 1024 * 1024:
                        raise HTTPException(413, "Browser imports are limited to 128 MiB; use the desktop file picker")
                    stream.write(chunk)
            frame = gpd.read_file(target)
            if source_crs:
                if frame.crs is not None and frame.crs != source_crs:
                    raise ValueError("Dataset already has a different CRS; reproject rather than relabel it")
                frame = frame.set_crs(source_crs)
            return {"ok": True, "layer": STORE.add_gdf(frame, name=Path(filename).stem)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e)) from e


@app.get("/layers/{layer_id}/field-values")
def layer_field_values(layer_id: str, field: str, limit: int = Query(20, ge=1, le=64)) -> dict[str, Any]:
    frame = STORE.get_gdf(layer_id)
    if frame is None:
        raise HTTPException(404, "layer not found")
    if field not in frame.columns or field == frame.geometry.name:
        raise HTTPException(400, "unknown attribute field")
    counts = frame[field].value_counts(dropna=False)
    rows = counts.head(limit).rename_axis("value").reset_index(name="count")
    return {"field": field, "unique_count": len(counts),
            "values": json.loads(rows.to_json(orient="records", date_format="iso"))}


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


@app.post("/tools/zonal_statistics")
def zonal_statistics_http(body: ZonalStatisticsBody) -> dict[str, Any]:
    try:
        if body.async_job:
            return start_zonal_statistics_job(
                STORE,
                JOBS,
                body.layer,
                body.zones_layer,
                statistic=body.statistic,
                value_field=body.value_field,
                ignore_nodata=body.ignore_nodata,
                output_name=body.output_name,
            )
        from geo_ops import zonal_statistics_sync

        return zonal_statistics_sync(
            STORE,
            body.layer,
            body.zones_layer,
            body.statistic,
            value_field=body.value_field,
            ignore_nodata=body.ignore_nodata,
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


@app.get("/tools/catalog")
async def tools_catalog() -> dict[str, Any]:
    """Tool catalog mirrored from the MCP registration (same list the Agent sees)."""
    m = globals().get("mcp")
    if m is None:
        return {"tools": []}
    listed = await m.list_tools()
    from tools import TOOL_GROUPS
    return {
        "tools": [
            {"name": t.name, "description": t.description or "", "parameters": t.inputSchema,
             "category": next((group for group, names in TOOL_GROUPS.items() if t.name in names), "其他工具"),
             "annotations": t.annotations.model_dump(exclude_none=True) if t.annotations else {}}
            for t in listed
        ]
    }


@app.post("/tools/run")
async def tools_run(body: ToolRunBody) -> dict[str, Any]:
    """Manual calls use the same validated MCP functions as Agent calls."""
    record("tool-call", body.name, body.arguments)
    try:
        if body.name not in {t.name for t in await mcp.list_tools()}:
            raise HTTPException(404, f"unknown tool: {body.name}")
        _, result = await mcp.call_tool(body.name, body.arguments)
        record("tool-result", body.name, result)
        return result
    except HTTPException:
        record("tool-error", body.name, "Unknown tool", "error")
        raise
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        record("tool-error", body.name, str(e), "error")
        raise HTTPException(400, str(e)) from e


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


@app.get("/diagnostics")
def diagnostics() -> dict[str, Any]:
    return {"entries": read_entries(), "pending_jobs": JOBS.pending_ids(), "layer_count": len(STORE.list())}


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
