"""In-memory GIS layer registry.

API shape for layers (id, name, crs, geojson path / inline) is intentionally
close to GeoLibre's project layer summaries and RustGIS Dataset naming so
tools like buffer(input, distance) stay familiar. See THIRD_PARTY_NOTICES.md.
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import geopandas as gpd


@dataclass
class Layer:
    id: str
    name: str
    crs: str
    path: str | None
    feature_count: int
    geometry_types: list[str]
    bounds: list[float] | None
    # Optional served relative URL for map (e.g. /layers/{id}.geojson)
    url: str | None = None
    source_path: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class LayerStore:
    def __init__(self, data_dir: Path) -> None:
        self._lock = threading.RLock()
        self._layers: dict[str, Layer] = {}
        self._gdfs: dict[str, gpd.GeoDataFrame] = {}
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._public(L) for L in self._layers.values()]

    def get(self, layer_id: str) -> Layer | None:
        with self._lock:
            return self._layers.get(layer_id)

    def get_gdf(self, layer_id: str) -> gpd.GeoDataFrame | None:
        with self._lock:
            gdf = self._gdfs.get(layer_id)
            return gdf.copy() if gdf is not None else None

    def describe(self, layer_id: str) -> dict[str, Any]:
        with self._lock:
            L = self._layers.get(layer_id)
            if L is None:
                raise KeyError(f"unknown layer: {layer_id}")
            gdf = self._gdfs[layer_id]
            cols = [c for c in gdf.columns if c != "geometry"]
            sample = []
            for _, row in gdf.head(3).iterrows():
                sample.append({c: _jsonable(row[c]) for c in cols})
            out = self._public(L)
            out["columns"] = cols
            out["sample"] = sample
            return out

    def add_from_path(self, path: str, name: str | None = None) -> dict[str, Any]:
        p = Path(path).expanduser().resolve()
        if not p.exists():
            raise FileNotFoundError(f"path not found: {p}")
        gdf = gpd.read_file(p)
        return self.add_gdf(gdf, name=name or p.stem, source_path=str(p))

    def add_gdf(
        self,
        gdf: gpd.GeoDataFrame,
        name: str,
        source_path: str | None = None,
        layer_id: str | None = None,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        if gdf.crs is None:
            gdf = gdf.set_crs("EPSG:4326")
        lid = layer_id or f"lyr_{uuid.uuid4().hex[:8]}"
        with self._lock:
            if lid in self._layers and not overwrite:
                raise FileExistsError(
                    f"layer {lid} exists; pass overwrite=true to replace (needs approval)"
                )
            out_path = self.data_dir / f"{lid}.geojson"
            # Always write WGS84 GeoJSON for MapLibre
            gdf_wgs = gdf.to_crs("EPSG:4326") if gdf.crs and str(gdf.crs) != "EPSG:4326" else gdf
            gdf_wgs.to_file(out_path, driver="GeoJSON")
            geom_types = sorted({str(g).split()[0] for g in gdf_wgs.geometry if g is not None})
            bounds = None
            try:
                b = gdf_wgs.total_bounds  # minx,miny,maxx,maxy
                bounds = [float(x) for x in b]
            except Exception:
                pass
            layer = Layer(
                id=lid,
                name=name,
                crs="EPSG:4326",
                path=str(out_path),
                feature_count=len(gdf_wgs),
                geometry_types=geom_types,
                bounds=bounds,
                url=f"/layers/{lid}.geojson",
                source_path=source_path,
                meta={"source_crs": str(gdf.crs) if gdf.crs else None},
            )
            self._layers[lid] = layer
            self._gdfs[lid] = gdf_wgs
            return self._public(layer)

    def remove(self, layer_ref: str) -> dict[str, Any]:
        with self._lock:
            lid = self.resolve(layer_ref)
            L = self._layers.pop(lid)
            self._gdfs.pop(lid, None)
            if L.path:
                Path(L.path).unlink(missing_ok=True)
            return {"ok": True, "removed": lid, "name": L.name}

    def resolve(self, layer_ref: str) -> str:
        """Resolve id or name to layer id."""
        with self._lock:
            if layer_ref in self._layers:
                return layer_ref
            for L in self._layers.values():
                if L.name == layer_ref:
                    return L.id
            raise KeyError(f"unknown layer: {layer_ref}")

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "layers": [self._public(L) for L in self._layers.values()],
                "crs_default": "EPSG:4326",
            }

    @staticmethod
    def _public(L: Layer) -> dict[str, Any]:
        return {
            "id": L.id,
            "name": L.name,
            "crs": L.crs,
            "feature_count": L.feature_count,
            "geometry_types": L.geometry_types,
            "bounds": L.bounds,
            "url": L.url,
            "path": L.path,
            "source_path": L.source_path,
            "source_crs": L.meta.get("source_crs"),
        }


def _jsonable(v: Any) -> Any:
    if hasattr(v, "item"):
        try:
            return v.item()
        except Exception:
            pass
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return str(v)
