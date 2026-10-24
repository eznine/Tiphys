"""One tool implementation, two entries: MCP (Agent, natural language) and
manual ToolPanel via POST /tools/run. Contracts follow RustGIS
analysis tool shapes; implementations are GeoPandas in engine/geo_ops.py."""
import os
from typing import Any, Literal, Annotated
from pydantic import Field
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
import geo_ops
from jobs import JobRegistry
from layers import LayerStore

TOOL_GROUPS = {
    "数据管理": ("add_data", "describe_layer", "inspect_layers", "rename_layer", "reorder_layers", "reproject", "export_features", "remove_layer",
               "list_supported_formats", "import_arcgis_project"),
    "邻近分析": ("buffer",),
    "叠加分析": ("clip", "intersection", "union_layers", "erase", "spatial_join"),
    "几何处理": ("dissolve", "convex_hull", "simplify", "calculate_geometry"),
    "查询与选择": ("select_by_attributes", "select_by_location", "field_statistics"),
    "地图与显示": ("zoom_to_layer", "open_attribute_table", "set_layer_symbology", "set_layer_labels"),
    "GEE": ("gee_auth_status", "gee_search_collection", "gee_export_raster", "gee_job_status"),
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

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def inspect_layers(layer: str | None = None) -> dict[str, Any]:
        """Inspect real data, not the map copy: analysis location, CRS, fields, NoData, bounds, version digest.

        Use this before analysis when you need to know where a layer's bytes live,
        what its native bounds are, or whether it is vector or raster. Inspecting a
        single layer returns that layer's inspection; omitting `layer` returns the
        whole workspace plus per-layer errors instead of failing entirely.

        Args:
            layer: Optional layer id or name.
        """
        if layer is None:
            return store.inspect_workspace()
        return store.inspect(store.resolve(layer))

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
    def spatial_join(
        layer: str,
        join_layer: str,
        predicate: Literal["intersects", "contains", "within", "nearest"] = "intersects",
        keep_fields: bool = True,
        output_name: str | None = None,
    ) -> dict[str, Any]:
        """Join attributes from another layer by a spatial predicate. Job-based.

        One join feature is kept per target feature. Join attributes use the
        JOIN_ prefix; nearest adds NEAR_DIST in the target CRS units.

        Args:
            layer: Target layer receiving attributes.
            join_layer: Layer providing attributes.
            predicate: intersects, contains, within, or nearest.
            keep_fields: Keep all join attributes (default true).
            output_name: Optional output layer name.
        """
        return geo_ops.start_spatial_join_job(store, jobs, layer, join_layer, predicate,
                                              keep_fields=keep_fields, output_name=output_name)

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

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def list_supported_formats() -> dict[str, Any]:
        """List open formats TIPHYS can read, plus ArcGIS import limitations."""
        return {
            "ok": True,
            "runtime": "python-geopandas",
            "vector": ["GeoJSON (.geojson/.json)", "GeoPackage (.gpkg)", "Shapefile (.shp/.zip)", "FlatGeobuf (.fgb)",
                       "KML/KMZ (.kml/.kmz)", "GPX (.gpx)", "GML (.gml)", "GeoParquet (.geoparquet)", "TopoJSON (.topojson)"],
            "raster": ["GeoTIFF (.tif/.tiff)"],
            "table": ["CSV (.csv，作为只读表格导入)"],
            "arcgis": {
                "mxd": "不支持直接解析；请从 ArcGIS 导出要素为 GeoPackage、Shapefile ZIP 或 GeoJSON。",
                "aprx": "不支持直接解析；请从 ArcGIS Pro 导出地图内容为开放格式。",
                "file_gdb": "未安装 FileGDB 驱动时不能读取；请导出为 GeoPackage 或 Shapefile ZIP。",
            },
            "preferred": ["GeoPackage", "GeoJSON", "FlatGeobuf", "Shapefile ZIP", "GeoTIFF"],
        }

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def import_arcgis_project(path: str) -> dict[str, Any]:
        """Explain MXD/APRX/File GDB limits and return open-format alternatives."""
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        return {
            "ok": False,
            "supported": False,
            "path": path,
            "format": {"gdb": "ESRI File Geodatabase", "mxd": "ArcMap document", "aprx": "ArcGIS Pro project"}.get(ext, "unknown"),
            "message": "当前版本不解析 ArcGIS 专有工程或文件地理数据库，未读取该文件。",
            "alternatives": ["GeoPackage (.gpkg)", "GeoJSON (.geojson)", "Shapefile ZIP (.zip)", "KML/KMZ", "GeoTIFF"],
            "hint": "在 ArcGIS 中使用“导出要素/转换地理数据库”，或运行“支持的格式”查看完整列表。",
        }

    def gee_status() -> dict[str, Any]:
        """Report configuration presence only; never expose token or service-account contents."""
        demo = os.environ.get("TIPHYS_GEE_DEMO") == "1"
        project = os.environ.get("TIPHYS_GEE_PROJECT", "").strip() or None
        token = os.environ.get("TIPHYS_GEE_TOKEN", "").strip()
        service_account = os.environ.get("TIPHYS_GEE_SA_PATH", "").strip()
        has_token = bool(token)
        has_service_account = bool(service_account)
        configured = has_token or has_service_account
        status = "demo" if demo else "configured_unverified" if configured else "not_configured"
        hint = (
            "演示模式已启用：可验证表单与任务流程，但不会检索或下载真实 Earth Engine 影像。"
            if demo else
            "已检测到 GEE 凭据配置，但当前版本尚未执行服务端会话验证，因此不声称已连接。下一步是在受信任的桌面引擎中完成认证验证。"
            if configured else
            "未配置 GEE 项目或凭据。设置 TIPHYS_GEE_PROJECT 与 TIPHYS_GEE_SA_PATH（或 TIPHYS_GEE_TOKEN）后仍需服务端验证；当前可使用本地 GeoTIFF 与 GeoLibre WASM 遥感工具。"
        )
        return {
            "ok": False,
            "connected": False,
            "status": status,
            "project": project,
            "hasToken": has_token,
            "hasServiceAccount": has_service_account,
            "demo": demo,
            "auth_method": "token" if has_token else "service_account" if has_service_account else None,
            "verified": False,
            "message": (
                "GEE 处于演示模式；没有真实影像会话。"
                if demo else
                "已识别 GEE 配置，但尚未验证连接；未检索、上传或导出任何影像。"
                if configured else
                "Google Earth Engine 未配置。未检索、上传或导出任何影像。"
            ),
            "hint": hint,
        }

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def gee_auth_status() -> dict[str, Any]:
        """Return structured Google Earth Engine connection status."""
        return gee_status()

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def gee_search_collection(
        collection: str = "COPERNICUS/S2_SR_HARMONIZED",
        start_date: str | None = None,
        end_date: str | None = None,
        max_cloud: int = 20,
        bbox: str | None = None,
    ) -> dict[str, Any]:
        """Search a GEE collection; disconnected runtimes return an empty honest result."""
        auth = gee_status()
        return {
            **auth,
            "collection": collection,
            "items": [],
            "start_date": start_date,
            "end_date": end_date,
            "max_cloud": max_cloud,
            "bbox": bbox,
            "message": (
                "演示模式不检索真实影像集合；返回空列表。"
                if auth["demo"] else
                "GEE 尚未验证连接，未检索影像集合。返回空列表，不代表该集合不存在。"
            ),
        }

    @mcp.tool(annotations=ToolAnnotations(destructiveHint=True, readOnlyHint=False))
    def gee_export_raster(
        collection: str = "COPERNICUS/S2_SR_HARMONIZED",
        band: str = "B4",
        start_date: str | None = None,
        end_date: str | None = None,
        scale: float = 30,
        path: str | None = None,
    ) -> dict[str, Any]:
        """Create a GEE export job; real export requires configured credentials."""
        def worker(job, report):
            report(0.2, "检查 GEE 连接")
            demo = gee_status()["demo"]
            output = path or f"{collection.rsplit('/', 1)[-1]}_{band}.tif"
            if not demo:
                raise RuntimeError("GEE 导出任务未执行：未连接 Earth Engine，因此没有下载或写入栅格文件。")
            report(0.8, "生成演示任务结果")
            return {
                "ok": True,
                "demo": True,
                "connected": False,
                "status": "demo_completed",
                "collection": collection,
                "band": band,
                "start_date": start_date,
                "end_date": end_date,
                "scale": scale,
                "path": output,
                "message": "演示任务已完成。这是本地模拟结果，没有下载真实 GEE 影像。",
            }
        return jobs.start("gee_export_raster", f"GEE export {collection} {band}", worker)

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def gee_job_status(job_id: str) -> dict[str, Any]:
        """Return a GEE-style status view for an export job."""
        try:
            status = jobs.status(job_id)
        except KeyError:
            auth = gee_status()
            return {
                **auth,
                "job_id": job_id,
                "job_status": "unknown",
                "message": "找不到该 GEE 任务。当前引擎没有已连接的 GEE 任务记录。",
            }
        result = status.get("result") or {}
        auth = gee_status()
        return {
            "ok": status.get("status") == "completed" and result.get("ok") is not False,
            "connected": False,
            "status": auth["status"],
            "demo": bool(result.get("demo")) or bool(auth["demo"]),
            "project": auth["project"],
            "hasToken": auth["hasToken"],
            "hasServiceAccount": auth["hasServiceAccount"],
            "hint": auth["hint"],
            "job": status,
        }

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

