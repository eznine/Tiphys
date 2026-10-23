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
        self.assertEqual(len(tools), 8)
        self.assertIn("source_crs", tools["add_data"].inputSchema["properties"])
        self.assertTrue(tools["remove_layer"].annotations.destructiveHint)
        jobs.close()

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
