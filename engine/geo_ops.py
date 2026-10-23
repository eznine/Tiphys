"""Vector ops for the engine.

`buffer` parameters follow RustGIS analysis `buffer` tool shape
(input, distance, units=meters|kilometers, dissolve, output name)
and GeoLibre/turf unit vocabulary (meters/kilometers/miles).
Implementation uses geopandas + shapely (projected local UTM), not a
copy of RustGIS geodesic_buffer or GeoLibre @turf/buffer.
"""

from __future__ import annotations

import os
import time
import math
import tempfile
from pathlib import Path

# Artificial delay multiplier for demoing job progress (0 = off).
DEMO_DELAY = float(os.environ.get("TIPHYS_DEMO_DELAY", "0"))
from typing import Any, Callable

import geopandas as gpd
from pyproj import CRS, Proj
from shapely.ops import unary_union

from layers import LayerStore
from jobs import Job, JobRegistry


def _to_metres(distance: float, units: str | None) -> float:
    u = (units or "meters").strip().lower()
    if u in ("", "m", "meter", "meters", "metres"):
        return distance
    if u in ("km", "kilometer", "kilometers", "kilometres"):
        return distance * 1000.0
    if u in ("mi", "mile", "miles"):
        return distance * 1609.344
    raise ValueError(f"unsupported units: {units}")


def _local_utm_crs(gdf: gpd.GeoDataFrame) -> CRS:
    """Use GeoPandas/PROJ selection and reject regions with >0.5% scale distortion."""
    if gdf.empty or not (gdf.geometry.notna() & ~gdf.geometry.is_empty).any():
        raise ValueError("Buffer requires at least one non-empty geometry")
    crs = gdf.estimate_utm_crs()
    if crs is None:
        raise ValueError("No suitable local UTM projection; use a smaller analysis region")
    _check_projection(gdf, crs)
    return crs


def _check_projection(gdf: gpd.GeoDataFrame, crs: CRS) -> None:
    bounds = gdf.to_crs("EPSG:4326").total_bounds
    if not all(math.isfinite(v) for v in bounds):
        raise ValueError("Non-finite geometry bounds")
    x0, y0, x1, y1 = bounds
    if y0 < -80 or y1 > 84 or x1 - x0 > 8 or y1 - y0 > 8:
        raise ValueError("Buffer supports local regions only; split wide, polar or antimeridian data explicitly")
    proj = Proj(crs)
    for x in (x0, (x0 + x1) / 2, x1):
        for y in (y0, (y0 + y1) / 2, y1):
            factors = proj.get_factors(x, y)
            if any(not math.isfinite(s) or abs(s - 1) > 0.005 for s in (factors.meridional_scale, factors.parallel_scale)):
                raise ValueError("Buffer projection distortion exceeds 0.5%; use a smaller analysis region")


