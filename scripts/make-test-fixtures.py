"""Generate the small, deterministic GIS fixtures used by the TIPHYS baseline.

Run with the engine virtualenv (needs rasterio):

    engine/.venv/Scripts/python.exe scripts/make-test-fixtures.py

Everything is synthetic and reproducible; nothing is downloaded. The script
rewrites the files in tests/fixtures/ so a baseline run always starts from the
same bytes (GeoTIFF contains no timestamp by default).
"""
from __future__ import annotations

import json
import os
import pathlib

# Some Windows setups export PROJ_LIB/PROJ_DATA/GDAL_DATA for a PostGIS install
# whose proj.db layout is too old for rasterio's bundled GDAL. Point GDAL at the
# proj.db shipped inside the rasterio wheel instead of failing with
# "The EPSG code is unknown".
import importlib.util

for key in ("PROJ_LIB", "PROJ_DATA", "GDAL_DATA"):
    os.environ.pop(key, None)
_spec = importlib.util.find_spec("rasterio")
if _spec and _spec.origin:
    _proj = pathlib.Path(_spec.origin).parent / "proj_data"
    if (_proj / "proj.db").is_file():
        os.environ["PROJ_DATA"] = str(_proj)
        os.environ["PROJ_LIB"] = str(_proj)

import numpy as np
import rasterio
from rasterio.transform import from_origin

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)


def dem(width: int, height: int, pixel: float = 30.0, *, large: bool = False) -> np.ndarray:
    """Smooth terrain: rises to the north-east, with a drainage valley and one pit."""
    xs = np.arange(width) * pixel
    ys = np.arange(height) * pixel
    x, y = np.meshgrid(xs, ys)
    z = 60.0 + 0.035 * y + 0.010 * x
    # Two ridges funnel water into a valley that drains south.
    z += 28.0 * np.exp(-(((x - width * pixel * 0.35) / (width * pixel * 0.16)) ** 2))
    z += 22.0 * np.exp(-(((x - width * pixel * 0.72) / (width * pixel * 0.12)) ** 2))
    z -= 18.0 * np.exp(-(((x - width * pixel * 0.52) / (width * pixel * 0.10)) ** 2 + ((y - height * pixel * 0.55) / (height * pixel * 0.35)) ** 2))
    z += 3.0 * np.sin(x / 210.0) * np.cos(y / 260.0)
    # A closed depression that hydrology tools must fill before flow routing.
    cx, cy = width * pixel * 0.30, height * pixel * 0.62
    z -= 9.0 * np.exp(-(((x - cx) / 120.0) ** 2 + ((y - cy) / 120.0) ** 2))
    if large:  # a coarser secondary pattern keeps the large raster from being flat
        z += 12.0 * np.sin(x / 900.0 + y / 700.0)
    return z.astype("float32")


def write_raster(path: pathlib.Path, data: np.ndarray, *, res: float = 30.0) -> None:
    transform = from_origin(447_000.0, 4_427_000.0, res, res)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=data.shape[0],
        width=data.shape[1],
        count=1,
        dtype="float32",
        crs="EPSG:32650",
        transform=transform,
        nodata=-9999.0,
        compress="deflate",
        tiled=False,
    ) as dst:
        dst.write(data, 1)


def polygons() -> dict:
    zones = [
        ("A", 12000, [[116.30, 39.85], [116.42, 39.85], [116.42, 39.95], [116.30, 39.95], [116.30, 39.85]]),
        ("B", 8000, [[116.40, 39.88], [116.52, 39.88], [116.52, 39.99], [116.40, 39.99], [116.40, 39.88]]),
        ("C", 3000, [[116.46, 39.80], [116.56, 39.80], [116.56, 39.87], [116.46, 39.87], [116.46, 39.80]]),
    ]
    return {
        "type": "FeatureCollection",
        "name": "district_zones",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [
            {
                "type": "Feature",
                "properties": {"zone": code, "pop": population, "kind": "district"},
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            }
            for code, population, ring in zones
        ],
    }


