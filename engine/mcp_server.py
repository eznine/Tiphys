"""Stdio MCP entry for the TIPHYS engine (spawned by the agent sidecar).

Shares STORE/JOBS with the FastAPI process only when run in-process.
When spawned as a separate process, this is a standalone MCP server with
its own layer/job state — prefer the HTTP /mcp mount on the running engine,
or point tools at the FastAPI REST API.

For the agent, we use HTTP tools against the live engine (:8765) by default;
this stdio server is available for `npx @modelcontextprotocol/inspector` demos.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure engine/ is on path when run as script
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcp.server.fastmcp import FastMCP

from geo_ops import start_buffer_job
from jobs import JobRegistry
from layers import LayerStore

STORE = LayerStore(Path(__file__).resolve().parent / "data")
JOBS = JobRegistry()

mcp = FastMCP(
    "tiphys-engine",
    instructions="TIPHYS spatial engine (stdio). Prefer connecting to the live FastAPI /mcp when engine is running.",
)


@mcp.tool()
def ping() -> dict:
    """Health check."""
    return {"ok": True, "service": "tiphys-engine", "transport": "stdio"}


@mcp.tool()
def list_layers() -> dict:
    """List layers in this MCP process workspace."""
    return {"layers": STORE.list()}


@mcp.tool()
def add_data(path: str, name: str | None = None) -> dict:
    """Load local GeoJSON/shp into the workspace."""
    return {"ok": True, "layer": STORE.add_from_path(path, name=name)}


@mcp.tool()
def describe_layer(layer: str) -> dict:
    """Describe a layer by id or name."""
    return STORE.describe(STORE.resolve(layer))


@mcp.tool()
def buffer(
    layer: str,
    distance: float,
    units: str = "meters",
    dissolve: bool = False,
    output_name: str | None = None,
) -> dict:
    """Start a buffer job; returns job_id. Poll job_status."""
    return start_buffer_job(
        STORE, JOBS, layer, distance, units=units, dissolve=dissolve, output_name=output_name
    )


@mcp.tool()
def job_status(job_id: str) -> dict:
    """Poll job progress / result."""
    return JOBS.status(job_id)


@mcp.tool()
def job_cancel(job_id: str) -> dict:
    """Cancel a job."""
    return JOBS.cancel(job_id)


if __name__ == "__main__":
    mcp.run(transport="stdio")
