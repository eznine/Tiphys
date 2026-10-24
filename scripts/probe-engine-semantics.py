"""Reference metrics for the shared buffer/reproject contracts, computed by the
Python engine on the frozen fixtures.

Emits JSON on stdout so scripts/compare-engines.ts can put both engines on the
same ruler. Every number is measured, never assumed: geometry is measured in the
local UTM zone (EPSG:32650) whatever the layer's own CRS is, so both engines are
compared in metres. Radius error only uses a feature's own matching source point.
"""
from __future__ import annotations

import json
import math
import sys
import tempfile
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Point

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from geo_ops import buffer_sync, reproject_sync  # noqa: E402
from layers import LayerStore  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
MEASURE_CRS = "EPSG:32650"


def metrics(store: LayerStore, layer_id: str, source_points: dict[str, tuple[float, float]] | None,
            expected_radius: float | None) -> dict:
    gdf = store.get_gdf(layer_id)
    assert gdf is not None
    measured = gdf.to_crs(MEASURE_CRS)
    geometries = [geom for geom in measured.geometry if geom is not None]
    empty = sum(1 for geom in geometries if geom.is_empty)
    areas = [float(geom.area) for geom in geometries if not geom.is_empty]
    bounds = [float(v) for v in measured.total_bounds]
    if not all(math.isfinite(v) for v in bounds):
        bounds = None

    radius_error = None
    if source_points and expected_radius is not None:
        source = gpd.GeoSeries([Point(lon, lat) for lon, lat in source_points.values()],
                               crs="EPSG:4326").to_crs(MEASURE_CRS)
        by_name = {name: point for name, point in zip(source_points.keys(), source)}
        worst = 0.0
        for _, row in measured.iterrows():
            geom = row.geometry
            name = str(row.get("name", ""))
            if geom is None or geom.is_empty or name not in by_name:
                continue
            worst = max(worst, abs(geom.boundary.distance(by_name[name]) - expected_radius))
        radius_error = worst

    return {
        "featureCount": int(len(gdf)),
        "emptyGeometries": int(empty),
        "areasM2": areas,
        "areaTotalM2": sum(areas),
        "measureCrs": MEASURE_CRS,
        "measureBounds": bounds,
        "radiusErrorMaxM": radius_error,
    }


def point_sources(fixture: str) -> dict[str, tuple[float, float]]:
    frame = gpd.read_file(FIXTURES / fixture)
    return {str(row.get("name")): (float(row.geometry.x), float(row.geometry.y))
            for _, row in frame.iterrows() if row.geometry.geom_type == "Point"}


def one(case: dict) -> dict:
    with tempfile.TemporaryDirectory(prefix="tiphys-semantics-") as tmp:
        store = LayerStore(Path(tmp))
        info = store.add_from_path(str(FIXTURES / case["fixture"]))
        if case["op"] == "buffer":
            points = point_sources(case["fixture"]) if case.get("radius") else None
            result = buffer_sync(store, info["id"], case["distance"], units="meters", dissolve=case.get("dissolve", False))
            measured = metrics(store, result["layer"]["id"], points, abs(case["distance"]) if points else None)
            return {"case": case["name"], "ok": True, "outputCrs": result["layer"]["crs"],
                    "analysisCrs": result.get("analysis_crs"), "displayBounds": result["layer"].get("bounds"), **measured}
        result = reproject_sync(store, info["id"], case["target"])
        measured = metrics(store, result["layer"]["id"], None, None)
        return {"case": case["name"], "ok": True, "outputCrs": result["layer"]["crs"],
                "analysisCrs": result.get("target_crs"), "displayBounds": result["layer"].get("bounds"), **measured}


CASES = [
    {"name": "buffer_points_500m", "op": "buffer", "fixture": "bj_points.geojson", "distance": 500, "radius": True},
    {"name": "buffer_points_500m_dissolve", "op": "buffer", "fixture": "bj_points.geojson", "distance": 500, "dissolve": True},
    {"name": "buffer_zones_2km", "op": "buffer", "fixture": "district_zones.geojson", "distance": 2000},
    {"name": "buffer_points_negative", "op": "buffer", "fixture": "bj_points.geojson", "distance": -100},
    {"name": "reproject_points_3857", "op": "reproject", "fixture": "bj_points.geojson", "target": "EPSG:3857"},
    {"name": "reproject_zones_32650", "op": "reproject", "fixture": "district_zones.geojson", "target": "EPSG:32650"},
]


def main() -> None:
    results = []
    for case in CASES:
        try:
            results.append(one(case))
        except Exception as exc:  # report, do not hide
            results.append({"case": case["name"], "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    json.dump({"engine": "desktop-python", "results": results}, sys.stdout, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()