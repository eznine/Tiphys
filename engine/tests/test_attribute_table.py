import sys
import tempfile
import unittest
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from layers import LayerStore


class AttributeTable(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tiphys-attributes-")
        self.store = LayerStore(Path(self.temp.name))
        frame = gpd.GeoDataFrame(
            {"id": [1, 2, 3], "name": ["天安门", "故宫", "北海"], "pop": [10.0, 20.0, None], "code": ["01", "02", "03"]},
            geometry=[Point(116.39, 39.90), Point(116.40, 39.91), Point(116.38, 39.92)], crs=4326,
        )
        self.layer = self.store.add_gdf(frame, "属性测试")["id"]

    def tearDown(self):
        self.temp.cleanup()

    def test_rename_field_updates_work_copy_and_survives_restart(self):
        result = self.store.rename_field(self.layer, "pop", "population")
        self.assertEqual(result["new_field"], "population")
        self.assertEqual(result["fields"], ["id", "name", "population", "code"])
        self.assertEqual(result["layer"]["id"], self.layer)
        page = self.store.attributes_page(self.layer, sort="population", descending=True)
        self.assertEqual(page["fields"][2]["name"], "population")
        self.assertEqual(page["rows"][0]["attributes"]["population"], 20.0)
        reopened = LayerStore(Path(self.temp.name))
        self.assertEqual(reopened.describe(self.layer)["columns"], ["id", "name", "population", "code"])

    def test_rename_field_rejects_invalid_duplicate_reserved_and_unknown_names(self):
        with self.assertRaisesRegex(ValueError, "empty"):
            self.store.rename_field(self.layer, "name", "   ")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.store.rename_field(self.layer, "name", "code")
        with self.assertRaisesRegex(ValueError, "reserved"):
            self.store.rename_field(self.layer, "id", "identifier")
        with self.assertRaisesRegex(ValueError, "reserved"):
            self.store.rename_field(self.layer, "name", "geometry")
        with self.assertRaisesRegex(ValueError, "must start"):
            self.store.rename_field(self.layer, "name", "bad.name")
        with self.assertRaisesRegex(ValueError, "unknown attribute field"):
            self.store.rename_field(self.layer, "missing", "renamed")
        self.assertEqual(self.store.describe(self.layer)["columns"], ["id", "name", "pop", "code"])

    def test_definition_query_filters_total_before_paging_and_keeps_leading_zeros(self):
        page = self.store.attributes_page(self.layer, filter_field="code", filter_op="=", filter_value="01")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["rows"][0]["attributes"]["name"], "天安门")
        self.assertEqual(page["definition_query"], {"field": "code", "op": "=", "value": "01"})
        numeric = self.store.attributes_page(self.layer, filter_field="pop", filter_op=">", filter_value="10")
        self.assertEqual(numeric["total"], 1)
        self.assertEqual(numeric["rows"][0]["attributes"]["pop"], 20.0)
        less = self.store.attributes_page(self.layer, filter_field="pop", filter_op="<", filter_value="20")
        self.assertEqual(less["total"], 1)
        not_equal = self.store.attributes_page(self.layer, filter_field="pop", filter_op="!=", filter_value="20")
        self.assertEqual(not_equal["total"], 1)
        self.assertEqual(not_equal["rows"][0]["attributes"]["pop"], 10.0)
        nulls = self.store.attributes_page(self.layer, filter_field="pop", filter_op="is null")
        self.assertEqual(nulls["total"], 1)
        non_nulls = self.store.attributes_page(self.layer, filter_field="pop", filter_op="is not null")
        self.assertEqual(non_nulls["total"], 2)
        contains = self.store.attributes_page(self.layer, filter_field="name", filter_op="contains", filter_value="故")
        self.assertEqual(contains["total"], 1)
        paged = self.store.attributes_page(self.layer, filter_field="pop", filter_op="is not null", sort="pop",
                                           descending=True, offset=1, limit=1)
        self.assertEqual(paged["total"], 2)
        self.assertEqual(len(paged["rows"]), 1)
        self.assertEqual(paged["rows"][0]["attributes"]["pop"], 10.0)

    def test_definition_query_rejects_unknown_operator_field_and_non_numeric_comparison(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.store.attributes_page(self.layer, filter_field="pop", filter_op=">=", filter_value="10")
        with self.assertRaisesRegex(ValueError, "unknown attribute query field"):
            self.store.attributes_page(self.layer, filter_field="missing", filter_op="=", filter_value="x")
        with self.assertRaisesRegex(ValueError, "Only numeric"):
            self.store.attributes_page(self.layer, filter_field="name", filter_op=">", filter_value="天")
        with self.assertRaisesRegex(ValueError, "valid number"):
            self.store.attributes_page(self.layer, filter_field="pop", filter_op=">", filter_value="abc")


if __name__ == "__main__":
    unittest.main()
