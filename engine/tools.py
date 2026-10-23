"""One MCP tool contract shared by HTTP and standalone stdio transports."""
from typing import Any
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from geo_ops import start_buffer_job
from jobs import JobRegistry
from layers import LayerStore


def register_tools(mcp: FastMCP, store: LayerStore, jobs: JobRegistry) -> None:
    @mcp.tool()
    def ping() -> dict[str, Any]:
        """Health check for the TIPHYS spatial engine."""
        return {"ok": True, "service": "tiphys-engine"}

    @mcp.tool()
    def list_layers() -> dict[str, Any]:
        """List layers currently loaded in the GIS workspace."""
        return {"layers": store.list()}

    @mcp.tool()
    def add_data(path: str, name: str | None = None, source_crs: str | None = None) -> dict[str, Any]:
        """Load a local GeoJSON or shapefile into the workspace and return layer info + URL for the map.

        Args:
            path: Absolute or project-relative path to GeoJSON / shapefile.
            name: Optional layer display name (defaults to file stem).
            source_crs: Required if the source has no CRS; never guessed.
        """
        layer = store.add_from_path(path, name=name, source_crs=source_crs)
        return {"ok": True, "layer": layer}

    @mcp.tool()
    def describe_layer(layer: str) -> dict[str, Any]:
        """Describe a layer: CRS, bounds, columns, sample rows.

        Args:
            layer: Layer id or name.
        """
        lid = store.resolve(layer)
        return store.describe(lid)

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
            store,
            jobs,
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
        return jobs.status(job_id)

    @mcp.tool()
    def job_cancel(job_id: str) -> dict[str, Any]:
        """Request cancellation of a running job.

        Args:
            job_id: Job to cancel.
        """
        return jobs.cancel(job_id)

    @mcp.tool(annotations=ToolAnnotations(destructiveHint=True, readOnlyHint=False))
    def remove_layer(layer: str) -> dict[str, Any]:
        """DESTRUCTIVE: remove a layer from the workspace and delete its file. Requires user approval.

        Args:
            layer: Layer id or name.
        """
        return store.remove(layer)

