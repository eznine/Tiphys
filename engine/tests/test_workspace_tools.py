import sys
import tempfile
import unittest
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from layers import LayerStore


class WorkspaceTools(unittest.TestCase):
    """rename_layer / reorder_layers contracts shared by MCP, REST and the UI."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tiphys-workspace-")
        self.store = LayerStore(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_rename_updates_display_name_only_and_persists(self):
        a = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(116.4, 39.9)], crs=4326), "甲")
        renamed = self.store.rename(a["id"], "新的名字")
        self.assertEqual(renamed["layer"]["name"], "新的名字")
        # Analysis copy keeps its dataset path; only the manifest name changes.
        self.assertTrue(Path(renamed["layer"]["path"]).is_file())
        self.assertEqual(self.store.get(a["id"]).name, "新的名字")
        with self.assertRaisesRegex(ValueError, "empty"):
            self.store.rename(a["id"], "   ")
        with self.assertRaisesRegex(ValueError, "already named"):
            self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(117, 40)], crs=4326), "乙")
            self.store.rename(a["id"], "乙")

    def test_reorder_requires_a_permutation_and_sets_draw_order(self):
        a = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(116, 39)], crs=4326), "a")["id"]
        b = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(117, 39)], crs=4326), "b")["id"]
        c = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(118, 39)], crs=4326), "c")["id"]
        with self.assertRaisesRegex(ValueError, "exactly the existing layer ids"):
            self.store.reorder([a, b])
        with self.assertRaisesRegex(ValueError, "exactly the existing layer ids"):
            self.store.reorder([a, b, b])
        self.store.reorder([c, a, b])
        self.assertEqual([l["id"] for l in self.store.list()], [c, a, b])

    def test_order_and_rename_survive_a_store_restart(self):
        a = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(116, 39)], crs=4326), "keep")["id"]
        b = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(117, 39)], crs=4326), "other")["id"]
        self.store.reorder([b, a])
        self.store.rename(a, "改名后")
        reopened = LayerStore(Path(self.temp.name))
        self.assertEqual([l["id"] for l in reopened.list()], [b, a])
        self.assertEqual(reopened.get(a).name, "改名后")


if __name__ == "__main__":
    unittest.main()