def buffer_sync(
    store: LayerStore,
    layer: str,
    distance: float,
    units: str = "meters",
    dissolve: bool = False,
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Buffer a layer; optional progress callback for long-job demo."""
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    r(0.05, "resolve layer")
    lid = store.resolve(layer)
    gdf = store.get_gdf(lid)
    if gdf is None:
        raise KeyError(layer)
    metres = _to_metres(float(distance), units)
    if not math.isfinite(metres):
        raise ValueError("Distance must be finite")
    if abs(metres) > 5_000_000:
        raise ValueError("Distance is too large (limit 5000 km)")

    L = store.get(lid)
    assert L is not None
    out_name = output_name or f"{L.name}_buffer"

    r(0.15, "project to local UTM")
    # Artificial progress steps so UI job cards are demoable even on tiny data.
    time.sleep(0.9 * DEMO_DELAY)
    utm = _local_utm_crs(gdf)
    projected = gdf.to_crs(utm)
    r(0.4, f"buffer {metres:.1f} m")
    time.sleep(1.2 * DEMO_DELAY)
    buffered = projected.copy()
    buffered["geometry"] = projected.geometry.buffer(metres)
    if dissolve:
        r(0.7, "dissolve")
        time.sleep(0.6 * DEMO_DELAY)
        geom = unary_union(buffered.geometry.values)
        buffered = gpd.GeoDataFrame({"geometry": [geom]}, crs=utm)
    nonempty = buffered.loc[buffered.geometry.notna() & ~buffered.geometry.is_empty]
    if not nonempty.empty:
        _check_projection(nonempty, utm)
    r(0.85, "reproject to WGS84 + register")
    time.sleep(0.6 * DEMO_DELAY)
    r(0.95, "commit result")
    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(buffered, name=out_name),
                "distance_m": metres, "units": units or "meters", "dissolve": dissolve,
                "source_layer_id": lid, "analysis_crs": str(utm), "max_scale_error": 0.005}
    return commit(register) if commit else register()


def start_buffer_job(
    store: LayerStore,
    jobs: JobRegistry,
    layer: str,
    distance: float,
    units: str = "meters",
    dissolve: bool = False,
    output_name: str | None = None,
) -> dict[str, Any]:
    label = f"buffer {layer} @ {distance}{units or 'm'}"

    def worker(job: Job, report: Callable[[float, str], None]) -> dict[str, Any]:
        return buffer_sync(
            store,
            layer,
            distance,
            units=units,
            dissolve=dissolve,
            output_name=output_name,
            report=report,
            commit=lambda fn: jobs.commit(job, fn),
        )

    return jobs.start("buffer", label, worker)


# ---------------------------------------------------------------------------
# Analysis tool family (overlay / dissolve / selection / reproject / export).
# Interfaces follow the RustGIS analysis catalog (clip, erase, dissolve,
# selectByLocation, selectByAttributes, exportFeatures, ...); implementation
# is GeoPandas overlay/dissolve/sjoin-style operations, not a copy.
# ---------------------------------------------------------------------------

OVERLAY_HOWS = ("clip", "intersection", "union", "difference")
LOCATION_PREDICATES = ("intersects", "within", "contains", "crosses", "touches", "overlaps")
ATTR_OPS = ("eq", "ne", "gt", "ge", "lt", "le", "contains", "startswith", "endswith", "isnull", "notnull")
EXPORT_FORMATS = ("geojson", "gpkg", "fgb", "csv")


def _layer_frame(store: LayerStore, layer: str) -> tuple[str, gpd.GeoDataFrame, Any]:
    lid = store.resolve(layer)
    gdf = store.get_gdf(lid)
    if gdf is None:
        raise KeyError(f"layer not found: {layer}")
    L = store.get(lid)
    assert L is not None
    return lid, gdf, L


def _empty_result(name: str) -> dict[str, Any]:
    raise ValueError(f"'{name}' produced no features; check the inputs overlap / filter matches")


def _start_tool_job(
    jobs: JobRegistry,
    kind: str,
    label: str,
    run: Callable[[Callable[[float, str], None], Callable[[Callable[[], dict[str, Any]]], dict[str, Any]]], dict[str, Any]],
) -> dict[str, Any]:
    def worker(job: Job, report: Callable[[float, str], None]) -> dict[str, Any]:
        return run(report, lambda fn: jobs.commit(job, fn))

    return jobs.start(kind, label, worker)


def overlay_sync(
    store: LayerStore,
    how: str,
    layer_a: str,
    layer_b: str,
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Spatial overlay of two layers on a checked local projection.

    how=clip keeps layer A's attributes (mask semantics); the other hows use
    geopandas overlay with combined attributes.
    """
    if how not in OVERLAY_HOWS:
        raise ValueError(f"unsupported overlay how: {how}")

    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    r(0.05, "resolve layers")
    lid_a, gdf_a, L_a = _layer_frame(store, layer_a)
    lid_b, gdf_b, L_b = _layer_frame(store, layer_b)
    out_name = output_name or f"{L_a.name}_{how}"
    r(0.15, "project to local UTM")
    time.sleep(0.4 * DEMO_DELAY)
    utm = gdf_a.estimate_utm_crs()
    if utm is None:
        raise ValueError("No suitable local UTM projection; analysis supports local regions only")
    proj_a = gdf_a.to_crs(utm)
    proj_b = gdf_b.to_crs(utm)
    _check_projection(proj_a, utm)
    _check_projection(proj_b, utm)
    r(0.45, f"{how} overlay")
    time.sleep(0.8 * DEMO_DELAY)
    if how == "clip":
        out = gpd.clip(proj_a, proj_b)
    else:
        out = proj_a.overlay(proj_b, how=how)
    out = out.loc[out.geometry.notna() & ~out.geometry.is_empty]
    if out.empty:
        _empty_result(out_name)
    r(0.85, "reproject to WGS84 + register")
    time.sleep(0.4 * DEMO_DELAY)
    result = out.to_crs(gdf_a.crs)

    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(result, name=out_name),
                "how": how, "source_layer_id": lid_a, "mask_layer_id": lid_b,
                "feature_count": int(len(result)), "analysis_crs": str(utm)}
    return commit(register) if commit else register()