def roads() -> dict:
    lines = [
        ("ring", [[116.32, 39.90], [116.38, 39.905], [116.44, 39.90], [116.50, 39.905]]),
        ("radial", [[116.40, 39.86], [116.405, 39.90], [116.412, 39.94], [116.418, 39.98]]),
        ("connector", [[116.36, 39.87], [116.405, 39.895], [116.47, 39.92]]),
    ]
    return {
        "type": "FeatureCollection",
        "name": "roads",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [
            {
                "type": "Feature",
                "properties": {"name": name, "lanes": lanes},
                "geometry": {"type": "LineString", "coordinates": coords},
            }
            for (name, coords), lanes in zip(lines, (6, 4, 2))
        ],
    }


def schools() -> dict:
    """Stage 5B: five schools with levels, spread so service circles overlap partially."""
    points = [
        ("S1", "小学", 116.30, 39.86),
        ("S2", "小学", 116.38, 39.90),
        ("S3", "中学", 116.44, 39.86),
        ("S4", "中学", 116.50, 39.92),
        ("S5", "高中", 116.34, 39.94),
    ]
    return {
        "type": "FeatureCollection",
        "name": "schools",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [
            {"type": "Feature", "properties": {"sid": sid, "level": level}, "geometry": {"type": "Point", "coordinates": [lon, lat]}}
            for sid, level, lon, lat in points
        ],
    }


def residential() -> dict:
    """Stage 5B: residential blocks with household counts, some inside service circles."""
    blocks = [
        ("R1", 800, [[116.29, 39.85], [116.33, 39.85], [116.33, 39.88], [116.29, 39.88]]),
        ("R2", 1200, [[116.36, 39.89], [116.41, 39.89], [116.41, 39.92], [116.36, 39.92]]),
        ("R3", 650, [[116.43, 39.85], [116.47, 39.85], [116.47, 39.88], [116.43, 39.88]]),
        ("R4", 2000, [[116.49, 39.91], [116.55, 39.91], [116.55, 39.95], [116.49, 39.95]]),
        ("R5", 300, [[116.33, 39.93], [116.36, 39.93], [116.36, 39.96], [116.33, 39.96]]),
        ("R6", 150, [[116.60, 39.97], [116.63, 39.97], [116.63, 39.99], [116.60, 39.99]]),
    ]
    return {
        "type": "FeatureCollection",
        "name": "residential",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [
            {"type": "Feature", "properties": {"rid": rid, "households": households}, "geometry": {"type": "Polygon", "coordinates": [ring]}}
            for rid, households, ring in blocks
        ],
    }


def zone_a() -> dict:
    data = polygons()
    feature = data["features"][0]
    data["features"] = [feature]
    data["name"] = "zone_a"
    return data


def bowtie() -> dict:
    """Self-intersecting polygon: a deliberate invalid-geometry probe."""
    return {
        "type": "FeatureCollection",
        "name": "bowtie_invalid",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [{
            "type": "Feature",
            "properties": {"id": 1, "note": "self-intersecting ring"},
            "geometry": {"type": "Polygon", "coordinates": [[
                [116.30, 39.85], [116.42, 39.95], [116.42, 39.85], [116.30, 39.95], [116.30, 39.85],
            ]]},
        }],
    }


def write_json(path: pathlib.Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    write_raster(OUT / "dem_hills.tif", dem(120, 100))
    write_raster(OUT / "dem_large.tif", dem(600, 500, large=True))
    # Stage-4 mobile budget probe: 2.24M pixels exceeds the 2M mobile WASM budget.
    write_raster(OUT / "dem_over_budget.tif", dem(1600, 1400))
    write_json(OUT / "district_zones.geojson", polygons())
    write_json(OUT / "schools.geojson", schools())
    write_json(OUT / "residential.geojson", residential())
    write_json(OUT / "zone_a.geojson", zone_a())
    write_json(OUT / "bowtie.geojson", bowtie())
    write_json(OUT / "roads.geojson", roads())
    for path in sorted(OUT.glob("*")):
        if path.suffix in {".tif", ".geojson"}:
            print(f"{path.relative_to(ROOT)} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()