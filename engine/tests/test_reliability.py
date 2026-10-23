import json
import sys
import tempfile
import threading
import unittest
import asyncio
import os
from unittest.mock import patch
from pathlib import Path

import geopandas as gpd
from pyproj import Geod
from shapely.geometry import Point, GeometryCollection, LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from layers import LayerStore
from jobs import JobRegistry
from geo_ops import buffer_sync, start_buffer_job


class SpatialReliability(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tiphys-test-")
        self.dir = Path(self.temp.name)
        self.store = LayerStore(self.dir)

    def tearDown(self):
        self.temp.cleanup()

    def point(self):
        return self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(116.4, 39.9)], crs=4326), "source")

    def test_unknown_crs_rejected_without_output(self):
        with self.assertRaisesRegex(ValueError, "no CRS"):
            self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(500000, 4400000)]), "unknown")
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_relative_input_resolves_against_the_host_project_root(self):
        source = self.dir / "input.geojson"
        gpd.GeoDataFrame(geometry=[Point(116, 40)], crs=4326).to_file(source, driver="GeoJSON")
        with patch.dict(os.environ, {"TIPHYS_PROJECT_ROOT": str(self.dir)}):
            info = self.store.add_from_path("input.geojson")
        self.assertEqual(info["source_path"], str(source))

    def test_shared_mcp_contract_exposes_crs_and_destructive_annotations(self):
        from mcp.server.fastmcp import FastMCP
        from tools import register_tools
        mcp = FastMCP("test")
        jobs = JobRegistry()
        register_tools(mcp, self.store, jobs)
        tools = {tool.name: tool for tool in asyncio.run(mcp.list_tools())}
        self.assertEqual(len(tools), 34)
        self.assertIn("source_crs", tools["add_data"].inputSchema["properties"])
        self.assertIn("name", tools["rename_layer"].inputSchema["properties"])
        self.assertIn("layer_ids", tools["reorder_layers"].inputSchema["properties"])
        self.assertIn("field", tools["field_statistics"].inputSchema["properties"])
        self.assertTrue(tools["remove_layer"].annotations.destructiveHint)
        self.assertTrue(tools["export_features"].annotations.destructiveHint)
        self.assertEqual(tools["select_by_location"].inputSchema["properties"]["predicate"]["enum"],
                         ["intersects", "within", "contains", "crosses", "touches", "overlaps"])
        self.assertEqual(tools["spatial_join"].inputSchema["properties"]["predicate"]["enum"],
                         ["intersects", "contains", "within", "nearest"])

        # GEE and ArcGIS stubs return explicit structured limitations, not fake data.
        _, auth = asyncio.run(mcp.call_tool("gee_auth_status", {}))
        self.assertFalse(auth["connected"])
        _, search = asyncio.run(mcp.call_tool("gee_search_collection", {"collection": "COPERNICUS/S2_SR_HARMONIZED"}))
        self.assertEqual(search["items"], [])
        _, formats = asyncio.run(mcp.call_tool("list_supported_formats", {}))
        self.assertIn("GeoPackage", " ".join(formats["preferred"]))
        _, arcgis = asyncio.run(mcp.call_tool("import_arcgis_project", {"path": "project.aprx"}))
        self.assertFalse(arcgis["supported"])
        jobs.close()

    def test_overlay_dissolve_and_selection_tools(self):
        from geo_ops import overlay_sync, dissolve_sync, select_attributes_sync, select_location_sync
        polys = gpd.GeoDataFrame(
            {"zone": ["a", "b"]},
            geometry=[Point(116.4, 39.9).buffer(0.01), Point(116.5, 39.95).buffer(0.01)],
            crs=4326,
        )
        mask = gpd.GeoDataFrame(geometry=[Point(116.4, 39.9).buffer(0.005)], crs=4326)
        poly_layer = self.store.add_gdf(polys, "zones")["id"]
        mask_layer = self.store.add_gdf(mask, "mask")["id"]
        clipped = overlay_sync(self.store, "clip", poly_layer, mask_layer)
        self.assertEqual(clipped["feature_count"], 1)
        self.assertEqual(clipped["layer"]["name"], "zones_clip")
        erased = overlay_sync(self.store, "difference", poly_layer, mask_layer, output_name="rest")
        # Both circles survive: the first with a hole, the second untouched.
        self.assertEqual(erased["feature_count"], 2)
        pts = self.store.add_gdf(gpd.GeoDataFrame(
            {"name": ["公园", "站"]},
            geometry=[Point(116.4, 39.9), Point(116.5, 39.95)],
            crs=4326,
        ), "pts")["id"]
        selected = select_attributes_sync(self.store, pts, "name", "contains", "公")
        self.assertEqual(selected["feature_count"], 1)
        located = select_location_sync(self.store, pts, mask_layer, "intersects")
        self.assertEqual(located["feature_count"], 1)
        merged = dissolve_sync(self.store, pts)
        self.assertEqual(merged["feature_count"], 1)
        grouped = dissolve_sync(self.store, poly_layer, by_field="zone")
        self.assertEqual(grouped["feature_count"], 2)

    def test_spatial_join_transfers_attributes_and_nearest_distance(self):
        from geo_ops import spatial_join_sync
        points = self.store.add_gdf(gpd.GeoDataFrame(
            {"name": ["one", "two"]},
            geometry=[Point(116.4, 39.9), Point(116.5, 39.95)],
            crs=4326,
        ), "join_points")["id"]
        zones = self.store.add_gdf(gpd.GeoDataFrame(
            {"zone": ["a", "b"], "score": [1, 2]},
            geometry=[Point(116.4, 39.9).buffer(0.01), Point(116.5, 39.95).buffer(0.01)],
            crs=4326,
        ), "join_zones")["id"]
        joined = spatial_join_sync(self.store, points, zones, "intersects")
        frame = self.store.get_gdf(joined["layer"]["id"])
        self.assertEqual(joined["feature_count"], 2)
        self.assertEqual(frame["JOIN_zone"].tolist(), ["a", "b"])
        self.assertEqual(frame["JOIN_score"].tolist(), [1, 2])
        target_only = spatial_join_sync(self.store, points, zones, "intersects", keep_fields=False)
        target_frame = self.store.get_gdf(target_only["layer"]["id"])
        self.assertFalse(any(str(column).startswith("JOIN_") for column in target_frame.columns))
        nearest = spatial_join_sync(self.store, points, zones, "nearest")
        nearest_frame = self.store.get_gdf(nearest["layer"]["id"])
        self.assertEqual(len(nearest_frame), 2)
        self.assertTrue(nearest_frame["NEAR_DIST"].notna().all())
        self.assertEqual(nearest_frame["JOIN_zone"].tolist(), ["a", "b"])

    def test_reproject_export_and_geometry_tools(self):
        from geo_ops import reproject_sync, export_sync, calculate_geometry_sync
        src = self.store.add_gdf(
            gpd.GeoDataFrame({"v": [1]}, geometry=[Point(116.4, 39.9).buffer(0.001)], crs=4326),
            "area",
        )
        repro = reproject_sync(self.store, src["id"], "EPSG:32650")
        self.assertEqual(self.store.get_gdf(repro["layer"]["id"]).crs.to_epsg(), 32650)
        with self.assertRaisesRegex(ValueError, "already in"):
            reproject_sync(self.store, repro["layer"]["id"], "EPSG:32650")
        measured = calculate_geometry_sync(self.store, src["id"])
        row = self.store.get_gdf(measured["layer"]["id"]).iloc[0]
        self.assertGreater(row["area_m2"], 1000)
        out = self.dir / "exported.geojson"
        exported = export_sync(self.store, src["id"], str(out), fmt="geojson")
        self.assertTrue(out.is_file())
        self.assertEqual(exported["feature_count"], 1)
        csv_path = self.dir / "exported.csv"
        export_sync(self.store, src["id"], str(csv_path), fmt="csv")
        csv_rows = csv_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(csv_rows[0], "v,geometry")
        self.assertIn("POLYGON", csv_rows[1])
        with self.assertRaisesRegex(ValueError, "absolute"):
            export_sync(self.store, src["id"], "relative.geojson")

    def test_manual_tool_dispatch_matches_mcp_contract(self):
        import time
        from mcp.server.fastmcp import FastMCP
        from tools import register_tools
        mcp = FastMCP("test")
        pts = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(116.4, 39.9)], crs=4326), "p")["id"]
        jobs = JobRegistry()
        register_tools(mcp, self.store, jobs)
        _, job = asyncio.run(mcp.call_tool("convex_hull", {"layer": pts}))
        while jobs.status(job["job_id"])["status"] in ("queued", "running"):
            time.sleep(0.05)
        status = jobs.status(job["job_id"])
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["result"]["layer"]["feature_count"], 1)
        jobs.close()

    def test_attribute_selection_preserves_numeric_null_and_string_semantics(self):
        from geo_ops import select_attributes_sync
        source = self.store.add_gdf(gpd.GeoDataFrame(
            {"n": [2.0, 10.0, None], "code": ["002", "010", " 002 "]},
            geometry=[Point(116, 40)] * 3, crs=4326), "values")["id"]
        selected = select_attributes_sync(self.store, source, "n", "gt", "3")
        self.assertEqual(self.store.get_gdf(selected["layer"]["id"])["n"].tolist(), [10])
        selected = select_attributes_sync(self.store, source, "code", "eq", "002")
        self.assertEqual(selected["feature_count"], 1)
        selected = select_attributes_sync(self.store, source, "n", "contains", "0")
        self.assertEqual(selected["feature_count"], 2)

    def test_location_selection_matches_any_filter_feature_without_duplicates(self):
        from geo_ops import select_location_sync
        source = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(116, 40).buffer(.01)], crs=4326), "area")["id"]
        filters = self.store.add_gdf(gpd.GeoDataFrame(
            geometry=[Point(116, 40), Point(116.001, 40), Point(117, 40)], crs=4326), "points")["id"]
        selected = select_location_sync(self.store, source, filters, "contains")
        self.assertEqual(selected["feature_count"], 1)

    def test_overlay_preserves_input_native_crs_and_geometry(self):
        from geo_ops import overlay_sync
        from shapely.geometry import box
        a = self.store.add_gdf(gpd.GeoDataFrame({"a": [1]}, geometry=[box(500000, 4400000, 501000, 4401000)], crs=32650), "a")["id"]
        b = self.store.add_gdf(gpd.GeoDataFrame({"b": [2]}, geometry=[box(500500, 4400000, 501500, 4401000)], crs=32650), "b")["id"]
        for how, expected in [("clip", 500000), ("intersection", 500000), ("difference", 500000), ("union", 1500000)]:
            with self.subTest(how=how):
                result = overlay_sync(self.store, how, a, b)
                frame = self.store.get_gdf(result["layer"]["id"])
                self.assertEqual(frame.crs.to_epsg(), 32650)
                self.assertAlmostEqual(frame.geometry.area.sum(), expected, delta=2)

    def test_export_cancel_before_commit_preserves_existing_target(self):
        from geo_ops import start_export_job
        source = self.point()["id"]
        target = self.dir / "existing.geojson"
        target.write_bytes(b"original")
        jobs = JobRegistry()
        jobs.on_event(lambda e: jobs.cancel(e["job_id"]) if e.get("progress") == .9 else None)
        job = start_export_job(self.store, jobs, source, str(target), overwrite=True)
        jobs._pool.shutdown(wait=True)
        self.assertEqual(jobs.status(job["job_id"])["status"], "cancelled")
        self.assertEqual(target.read_bytes(), b"original")
        self.assertEqual(list(self.dir.glob(".tiphys-export-*")), [])

    def test_export_requires_overwrite_and_preserves_fid_and_crs(self):
        from geo_ops import export_sync
        source = self.store.add_gdf(gpd.GeoDataFrame({"fid": [123]}, geometry=[Point(116, 40)], crs=4326).to_crs(32650), "source")["id"]
        target = self.dir / "features.gpkg"
        target.write_bytes(b"original")
        with self.assertRaises(FileExistsError):
            export_sync(self.store, source, str(target), fmt="gpkg")
        self.assertEqual(target.read_bytes(), b"original")
        result = export_sync(self.store, source, str(target), fmt="gpkg", overwrite=True)
        frame = gpd.read_file(result["path"])
        self.assertEqual(frame["fid"].tolist(), [123])
        self.assertEqual(frame.crs.to_epsg(), 32650)
        geojson = self.dir / "features.geojson"
        export_sync(self.store, source, str(geojson))
        self.assertEqual(gpd.read_file(geojson).crs.to_epsg(), 4326)
        flatgeobuf = self.dir / "features.fgb"
        result = export_sync(self.store, source, str(flatgeobuf), fmt="fgb")
        frame = gpd.read_file(result["path"])
        self.assertEqual(len(frame), 1)
        self.assertEqual(frame["fid"].tolist(), [123])
        self.assertEqual(frame.crs.to_epsg(), 32650)
        with self.assertRaisesRegex(ValueError, "managed"):
            export_sync(self.store, source, self.store.list()[0]["path"], fmt="gpkg", overwrite=True)

    def test_failed_export_does_not_replace_target(self):
        from geo_ops import export_sync
        source = self.point()["id"]
        target = self.dir / "existing.geojson"
        target.write_bytes(b"original")
        with patch.object(gpd.GeoDataFrame, "to_file", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                export_sync(self.store, source, str(target), overwrite=True)
        self.assertEqual(target.read_bytes(), b"original")

    def test_native_crs_and_attributes_survive_restart(self):
        gdf = gpd.GeoDataFrame({"name": ["测试"], "value": [None]}, geometry=[Point(116.4, 39.9)], crs=4326).to_crs(32650)
        info = self.store.add_gdf(gdf, "native")
        restored = LayerStore(self.dir)
        data = restored.get_gdf(info["id"])
        self.assertEqual(data.crs.to_epsg(), 32650)
        self.assertAlmostEqual(data.geometry.iloc[0].x, gdf.geometry.iloc[0].x, places=6)
        self.assertEqual(restored.describe(info["id"])["sample"][0]["name"], "测试")
        self.assertTrue(Path(info["path"]).is_file())

    def test_fid_attribute_is_not_consumed_as_internal_geopackage_id(self):
        gdf = gpd.GeoDataFrame({"fid": [123], "_tiphys_fid": [456]}, geometry=[Point(116, 40)], crs=4326)
        info = self.store.add_gdf(gdf, "identifiers")
        restored = LayerStore(self.dir).get_gdf(info["id"])
        self.assertEqual(restored["fid"].tolist(), [123])
        self.assertEqual(restored["_tiphys_fid"].tolist(), [456])

    def test_empty_layer_is_json_compliant(self):
        info = self.store.add_gdf(gpd.GeoDataFrame(geometry=[], crs=4326), "empty")
        self.assertIsNone(info["bounds"])
        json.dumps(info, allow_nan=False)
        self.assertEqual(len(LayerStore(self.dir).get_gdf(info["id"])), 0)

    def test_geometry_collection_display_is_flattened(self):
        gdf = gpd.GeoDataFrame(geometry=[GeometryCollection([Point(0, 0), LineString([(0, 0), (1, 1)])])], crs=4326)
        info = self.store.add_gdf(gdf, "mixed")
        self.assertEqual(info["geometry_types"], ["LineString", "Point"])
        self.assertEqual(info["feature_count"], 1)

    def test_ambiguous_names_require_id(self):
        self.point()
        self.point()
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            self.store.resolve("source")

    def test_local_buffer_distance_independently_measured(self):
        src = self.point()
        out = buffer_sync(self.store, src["id"], 500)
        gdf = self.store.get_gdf(out["layer"]["id"]).to_crs(4326)
        geod = Geod(ellps="WGS84")
        radii = [geod.inv(116.4, 39.9, x, y)[2] for x, y in gdf.geometry.iloc[0].exterior.coords]
        self.assertTrue(all(497.5 <= v <= 502.5 for v in radii))

    def test_wide_extent_rejected_without_result(self):
        src = self.store.add_gdf(gpd.GeoDataFrame(geometry=[Point(0, 0), Point(120, 0)], crs=4326), "wide")
        with self.assertRaisesRegex(ValueError, "local regions"):
            buffer_sync(self.store, src["id"], 500)
        self.assertEqual(len(self.store.list()), 1)

    def test_nonfinite_distance_rejected(self):
        src = self.point()
        for distance in [float("nan"), float("inf")]:
            with self.assertRaisesRegex(ValueError, "finite"):
                buffer_sync(self.store, src["id"], distance)

    def test_cancel_before_commit_leaves_no_result(self):
        src = self.point()
        jobs = JobRegistry()
        jobs.on_event(lambda e: jobs.cancel(e["job_id"]) if e.get("progress") == 0.85 else None)
        job = start_buffer_job(self.store, jobs, src["id"], 500)
        jobs._pool.shutdown(wait=True)
        self.assertEqual(jobs.status(job["job_id"])["status"], "cancelled")
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(len(list(self.dir.glob("*.gpkg"))), 1)

    def test_cancel_after_commit_preserves_completed_result(self):
        src = self.point()
        jobs = JobRegistry()
        job = start_buffer_job(self.store, jobs, src["id"], 500)
        jobs._pool.shutdown(wait=True)
        state = jobs.cancel(job["job_id"])
        self.assertEqual(state["status"], "completed")
        self.assertTrue(Path(state["result"]["layer"]["path"]).is_file())

    def test_failed_manifest_commit_preserves_prior_workspace(self):
        src = self.point()
        original = self.store._save
        self.store._save = lambda _: (_ for _ in ()).throw(OSError("disk full"))
        with self.assertRaises(OSError):
            self.point()
        self.store._save = original
        self.assertEqual([v["id"] for v in LayerStore(self.dir).list()], [src["id"]])
        self.assertEqual(len(list(self.dir.glob("*.gpkg"))), 1)


class JobReliability(unittest.TestCase):
    def test_running_cancel_is_not_reported_settled_until_worker_stops(self):
        jobs = JobRegistry()
        entered = threading.Event()
        release = threading.Event()
        def worker(job, report):
            entered.set()
            release.wait(5)
            report(0.5)
            return {}
        job = jobs.start("test", "running", worker)
        self.assertTrue(entered.wait(5))
        self.assertEqual(jobs.cancel(job["job_id"])["status"], "cancelling")
        release.set()
        jobs._pool.shutdown(wait=True)
        self.assertEqual(jobs.status(job["job_id"])["status"], "cancelled")

    def test_queued_cancel_never_executes(self):
        jobs = JobRegistry(max_workers=1)
        gate = threading.Event()
        entered = threading.Event()
        ran = []
        def first(job, report):
            entered.set()
            gate.wait(5)
            return {"ok": True}
        jobs.start("test", "blocker", first)
        self.assertTrue(entered.wait(5))
        second = jobs.start("test", "queued", lambda j, r: (ran.append(True) or {}))
        jobs.cancel(second["job_id"])
        gate.set()
        jobs._pool.shutdown(wait=True)
        self.assertEqual(ran, [])
        self.assertEqual(jobs.status(second["job_id"])["status"], "cancelled")

    def test_restart_marks_unsettled_jobs_interrupted(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "jobs.json"
            p.write_text(json.dumps([{"id": "job_old", "kind": "buffer", "label": "old", "status": "running"}]))
            jobs = JobRegistry(state_path=p)
            self.assertEqual(jobs.status("job_old")["status"], "interrupted")
            jobs.close()


if __name__ == "__main__":
    unittest.main()
