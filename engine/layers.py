"""Persistent analysis datasets with separate WGS84 map representations."""
from __future__ import annotations

import json
import math
import os
import re
import threading
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import geopandas as gpd
import pyogrio


@dataclass
class Layer:
    id: str
    name: str
    crs: str
    path: str | None
    feature_count: int
    geometry_types: list[str]
    bounds: list[float] | None
    url: str | None = None
    source_path: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class LayerStore:
    def __init__(self, data_dir: Path) -> None:
        self._lock = threading.RLock()
        self._layers: dict[str, Layer] = {}
        self._gdfs: dict[str, gpd.GeoDataFrame] = {}
        self.data_dir = data_dir.resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._manifest = self.data_dir / "workspace.json"
        if self._manifest.exists():
            for row in json.loads(self._manifest.read_text(encoding="utf-8"))["layers"]:
                layer = Layer(**row)
                for p in (layer.path, layer.meta["dataset_path"]):
                    if Path(p).resolve().parent != self.data_dir or not Path(p).is_file():
                        raise ValueError(f"Workspace dataset is missing or outside the project: {p}")
                self._layers[layer.id] = layer

    def _save(self, layers: dict[str, Layer]) -> None:
        tmp = self._manifest.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": 1, "layers": [asdict(v) for v in layers.values()]},
                                  ensure_ascii=False, allow_nan=False), encoding="utf-8")
        tmp.replace(self._manifest)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._public(layer) for layer in self._layers.values()]

    def get(self, layer_id: str) -> Layer | None:
        with self._lock:
            return self._layers.get(layer_id)

    def get_gdf(self, layer_id: str) -> gpd.GeoDataFrame | None:
        with self._lock:
            layer = self._layers.get(layer_id)
            if layer is None:
                return None
            if layer_id not in self._gdfs:
                self._gdfs[layer_id] = gpd.read_file(layer.meta["dataset_path"])
            return self._gdfs[layer_id].copy()

    def describe(self, layer_id: str) -> dict[str, Any]:
        with self._lock:
            layer = self._layers.get(layer_id)
            if layer is None:
                raise KeyError(f"unknown layer: {layer_id}")
            gdf = self.get_gdf(layer_id)
            assert gdf is not None
            cols = [c for c in gdf.columns if c != gdf.geometry.name]
            rows = json.loads(gdf.head(3).to_json(na="null", drop_id=True))["features"]
            return {**self._public(layer), "columns": cols, "sample": [r["properties"] for r in rows]}

    def add_from_path(self, path: str, name: str | None = None, source_crs: str | None = None) -> dict[str, Any]:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path(os.environ.get("TIPHYS_PROJECT_ROOT", Path(__file__).resolve().parent.parent)) / p
        p = p.resolve()
        if not p.is_file():
            raise FileNotFoundError(f"path not found: {p}")
        gdf = gpd.read_file(p)
        if source_crs:
            if gdf.crs is not None and gdf.crs != source_crs:
                raise ValueError("Dataset already has a different CRS; reproject rather than relabel it")
            gdf = gdf.set_crs(source_crs)
        return self.add_gdf(gdf, name=name or p.stem, source_path=str(p))

    def add_gdf(self, gdf: gpd.GeoDataFrame, name: str, source_path: str | None = None,
                layer_id: str | None = None, overwrite: bool = False) -> dict[str, Any]:
        if gdf.crs is None:
            raise ValueError("Dataset has no CRS. Specify source_crs explicitly; coordinates will not be guessed")
        present = gdf.geometry.notna() & ~gdf.geometry.is_empty
        if not gdf.loc[present].geometry.is_valid.all():
            raise ValueError("Dataset contains invalid geometries; repair them explicitly before analysis")
        lid = layer_id or f"lyr_{uuid.uuid4().hex[:12]}"
        if not re.fullmatch(r"lyr_[a-zA-Z0-9_]+", lid):
            raise ValueError("Invalid layer id")
        with self._lock:
            previous = self._layers.get(lid)
            if previous and not overwrite:
                raise FileExistsError(f"layer {lid} exists; pass overwrite=true to replace (needs approval)")
            stem = f"{lid}_{uuid.uuid4().hex[:8]}"
            dataset_path = self.data_dir / f"{stem}.gpkg"
            out_path = self.data_dir / f"{stem}.geojson"
            try:
                gdf_wgs = gdf.to_crs("EPSG:4326")
                display = gdf_wgs.explode(ignore_index=True)
                bounds = None
                if present.any():
                    bounds = [float(x) for x in gdf_wgs.loc[present].total_bounds]
                    if not all(math.isfinite(v) for v in bounds) or not (-180 <= bounds[0] <= bounds[2] <= 180 and -90 <= bounds[1] <= bounds[3] <= 90):
                        raise ValueError("Coordinates are outside WGS84 bounds; verify the dataset CRS")
                # GPKG otherwise consumes a user attribute named fid as its internal row id.
                columns = {str(c).casefold() for c in gdf.columns}
                fid_name = "_tiphys_fid"
                while fid_name.casefold() in columns:
                    fid_name += "_"
                gdf.to_file(dataset_path, layer="features", driver="GPKG", index=False, FID=fid_name)
                written = pyogrio.read_info(dataset_path, layer="features")
                expected_fields = {c for c in gdf.columns if c != gdf.geometry.name}
                if written["features"] != len(gdf) or gpd.GeoSeries([], crs=written["crs"]).crs != gdf.crs or set(written["fields"]) != expected_fields:
                    raise ValueError("Output verification failed: feature count, CRS or fields differ after writing")
                payload = json.loads(display.to_json(na="null", drop_id=True))
                out_path.write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                layer = Layer(lid, name, str(gdf.crs), str(out_path), len(gdf),
                              sorted(set(display.geometry.geom_type.dropna())), bounds,
                              f"/layers/{lid}.geojson", source_path,
                              {"source_crs": str(gdf.crs), "dataset_path": str(dataset_path)})
                updated = {**self._layers, lid: layer}
                self._save(updated)
            except BaseException:
                dataset_path.unlink(missing_ok=True)
                out_path.unlink(missing_ok=True)
                raise
            self._layers = updated
            self._gdfs[lid] = gdf.copy()
            if previous:
                Path(previous.path).unlink(missing_ok=True)
                Path(previous.meta["dataset_path"]).unlink(missing_ok=True)
            return self._public(layer)

    def remove(self, layer_ref: str) -> dict[str, Any]:
        with self._lock:
            lid = self.resolve(layer_ref)
            layer = self._layers[lid]
            updated = {k: v for k, v in self._layers.items() if k != lid}
            self._save(updated)
            self._layers = updated
            self._gdfs.pop(lid, None)
            Path(layer.path).unlink(missing_ok=True)
            Path(layer.meta["dataset_path"]).unlink(missing_ok=True)
            return {"ok": True, "removed": lid, "name": layer.name}

    def resolve(self, layer_ref: str) -> str:
        with self._lock:
            if layer_ref in self._layers:
                return layer_ref
            matches = [v.id for v in self._layers.values() if v.name == layer_ref]
            if len(matches) > 1:
                raise ValueError(f"Ambiguous layer name: {layer_ref}. Specify its layer id")
            if matches:
                return matches[0]
            raise KeyError(f"unknown layer: {layer_ref}")

    def snapshot(self) -> dict[str, Any]:
        return {"layers": self.list(), "crs_default": "EPSG:4326"}

    @staticmethod
    def _public(layer: Layer) -> dict[str, Any]:
        return {"id": layer.id, "name": layer.name, "crs": layer.crs, "display_crs": "EPSG:4326",
                "feature_count": layer.feature_count, "geometry_types": layer.geometry_types,
                "bounds": layer.bounds, "url": layer.url, "path": layer.meta["dataset_path"],
                "source_path": layer.source_path, "source_crs": layer.meta.get("source_crs")}
