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
    layer_ref: str,
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
    lid = store.resolve(layer_ref)
    gdf = store.get_gdf(lid)
    if gdf is None:
        raise KeyError(layer_ref)
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
    layer_ref: str,
    distance: float,
    units: str = "meters",
    dissolve: bool = False,
    output_name: str | None = None,
) -> dict[str, Any]:
    label = f"buffer {layer_ref} @ {distance}{units or 'm'}"

    def worker(job: Job, report: Callable[[float, str], None]) -> dict[str, Any]:
        return buffer_sync(
            store,
            layer_ref,
            distance,
            units=units,
            dissolve=dissolve,
            output_name=output_name,
            report=report,
            commit=lambda fn: jobs.commit(job, fn),
        )

    return jobs.start("buffer", label, worker)