def start_overlay_job(
    store: LayerStore, jobs: JobRegistry, how: str, layer_a: str, layer_b: str,
    output_name: str | None = None,
) -> dict[str, Any]:
    return _start_tool_job(jobs, how, f"{how} {layer_a} × {layer_b}",
                           lambda report, commit: overlay_sync(store, how, layer_a, layer_b,
                                                               output_name=output_name, report=report, commit=commit))


def dissolve_sync(
    store: LayerStore,
    layer: str,
    by_field: str | None = None,
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    r(0.1, "resolve layer")
    lid, gdf, L = _layer_frame(store, layer)
    if by_field is not None and by_field not in gdf.columns:
        raise ValueError(f"field '{by_field}' not in layer columns")
    out_name = output_name or f"{L.name}_dissolved"
    r(0.4, f"dissolve by {by_field or 'all features'}")
    time.sleep(0.6 * DEMO_DELAY)
    merged = gdf.dissolve(by=by_field, as_index=False) if by_field else gdf.dissolve(as_index=False)
    merged = merged.loc[merged.geometry.notna() & ~merged.geometry.is_empty]
    if merged.empty:
        _empty_result(out_name)
    r(0.9, "register")
    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(merged, name=out_name),
                "by_field": by_field, "source_layer_id": lid, "feature_count": int(len(merged))}
    return commit(register) if commit else register()


def start_dissolve_job(store: LayerStore, jobs: JobRegistry, layer: str,
                       by_field: str | None = None, output_name: str | None = None) -> dict[str, Any]:
    return _start_tool_job(jobs, "dissolve", f"dissolve {layer}",
                           lambda report, commit: dissolve_sync(store, layer, by_field=by_field,
                                                                output_name=output_name, report=report, commit=commit))


