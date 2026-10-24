import sys
import tempfile
import unittest
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from layers import Layer, LayerStore


class InspectLayers(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tiphys-inspect-")
        self.store = LayerStore(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_vector_inspection_reports_real_location_and_digest(self):
        gdf = gpd.GeoDataFrame(
            {"name": ["A", None, "C"], "pop": [10, 20, 30]},
            geometry=[Point(116.40, 39.90), Point(116.41, 39.91), Point(116.42, 39.92)],
            crs="EPSG:4326",
        )
        info = self.store.add_gdf(gdf, "zones")
        inspected = self.store.inspect(info["id"])

        layer = inspected["layer"]
        self.assertEqual(layer["kind"], "vector")
        self.assertEqual(layer["crs"], "EPSG:4326")
        self.assertEqual(layer["displayCrs"], "EPSG:4326")
        self.assertEqual(layer["featureCount"], 3)
        self.assertEqual(layer["data"]["engine"], "desktop-python")
        self.assertEqual(layer["data"]["storage"], "file")
        self.assertTrue(layer["data"]["location"].endswith(".gpkg"))
        self.assertTrue(Path(layer["data"]["location"]).is_file())
        self.assertTrue(layer["data"]["sha256"].startswith("sha256:"))
        self.assertEqual(len(layer["data"]["sha256"]), len("sha256:") + 64)
        self.assertIn(str(layer["data"]["bytes"]), layer["data"]["revision"])

        fields = {f["name"]: f for f in inspected["fields"]}
        self.assertEqual(fields["pop"]["type"], "integer")
        self.assertEqual(fields["name"]["type"], "string")
        self.assertEqual(fields["name"]["nullCount"], 1)
        self.assertEqual(fields["pop"]["sample"], 10)

        native = inspected["extra"]["nativeBounds"]
        self.assertAlmostEqual(native[0], 116.40, places=6)
        self.assertEqual(inspected["extra"]["columns"], 2)
        # bounds are the WGS84 display bounds, explicitly different from nativeBounds.
        self.assertEqual(len(layer["bounds"]), 4)

    def test_workspace_inspection_keeps_going_after_one_bad_layer(self):
        self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(1, 2)], crs="EPSG:4326"), "ok")
        # A layer whose dataset disappeared must be reported, not crash the sweep.
        self.store._layers["lyr_broken"] = Layer("lyr_broken", "broken", "EPSG:4326", None, 0, [], None,
                                                 None, None, {"dataset_path": str(Path(self.temp.name) / "missing.gpkg")})
        result = self.store.inspect_workspace()
        self.assertEqual(result["engine"], "desktop-python")
        self.assertEqual(len(result["layers"]), 1)
        self.assertEqual(result["layers"][0]["layer"]["name"], "ok")
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("lyr_broken", result["errors"][0]["layerId"])

    def test_raster_inspection_reads_size_bands_and_nodata(self):
        # A machine-wide PROJ_LIB pointing at another GDAL install breaks CRS
        # parsing; rasterio's bundled proj.db is the one this venv was built for.
        import os

        import rasterio

        proj_data = Path(rasterio.__file__).parent / "proj_data"
        if proj_data.is_dir():
            for name in ("PROJ_LIB", "PROJ_DATA", "GDAL_DATA"):
                os.environ.pop(name, None)
            os.environ["PROJ_DATA"] = str(proj_data)
            os.environ["PROJ_LIB"] = str(proj_data)
        tif = Path(self.temp.name) / "dem.tif"
        data = np.arange(12, dtype="float32").reshape(3, 4)
        with rasterio.open(tif, "w", driver="GTiff", width=4, height=3, count=1, dtype="float32",
                           crs="EPSG:32650", transform=from_origin(500000, 4400000, 30, 30), nodata=-9999) as dst:
            dst.write(data, 1)
        self.store._layers["lyr_dem"] = Layer("lyr_dem", "dem", "EPSG:32650", None, 0, [], [500000, 4399910, 500120, 4400000],
                                              None, str(tif), {"dataset_path": str(tif)})
        inspected = self.store.inspect("lyr_dem")
        layer = inspected["layer"]
        self.assertEqual(layer["kind"], "raster")
        self.assertEqual(layer["crs"], "EPSG:32650")
        self.assertEqual(layer["raster"]["width"], 4)
        self.assertEqual(layer["raster"]["height"], 3)
        self.assertEqual(layer["raster"]["bands"], 1)
        self.assertEqual(layer["raster"]["nodata"], -9999)
        self.assertEqual(layer["raster"]["dtype"], "float32")
        self.assertEqual(layer["raster"]["pixelSize"], [30.0, 30.0])
        self.assertEqual(inspected["fields"], [])


if __name__ == "__main__":
    unittest.main()