"""Generate deterministic Stage 5C min-cost corridor fixtures.

Run from the repository root:

    engine/.venv/bin/python scripts/make-ecology-fixtures.py

The rasters share one EPSG:32650 grid. Values are synthetic scenario inputs,
not habitat-suitability or species-dispersal science:

- habitat_sources.tif / habitat_dest.tif: positive cells mark the two ends.
- resistance_a.tif: low, slightly textured resistance.
- resistance_b.tif: same surface with a stronger mid-band barrier.
- resistance_c.tif: same barrier strengthened again for monotonicity checking.

All traversable cells are strictly positive. The GeoTIFF NoData value is the
rasterio/Whitebox sentinel -9999 outside the complete analysis grid (the grid
itself has no NoData cells), so every cell can carry a valid resistance.
"""
from __future__ import annotations

import json
import os
import pathlib

import importlib.util

# Keep GDAL's PROJ discovery independent from unrelated Windows/PostGIS env.
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
WIDTH = 80
HEIGHT = 60
RESOLUTION = 30.0
ORIGIN_X = 447_000.0
ORIGIN_Y = 4_427_000.0
BARRIER_COLUMNS = slice(36, 44)


def write_raster(path: pathlib.Path, data: np.ndarray) -> None:
    transform = from_origin(ORIGIN_X, ORIGIN_Y, RESOLUTION, RESOLUTION)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=HEIGHT,
        width=WIDTH,
        count=1,
        dtype="float32",
        crs="EPSG:32650",
        transform=transform,
        nodata=-9999.0,
        compress="deflate",
        tiled=False,
    ) as dst:
        dst.write(data, 1)


def resistance(barrier_boost: float) -> np.ndarray:
    rows, cols = np.mgrid[0:HEIGHT, 0:WIDTH]
    surface = 1.0 + 0.15 * np.sin(cols / 11.0) + 0.10 * np.cos(rows / 8.0)
    surface = surface.astype("float32")
    if barrier_boost:
        surface[:, BARRIER_COLUMNS] += barrier_boost
    return surface


def endpoint_mask(left: int) -> np.ndarray:
    mask = np.zeros((HEIGHT, WIDTH), dtype="float32")
    mask[25:35, left:left + 5] = 1.0
    return mask


def patches() -> dict:
    """Optional vector practice layers; the task card intentionally uses rasters."""
    source_x0 = ORIGIN_X + 5 * RESOLUTION
    dest_x0 = ORIGIN_X + 70 * RESOLUTION
    y0 = ORIGIN_Y - 35 * RESOLUTION
    y1 = ORIGIN_Y - 25 * RESOLUTION

    def polygon(x0: float) -> list[list[float]]:
        return [[x0, y0], [x0 + 5 * RESOLUTION, y0], [x0 + 5 * RESOLUTION, y1], [x0, y1], [x0, y0]]

    return {
        "type": "FeatureCollection",
        "name": "habitat_patches",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::32650"}},
        "features": [
            {"type": "Feature", "properties": {"role": "source", "scenario": "synthetic"},
             "geometry": {"type": "Polygon", "coordinates": [polygon(source_x0)]}},
            {"type": "Feature", "properties": {"role": "destination", "scenario": "synthetic"},
             "geometry": {"type": "Polygon", "coordinates": [polygon(dest_x0)]}},
        ],
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write_raster(OUT / "habitat_sources.tif", endpoint_mask(5))
    write_raster(OUT / "habitat_dest.tif", endpoint_mask(70))
    write_raster(OUT / "resistance_a.tif", resistance(0.0))
    write_raster(OUT / "resistance_b.tif", resistance(8.0))
    write_raster(OUT / "resistance_c.tif", resistance(16.0))
    (OUT / "habitat_patches.geojson").write_text(
        json.dumps(patches(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for name in ("habitat_sources.tif", "habitat_dest.tif", "resistance_a.tif", "resistance_b.tif", "resistance_c.tif", "habitat_patches.geojson"):
        path = OUT / name
        print(f"{path.relative_to(ROOT)} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
