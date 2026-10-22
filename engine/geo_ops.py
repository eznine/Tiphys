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

# Artificial delay multiplier for demoing job progress (0 = off).
DEMO_DELAY = float(os.environ.get("TIPHYS_DEMO_DELAY", "2.5"))
from typing import Any, Callable

import geopandas as gpd
from pyproj import CRS
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
    """Pick a UTM CRS from layer centroid (WGS84)."""
    gdf4326 = gdf.to_crs("EPSG:4326") if gdf.crs and str(gdf.crs) != "EPSG:4326" else gdf
    cx = float(gdf4326.geometry.centroid.x.mean())
    cy = float(gdf4326.geometry.centroid.y.mean())
    zone = int((cx + 180) // 6) + 1
    epsg = (32600 if cy >= 0 else 32700) + zone
    return CRS.from_epsg(epsg)


def buffer_sync(
    store: LayerStore,
    layer_ref: str,
    distance: float,
    units: str = "meters",
    dissolve: bool = False,
    output_name: str | None = None,
    report: Callable[[float, str], None] | None = None,
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
    r(0.85, "reproject to WGS84 + register")
    time.sleep(0.6 * DEMO_DELAY)
    info = store.add_gdf(buffered, name=out_name)
    r(1.0, "done")
    return {
        "ok": True,
        "layer": info,
        "distance_m": metres,
        "units": units or "meters",
        "dissolve": dissolve,
        "source_layer_id": lid,
    }


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
        )

    return jobs.start("buffer", label, worker)
