"""One tool implementation, two entries: MCP (Agent, natural language) and
manual ToolPanel via POST /tools/run. Contracts follow RustGIS
analysis tool shapes; implementations are GeoPandas in engine/geo_ops.py."""
from typing import Any, Literal, Annotated
from pydantic import Field
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
import geo_ops
from jobs import JobRegistry
from layers import LayerStore

TOOL_GROUPS = {
    "数据管理": ("add_data", "describe_layer", "rename_layer", "reorder_layers", "reproject", "export_features", "remove_layer"),
    "邻近分析": ("buffer",),
    "叠加分析": ("clip", "intersection", "union_layers", "erase"),
    "几何处理": ("dissolve", "convex_hull", "simplify", "calculate_geometry"),
    "查询与选择": ("select_by_attributes", "select_by_location", "field_statistics"),
    "地图与显示": ("zoom_to_layer", "open_attribute_table", "set_layer_symbology", "set_layer_labels"),
}

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
    def rename_layer(layer: str, name: str) -> dict[str, Any]:
        """Rename a layer's display name in the workspace. Does not alter analysis data.

        Args:
            layer: Layer id or name.
            name: New display name (must be unique, not empty).
        """
        return store.rename(layer, name)

    @mcp.tool()
    def reorder_layers(layer_ids: list[str]) -> dict[str, Any]:
        """Set the workspace layer order, which is also the map draw order (last = on top).

        Args:
            layer_ids: All existing layer ids, each exactly once, in the wanted order.
        """
        return store.reorder(layer_ids)

    @mcp.tool()
    def buffer(
        layer: str,
        distance: float,
        units: Literal["meters", "kilometers", "miles"] = "meters",
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
        return geo_ops.start_buffer_job(store, jobs, layer, distance, units=units, dissolve=dissolve, output_name=output_name)

    @mcp.tool()
    def clip(layer: str, mask_layer: str, output_name: str | None = None) -> dict[str, Any]:
        """Clip a layer by a mask layer (keeps this layer's attributes). Job-based.

        Args:
            layer: Layer id or name to clip.
            mask_layer: Layer id or name whose extent cuts the input.
            output_name: Optional output layer name.
        """
        return geo_ops.start_overlay_job(store, jobs, "clip", layer, mask_layer, output_name=output_name)

    @mcp.tool()
    def intersection(layer: str, other_layer: str, output_name: str | None = None) -> dict[str, Any]:
        """Intersection of two layers; attributes combine. Job-based.

        Args:
            layer: First layer id or name.
            other_layer: Second layer id or name.
            output_name: Optional output layer name.
        """
        return geo_ops.start_overlay_job(store, jobs, "intersection", layer, other_layer, output_name=output_name)

    @mcp.tool()
    def union_layers(layer: str, other_layer: str, output_name: str | None = None) -> dict[str, Any]:
        """Union of two overlapping polygon layers; attributes combine. Job-based.

        Args:
            layer: First layer id or name.
            other_layer: Second layer id or name.
            output_name: Optional output layer name.
        """
        return geo_ops.start_overlay_job(store, jobs, "union", layer, other_layer, output_name=output_name)

    @mcp.tool()
    def erase(layer: str, mask_layer: str, output_name: str | None = None) -> dict[str, Any]:
        """Erase (difference): keep parts of the layer outside the mask layer. Job-based.

        Args:
            layer: Layer id or name to erase from.
            mask_layer: Layer whose extent is removed.
            output_name: Optional output layer name.
        """
        return geo_ops.start_overlay_job(store, jobs, "difference", layer, mask_layer, output_name=output_name)

    @mcp.tool()
    def dissolve(layer: str, by_field: str | None = None, output_name: str | None = None) -> dict[str, Any]:
        """Dissolve features into fewer geometries, optionally grouped by a field. Job-based.

        Args:
            layer: Layer id or name.
            by_field: Optional column to group by (omitted = merge everything).
            output_name: Optional output layer name.
        """
        return geo_ops.start_dissolve_job(store, jobs, layer, by_field=by_field, output_name=output_name)

    @mcp.tool()
    def convex_hull(layer: str, output_name: str | None = None) -> dict[str, Any]:
        """Convex hull of all features as one polygon. Job-based.

        Args:
            layer: Layer id or name.
            output_name: Optional output layer name.
        """
        return geo_ops.start_convex_hull_job(store, jobs, layer, output_name=output_name)

    @mcp.tool()
    def simplify(layer: str, tolerance: float, units: Literal["meters", "kilometers", "miles"] = "meters", output_name: str | None = None) -> dict[str, Any]:
        """Topology-preserving simplify with a metre tolerance (checked local UTM). Job-based.

        Args:
            layer: Layer id or name.
            tolerance: Simplification tolerance (> 0).
            units: meters (default), kilometers, or miles.
            output_name: Optional output layer name.
        """
        return geo_ops.start_simplify_job(store, jobs, layer, tolerance, units=units, output_name=output_name)

    @mcp.tool()
    def select_by_attributes(
        layer: str,
        field: str,
        op: Literal["eq", "ne", "gt", "ge", "lt", "le", "contains", "startswith", "endswith", "isnull", "notnull"],
        value: str = "",
        output_name: str | None = None,
    ) -> dict[str, Any]:
        """Select features by an attribute condition into a new layer. Structured ops only (no free-form expressions).

        Ops: eq, ne, gt, ge, lt, le, contains, startswith, endswith, isnull, notnull.

        Args:
            layer: Layer id or name.
            field: Column name.
            op: Comparison operator from the list above.
            value: Comparison value (ignored for isnull/notnull).
            output_name: Optional output layer name.
        """
        return geo_ops.start_select_attributes_job(store, jobs, layer, field, op, value, output_name=output_name)

    @mcp.tool()
    def select_by_location(
        layer: str,
        filter_layer: str,
        predicate: Literal["intersects", "within", "contains", "crosses", "touches", "overlaps"] = "intersects",
        output_name: str | None = None,
    ) -> dict[str, Any]:
        """Select features spatially related to a filter layer into a new layer.

        Predicates: intersects, within, contains, crosses, touches, overlaps.

        Args:
            layer: Layer id or name to select from.
            filter_layer: Layer providing the filter geometries.
            predicate: Spatial predicate from the list above (default intersects).
            output_name: Optional output layer name.
        """
        return geo_ops.start_select_location_job(store, jobs, layer, filter_layer, predicate, output_name=output_name)

    @mcp.tool()
    def field_statistics(layer: str, field: str) -> dict[str, Any]:
        """Compute summary statistics for one attribute field of a layer.

        Numeric fields report min/max/mean/median/std; other fields report the
        most frequent values. Nulls are counted and excluded from the statistics.

        Args:
            layer: Layer id or name.
            field: Column name.
        """
        import math

        import numpy as np
        lid = store.resolve(layer)
        frame = store.get_gdf(lid)
        if frame is None:
            raise KeyError(f"unknown layer: {layer}")
        if field not in frame.columns or field == frame.geometry.name:
            raise ValueError(f"unknown attribute field: {field}")
        column = frame[field]
        stats: dict[str, Any] = {"layer": lid, "field": field, "count": int(len(column)),
                                 "null_count": int(column.isna().sum()),
                                 "unique_count": int(column.nunique(dropna=True))}
        values = column.dropna()
        numeric = values.dtype.kind in "iuf" and len(values) > 0
        if numeric:
            def finite(x: float) -> float | None:
                return float(x) if math.isfinite(float(x)) else None
            stats.update(min=finite(values.min()), max=finite(values.max()),
                         mean=finite(np.mean(values.astype("float64"))),
                         median=finite(np.median(values.astype("float64"))),
                         std=finite(np.std(values.astype("float64"), ddof=1)) if len(values) > 1 else 0.0)
        else:
            top = values.astype("string").value_counts().head(10)
            stats["top_values"] = [{"value": None if str(v) == "<NA>" else str(v), "count": int(c)} for v, c in top.items()]
        return stats

    @mcp.tool()
    def reproject(layer: str, target_crs: str, output_name: str | None = None) -> dict[str, Any]:
        """Reproject a layer to a target CRS (EPSG code or WKT/PROJ string). Job-based.

        Args:
            layer: Layer id or name.
            target_crs: Target CRS, e.g. EPSG:3857 or EPSG:4326.
            output_name: Optional output layer name.
        """
        return geo_ops.start_reproject_job(store, jobs, layer, target_crs, output_name=output_name)

    @mcp.tool(annotations=ToolAnnotations(destructiveHint=True, readOnlyHint=False))
    def export_features(layer: str, path: str, fmt: Literal["geojson", "gpkg", "fgb", "csv"] = "geojson", overwrite: bool = False) -> dict[str, Any]:
        """Write a verified layer to an absolute path; existing files require explicit overwrite approval.

        Args:
            layer: Layer id or name.
            path: Absolute output file path.
            fmt: geojson (default), gpkg, fgb, or csv.
            overwrite: Replace an existing file only when explicitly requested (default false).
        """
        return geo_ops.start_export_job(store, jobs, layer, path, fmt=fmt, overwrite=overwrite)

    @mcp.tool()
    def calculate_geometry(layer: str, output_name: str | None = None) -> dict[str, Any]:
        """Add area_m2 / length_m columns measured on a checked local UTM projection. Job-based.

        Args:
            layer: Layer id or name.
            output_name: Optional output layer name.
        """
        return geo_ops.start_calculate_geometry_job(store, jobs, layer, output_name=output_name)

    def view_result(layer: str, action: str, **options) -> dict[str, Any]:
        lid = store.resolve(layer)
        return {"ok": True, "view": {"action": action, "layer_id": lid, **options}}

    @mcp.tool()
    def zoom_to_layer(layer: str) -> dict[str, Any]:
        """Zoom the user's map to a layer's actual bounds. This directly changes the UI view."""
        info = store.describe(store.resolve(layer))
        if info["bounds"] is None:
            raise ValueError("Empty layers have no extent to zoom to")
        return view_result(layer, "zoom", bounds=info["bounds"])

    @mcp.tool()
    def open_attribute_table(layer: str) -> dict[str, Any]:
        """Open a layer's paged attribute table below the map in the user's UI."""
        return view_result(layer, "attributes")

    @mcp.tool()
    def set_layer_symbology(
        layer: str,
        color: Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")],
        opacity: Annotated[float, Field(ge=0, le=1)] = 0.65,
        point_size: Annotated[float, Field(ge=1, le=30)] = 5,
        line_width: Annotated[float, Field(ge=0.1, le=20)] = 1.6,
    ) -> dict[str, Any]:
        """Set a layer's single-symbol display color (#RRGGBB), opacity (0-1), point radius and line width (pixels). Does not alter analysis data."""
        return view_result(layer, "style", style={"color": color, "opacity": opacity, "pointSize": point_size,
                                                  "lineWidth": line_width, "categoryField": None, "categories": None})

    @mcp.tool()
    def set_layer_labels(layer: str, field: str | None = None,
                         size: Annotated[float, Field(ge=8, le=36)] = 13,
                         color: Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")] = "#172033") -> dict[str, Any]:
        """Show map labels from an attribute field; omit field to disable. Size is in pixels. Does not alter analysis data."""
        if field and field not in store.describe(store.resolve(layer))["columns"]:
            raise ValueError("Unknown label field; inspect describe_layer first")
        return view_result(layer, "labels", style={"labelField": field, "labelSize": size, "labelColor": color})

    @mcp.tool()
    def job_status(job_id: str) -> dict[str, Any]:
        """Get status/progress/result of a long-running job.

        Args:
            job_id: Id returned by analysis tools (buffer, clip, ...).
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

