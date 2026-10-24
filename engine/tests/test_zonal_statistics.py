import os
import sys
import tempfile
import unittest
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import Point, box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geo_ops import zonal_statistics_sync
from layers import LayerStore


class ZonalStatistics(unittest.TestCase):
    def setUp(self):
        # Keep rasterio and pyproj on the PROJ database bundled with this venv.
        proj_data = Path(rasterio.__file__).parent / "proj_data"
        if proj_data.is_dir():
            for name in ("PROJ_LIB", "PROJ_DATA", "GDAL_DATA"):
                os.environ.pop(name, None)
            os.environ["PROJ_DATA"] = str(proj_data)
            os.environ["PROJ_LIB"] = str(proj_data)
        self.temp = tempfile.TemporaryDirectory(prefix="tiphys-zonal-")
        self.root = Path(self.temp.name)
        self.store = LayerStore(self.root / "workspace")

    def tearDown(self):
        self.temp.cleanup()

    def make_raster(self) -> str:
        tif = self.root / "values.tif"
        data = np.arange(1, 17, dtype="float32").reshape(4, 4)
        data[0, 1] = -9999
        with rasterio.open(
            tif,
            "w",
            driver="GTiff",
            width=4,
            height=4,
            count=1,
            dtype="float32",
            crs="EPSG:32650",
            transform=from_origin(500000, 4400000, 10, 10),
            nodata=-9999,
        ) as dst:
            dst.write(data, 1)
            dst.set_band_description(1, "elevation")
        return str(tif)

    def make_zones(self) -> str:
        zones = gpd.GeoDataFrame(
            {"zone": ["left", "right"], "rank": [1, 2]},
            geometry=[
                box(500000, 4399960, 500020, 4400000),
                box(500020, 4399960, 500040, 4400000),
            ],
            crs="EPSG:32650",
        )
        return self.store.add_gdf(zones, "zones")["id"]

    def test_registers_geotiff_and_computes_known_polygon_means(self):
        raster = self.store.add_from_path(self.make_raster())
        self.assertEqual(raster["kind"], "raster")
        self.assertEqual(raster["feature_count"], 0)
        self.assertEqual(raster["geometry_types"], [])
        self.assertEqual(raster["crs"], "EPSG:32650")
        self.assertTrue(Path(raster["path"]).is_file())
        self.assertTrue(str(Path(raster["path"]).resolve()).startswith(str(self.store.data_dir)))
        with self.assertRaisesRegex(ValueError, "raster"):
            self.store.get_gdf(raster["id"])
        reopened = LayerStore(self.store.data_dir)
        self.assertEqual(reopened.inspect(raster["id"])["layer"]["kind"], "raster")
        with self.assertRaisesRegex(ValueError, "raster"):
            reopened.get_gdf(raster["id"])

        zones_id = self.make_zones()
        result = zonal_statistics_sync(self.store, raster["id"], zones_id, "mean", ignore_nodata=True)
        output = self.store.get_gdf(result["layer"]["id"])

        self.assertEqual(len(output), 2)
        self.assertEqual(output["zone"].tolist(), ["left", "right"])
        self.assertEqual(output["rank"].tolist(), [1, 2])
        self.assertAlmostEqual(float(output.loc[0, "zonal_mean"]), 58 / 7, places=10)
        self.assertAlmostEqual(float(output.loc[1, "zonal_mean"]), 76 / 8, places=10)
        self.assertEqual(output["zone_pixel_count"].tolist(), [7, 8])
        self.assertEqual(result["band"], 1)
        self.assertEqual(result["band_description"], "elevation")
        self.assertTrue(result["raster_crs"].startswith("EPSG:32650"))

    def test_ignore_nodata_false_treats_nodata_as_zero_and_resolves_band_name(self):
        raster = self.store.add_from_path(self.make_raster())
        zones_id = self.make_zones()
        result = zonal_statistics_sync(
            self.store, raster["id"], zones_id, "mean",
            value_field="elevation", ignore_nodata=False,
        )
        output = self.store.get_gdf(result["layer"]["id"])

        self.assertAlmostEqual(float(output.loc[0, "zonal_mean"]), 58 / 8, places=10)
        self.assertAlmostEqual(float(output.loc[1, "zonal_mean"]), 76 / 8, places=10)
        self.assertEqual(output["zone_pixel_count"].tolist(), [8, 8])
        self.assertFalse(result["ignore_nodata"])
        self.assertEqual(result["band"], 1)

    def test_rejects_non_polygon_zones_and_an_empty_intersection(self):
        raster = self.store.add_from_path(self.make_raster())
        points = gpd.GeoDataFrame(
            {"zone": ["point"]}, geometry=[Point(500005, 4399995)], crs="EPSG:32650"
        )
        point_id = self.store.add_gdf(points, "points")["id"]
        with self.assertRaisesRegex(ValueError, "requires polygon zones"):
            zonal_statistics_sync(self.store, raster["id"], point_id, "mean")

        outside = gpd.GeoDataFrame(
            {"zone": ["outside"]},
            geometry=[box(600000, 4300000, 600010, 4300010)],
            crs="EPSG:32650",
        )
        outside_id = self.store.add_gdf(outside, "outside")["id"]
        with self.assertRaisesRegex(ValueError, "empty intersection"):
            zonal_statistics_sync(self.store, raster["id"], outside_id, "mean")


if __name__ == "__main__":
    unittest.main()