def convex_hull_sync(
    store: LayerStore,
    layer: str,
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    r(0.1, "resolve layer")
    lid, gdf, L = _layer_frame(store, layer)
    present = gdf.loc[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    if present.empty:
        _empty_result(f"{L.name}_hull")
    out_name = output_name or f"{L.name}_hull"
    r(0.5, "convex hull")
    hull = gpd.GeoDataFrame({"geometry": [present.geometry.union_all().convex_hull]}, crs=gdf.crs)
    r(0.9, "register")
    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(hull, name=out_name),
                "source_layer_id": lid, "feature_count": 1}
    return commit(register) if commit else register()


def start_convex_hull_job(store: LayerStore, jobs: JobRegistry, layer: str,
                          output_name: str | None = None) -> dict[str, Any]:
    return _start_tool_job(jobs, "convex_hull", f"convex hull {layer}",
                           lambda report, commit: convex_hull_sync(store, layer, output_name=output_name,
                                                                   report=report, commit=commit))


def simplify_sync(
    store: LayerStore,
    layer: str,
    tolerance: float,
    units: str = "meters",
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    r(0.1, "resolve layer")
    lid, gdf, L = _layer_frame(store, layer)
    metres = _to_metres(float(tolerance), units)
    if not math.isfinite(metres) or metres <= 0:
        raise ValueError("Tolerance must be a positive distance")
    out_name = output_name or f"{L.name}_simplified"
    r(0.3, "project to local UTM")
    utm = _local_utm_crs(gdf)
    projected = gdf.to_crs(utm)
    r(0.6, f"simplify {metres:.1f} m")
    time.sleep(0.6 * DEMO_DELAY)
    simplified = projected.copy()
    simplified["geometry"] = projected.geometry.simplify(metres, preserve_topology=True)
    simplified = simplified.loc[simplified.geometry.notna() & ~simplified.geometry.is_empty]
    if simplified.empty:
        _empty_result(out_name)
    r(0.9, "reproject to WGS84 + register")
    result = simplified.to_crs("EPSG:4326")
    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(result, name=out_name),
                "tolerance_m": metres, "source_layer_id": lid, "analysis_crs": str(utm)}
    return commit(register) if commit else register()


def start_simplify_job(store: LayerStore, jobs: JobRegistry, layer: str, tolerance: float,
                       units: str = "meters", output_name: str | None = None) -> dict[str, Any]:
    return _start_tool_job(jobs, "simplify", f"simplify {layer} @ {tolerance}{units or 'm'}",
                           lambda report, commit: simplify_sync(store, layer, tolerance, units=units,
                                                                output_name=output_name, report=report, commit=commit))


def _compare_mask(series: "gpd.pd.Series", op: str, raw: str):
    import pandas as pd

    if op == "isnull":
        return series.isna()
    if op == "notnull":
        return series.notna()
    value: Any
    if pd.api.types.is_numeric_dtype(series):
        try:
            value = float(raw)
        except ValueError:
            raise ValueError(f"field is numeric; value '{raw}' is not a number") from None
        if not math.isfinite(value):
            raise ValueError("comparison value must be finite")
        comparable = series
    else:
        value = raw
        comparable = series.astype("string")
    text = str(value)
    if op in ("contains", "startswith", "endswith"):
        comparable = series.astype("string")
        text = raw
    if op == "eq":
        return comparable == value if isinstance(value, float) else comparable.str.casefold() == text.casefold()
    if op == "ne":
        return ~(comparable == value) if isinstance(value, float) else comparable.str.casefold() != text.casefold()
    if op == "gt":
        return comparable > value
    if op == "ge":
        return comparable >= value
    if op == "lt":
        return comparable < value
    if op == "le":
        return comparable <= value
    if op == "contains":
        return comparable.str.contains(text, case=False, regex=False)
    if op == "startswith":
        return comparable.str.lower().str.startswith(text.lower())
    if op == "endswith":
        return comparable.str.lower().str.endswith(text.lower())
    raise ValueError(f"unsupported attribute op: {op}")


def select_attributes_sync(
    store: LayerStore,
    layer: str,
    field: str,
    op: str,
    value: str = "",
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    r(0.1, "resolve layer")
    lid, gdf, L = _layer_frame(store, layer)
    if op not in ATTR_OPS:
        raise ValueError(f"unsupported attribute op: {op} (use one of {', '.join(ATTR_OPS)})")
    if field not in gdf.columns:
        raise ValueError(f"field '{field}' not in layer columns")
    r(0.5, f"filter {field} {op}")
    mask = _compare_mask(gdf[field], op, str(value))
    picked = gdf.loc[mask.fillna(False)]
    out_name = output_name or f"{L.name}_selected"
    r(0.9, "register")
    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(picked, name=out_name),
                "filter": {"field": field, "op": op, "value": value},
                "source_layer_id": lid, "feature_count": int(len(picked))}
    return commit(register) if commit else register()


def start_select_attributes_job(store: LayerStore, jobs: JobRegistry, layer: str,
                                field: str, op: str, value: str = "",
                                output_name: str | None = None) -> dict[str, Any]:
    return _start_tool_job(jobs, "select_by_attributes", f"select {layer}: {field} {op}",
                           lambda report, commit: select_attributes_sync(store, layer, field, op, value,
                                                                         output_name=output_name, report=report, commit=commit))


def select_location_sync(
    store: LayerStore,
    layer: str,
    filter_layer: str,
    predicate: str = "intersects",
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    if predicate not in LOCATION_PREDICATES:
        raise ValueError(f"unsupported predicate: {predicate} (use one of {', '.join(LOCATION_PREDICATES)})")
    r(0.1, "resolve layers")
    lid, gdf, L = _layer_frame(store, layer)
    _, filter_gdf, _ = _layer_frame(store, filter_layer)
    r(0.4, f"align CRS + {predicate}")
    aligned = filter_gdf.to_crs(gdf.crs)
    time.sleep(0.4 * DEMO_DELAY)
    picked = gdf.loc[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    # Match any filter feature; unioning them changes contains/within semantics.
    joined = gpd.sjoin(picked, aligned[[aligned.geometry.name]], how="inner", predicate=predicate)
    picked = picked.loc[picked.index.isin(joined.index)]
    out_name = output_name or f"{L.name}_in_{predicate}"
    r(0.9, "register")
    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(picked, name=out_name),
                "predicate": predicate, "filter_layer_id": store.resolve(filter_layer),
                "source_layer_id": lid, "feature_count": int(len(picked))}
    return commit(register) if commit else register()


def start_select_location_job(store: LayerStore, jobs: JobRegistry, layer: str, filter_layer: str,
                              predicate: str = "intersects", output_name: str | None = None) -> dict[str, Any]:
    return _start_tool_job(jobs, "select_by_location", f"{predicate} {layer} × {filter_layer}",
                           lambda report, commit: select_location_sync(store, layer, filter_layer, predicate,
                                                                       output_name=output_name, report=report, commit=commit))


def reproject_sync(
    store: LayerStore,
    layer: str,
    target_crs: str,
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    r(0.1, "resolve layer")
    lid, gdf, L = _layer_frame(store, layer)
    from pyproj import CRS as _CRS

    try:
        target = _CRS.from_user_input(target_crs)
    except Exception as e:
        raise ValueError(f"unknown target CRS '{target_crs}': {e}") from e
    if target.equals(_CRS.from_user_input(gdf.crs)):
        raise ValueError(f"layer is already in {target.to_string()}")
    out_name = output_name or f"{L.name}_{target.to_epsg() or 'custom'}"
    r(0.5, f"reproject to {target.to_string()}")
    time.sleep(0.5 * DEMO_DELAY)
    reprojected = gdf.to_crs(target)
    r(0.9, "register")
    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(reprojected, name=out_name),
                "source_crs": str(gdf.crs), "target_crs": target.to_string(), "source_layer_id": lid}
    return commit(register) if commit else register()


def start_reproject_job(store: LayerStore, jobs: JobRegistry, layer: str, target_crs: str,
                        output_name: str | None = None) -> dict[str, Any]:
    return _start_tool_job(jobs, "reproject", f"reproject {layer} → {target_crs}",
                           lambda report, commit: reproject_sync(store, layer, target_crs,
                                                                 output_name=output_name, report=report, commit=commit))


def export_sync(
    store: LayerStore,
    layer: str,
    path: str,
    fmt: str = "geojson",
    overwrite: bool = False,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Write a layer to a user-supplied path (geojson | gpkg | fgb | csv with WKT)."""
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    if fmt not in EXPORT_FORMATS:
        raise ValueError(f"unsupported format: {fmt} (use one of {', '.join(EXPORT_FORMATS)})")
    if not path or not os.path.isabs(path):
        raise ValueError("path must be an absolute filesystem path")
    r(0.1, "resolve layer")
    lid, gdf, L = _layer_frame(store, layer)
    target = Path(path).resolve()
    managed = {store.data_dir / "workspace.json", store.data_dir / "jobs.json"}
    for item in store.list():
        managed.update((Path(item["path"]), Path(store.get(item["id"]).path)))
    if target in managed:
        raise ValueError("Cannot export over a managed workspace file")
    if target.exists() and not overwrite:
        raise FileExistsError("Output exists; use overwrite=true only with explicit approval")
    target.parent.mkdir(parents=True, exist_ok=True)
    r(0.5, f"write {fmt}")
    time.sleep(0.4 * DEMO_DELAY)
    # Serialize and verify privately, then publish atomically inside the job's
    # cancellation boundary. A failed/cancelled export leaves the target intact.
    with tempfile.TemporaryDirectory(prefix=".tiphys-export-", dir=target.parent) as tmp:
        staged = Path(tmp) / f"features.{fmt}"
        if fmt == "csv":
            import pandas as pd
            from shapely import from_wkt

            table = pd.DataFrame(gdf.copy())
            table[gdf.geometry.name] = gdf.geometry.to_wkt()
            table.to_csv(staged, index=False)
            readback = pd.read_csv(staged, keep_default_na=False)
            from_wkt(readback[gdf.geometry.name].replace("", None).to_numpy())
        else:
            output = gdf.to_crs(4326) if fmt == "geojson" else gdf
            options = {}
            if fmt == "gpkg":
                fid = "_tiphys_fid"
                while fid.casefold() in {str(c).casefold() for c in output.columns}:
                    fid += "_"
                options = {"layer": "features", "FID": fid}
            driver = "GPKG" if fmt == "gpkg" else "FlatGeobuf" if fmt == "fgb" else "GeoJSON"
            output.to_file(staged, driver=driver, index=False, **options)
            readback = gpd.read_file(staged)
            if readback.crs != output.crs:
                raise ValueError("Export verification failed: CRS differs")
        if len(readback) != len(gdf) or set(readback.columns) != set(gdf.columns):
            raise ValueError("Export verification failed: feature count or fields differ")
        size = staged.stat().st_size
        if size == 0:
            raise ValueError("Export verification failed: file is empty")
        r(0.9, "verified; commit export")
        def publish() -> dict[str, Any]:
            if overwrite:
                os.replace(staged, target)
            else:
                os.link(staged, target)  # Atomic create; refuse a concurrent overwrite.
            return {"ok": True, "path": str(target), "format": fmt, "bytes": size,
                    "layer_id": lid, "feature_count": int(len(gdf)),
                    "crs": "EPSG:4326" if fmt == "geojson" else str(gdf.crs)}
        return commit(publish) if commit else publish()


def start_export_job(store: LayerStore, jobs: JobRegistry, layer: str, path: str, fmt: str = "geojson", overwrite: bool = False) -> dict[str, Any]:
    return _start_tool_job(jobs, "export_features", f"export {layer} → {os.path.basename(path)}",
                           lambda report, commit: export_sync(store, layer, path, fmt=fmt, overwrite=overwrite, report=report, commit=commit))


def calculate_geometry_sync(
    store: LayerStore,
    layer: str,
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
    commit: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Add projected area_m2 / length_m columns (metre truth via local UTM)."""
    def r(p: float, m: str = "") -> None:
        if report:
            report(p, m)

    r(0.1, "resolve layer")
    lid, gdf, L = _layer_frame(store, layer)
    utm = _local_utm_crs(gdf)
    r(0.5, "measure on projection")
    time.sleep(0.4 * DEMO_DELAY)
    measured = gdf.to_crs(utm)
    out = gdf.copy()
    out["area_m2"] = [round(a, 2) if math.isfinite(a) else None for a in measured.geometry.area]
    out["length_m"] = [round(l, 2) if math.isfinite(l) else None for l in measured.geometry.length]
    out_name = output_name or f"{L.name}_measured"
    r(0.9, "register")
    def register() -> dict[str, Any]:
        return {"ok": True, "layer": store.add_gdf(out, name=out_name),
                "added_columns": ["area_m2", "length_m"], "analysis_crs": str(utm), "source_layer_id": lid}
    return commit(register) if commit else register()


def start_calculate_geometry_job(store: LayerStore, jobs: JobRegistry, layer: str,
                                 output_name: str | None = None) -> dict[str, Any]:
    return _start_tool_job(jobs, "calculate_geometry", f"measure {layer}",
                           lambda report, commit: calculate_geometry_sync(store, layer, output_name=output_name,
                                                                          report=report, commit=commit))
