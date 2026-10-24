"""Persistent analysis datasets with separate WGS84 map representations."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd
import pyogrio


_ATTRIBUTE_OPERATORS = {
    "=": "=", "==": "=", "eq": "=",
    "!=": "!=", "<>": "!=", "ne": "!=",
    "contains": "contains",
    ">": ">", "gt": ">",
    "<": "<", "lt": "<",
    "is null": "is null", "isnull": "is null",
    "is not null": "is not null", "notnull": "is not null",
}
_RESERVED_FIELD_NAMES = {"id", "fid", "objectid", "ogc_fid", "_tiphys_fid", "geometry", "geom"}


def normalize_attribute_operator(raw: str) -> str:
    key = " ".join((raw or "").strip().lower().split())
    return _ATTRIBUTE_OPERATORS.get(key, "")


def validate_field_name(raw: str) -> str:
    name = (raw or "").strip()
    if not name:
        raise ValueError("New field name must not be empty")
    if len(name) > 64:
        raise ValueError("New field name must be at most 64 characters")
    if not re.fullmatch(r"[\w][\w \-]*", name, flags=re.UNICODE):
        raise ValueError("New field name must start with a letter, number or underscore and contain only letters, numbers, spaces, underscores and hyphens")
    return name


def filter_attribute_frame(frame: gpd.GeoDataFrame, field: str, operator: str,
                           raw_value: str | None, geometry_field: str) -> gpd.GeoDataFrame:
    if not field:
        raise ValueError("filter_field is required when a definition query is used")
    if field not in frame.columns or field == geometry_field:
        raise ValueError(f"unknown attribute query field: {field}")
    op = normalize_attribute_operator(operator or "=")
    if not op:
        raise ValueError(f"unsupported definition query operator: {operator}")
    value = "" if raw_value is None else str(raw_value)
    column = frame[field]
    if op == "is null":
        return frame.loc[column.isna()]
    if op == "is not null":
        return frame.loc[column.notna()]
    if op == "contains":
        if not value:
            raise ValueError("contains definition query needs a value")
        mask = column.astype("string").str.contains(value, case=False, regex=False).fillna(False)
        return frame.loc[mask]
    if pd.api.types.is_bool_dtype(column) and op in {"=", "!="}:
        folded = value.strip().lower()
        if folded not in {"true", "false", "1", "0"}:
            raise ValueError("Boolean definition query needs true/false or 1/0")
        target = folded in {"true", "1"}
        mask = column.notna() & ((column == target) if op == "=" else (column != target))
        return frame.loc[mask]
    numeric = pd.api.types.is_numeric_dtype(column) and not pd.api.types.is_bool_dtype(column)
    if op in {">", "<"}:
        if not numeric:
            raise ValueError("Only numeric fields support > / < definition queries")
        try:
            target = float(value)
        except ValueError as exc:
            raise ValueError("Numeric definition query needs a valid number") from exc
        mask = column.notna() & ((column > target) if op == ">" else (column < target))
        return frame.loc[mask]
    if numeric:
        try:
            target = float(value)
        except ValueError as exc:
            raise ValueError("Numeric definition query needs a valid number") from exc
        mask = column.notna() & ((column == target) if op == "=" else (column != target))
        return frame.loc[mask]
    mask = column.astype("string") == value
    if op == "!=":
        mask = column.notna() & ~mask.fillna(False)
    return frame.loc[mask]


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
                    if p is None:
                        continue
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
            if self._is_raster(layer):
                raise ValueError(f"Layer {layer.name!r} is a raster; get_gdf only reads vector layers")
            if layer_id not in self._gdfs:
                self._gdfs[layer_id] = gpd.read_file(layer.meta["dataset_path"])
            return self._gdfs[layer_id].copy()

    def describe(self, layer_id: str) -> dict[str, Any]:
        with self._lock:
            layer = self._layers.get(layer_id)
            if layer is None:
                raise KeyError(f"unknown layer: {layer_id}")
            if self._is_raster(layer):
                return {**self._public(layer), "columns": [], "sample": []}
            gdf = self.get_gdf(layer_id)
            assert gdf is not None
            cols = [c for c in gdf.columns if c != gdf.geometry.name]
            rows = json.loads(gdf.head(3).to_json(na="null", drop_id=True))["features"]
            return {**self._public(layer), "columns": cols, "sample": [r["properties"] for r in rows]}

    def inspect(self, layer_id: str, max_hash_bytes: int = 64 * 1024 * 1024) -> dict[str, Any]:
        """Read-only facts about where a layer really lives and what it contains.

        The map representation (`url`) is a WGS84 display copy; `data.location`
        is the analysis dataset an executor must read. Callers must not infer
        the latter from the former.
        """
        with self._lock:
            layer = self._layers.get(layer_id)
            if layer is None:
                raise KeyError(f"unknown layer: {layer_id}")
            dataset = Path(layer.meta["dataset_path"])
            stat = dataset.stat()
            suffix = dataset.suffix.lower().lstrip(".") or "unknown"
            sha256 = None
            if stat.st_size <= max_hash_bytes:
                digest = hashlib.sha256()
                with dataset.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                sha256 = f"sha256:{digest.hexdigest()}"
            revision = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            data_ref = {
                "engine": "desktop-python", "storage": "file", "location": str(dataset),
                "sourcePath": layer.source_path, "format": suffix, "bytes": stat.st_size,
                "sha256": sha256, "revision": f"{revision}:{stat.st_size}" + (f":{sha256[7:15]}" if sha256 else ""),
            }
            if self._is_raster(layer):
                import rasterio

                with rasterio.open(dataset) as src:
                    raster = {"width": src.width, "height": src.height, "bands": src.count,
                              "nodata": src.nodata, "dtype": src.dtypes[0],
                              "pixelSize": [abs(float(src.res[0])), abs(float(src.res[1]))]}
                    crs = f"EPSG:{src.crs.to_epsg()}" if src.crs and src.crs.to_epsg() else (str(src.crs) if src.crs else "")
                    native_bounds = [float(v) for v in src.bounds]
                return {"layer": {"id": layer.id, "name": layer.name, "kind": "raster", "crs": crs,
                                  "displayCrs": "EPSG:4326", "geometryTypes": [], "featureCount": 0,
                                  "bounds": layer.bounds, "raster": raster, "data": data_ref},
                        "fields": [], "rasterStats": None,
                        "extra": {"nativeBounds": native_bounds, "displayUrl": layer.url}}

            gdf = self.get_gdf(layer_id)
            assert gdf is not None
            fields: list[dict[str, Any]] = []
            for column in gdf.columns:
                if column == gdf.geometry.name:
                    continue
                series = gdf[column]
                kind = "string"
                if series.dtype.kind in "iu":
                    kind = "integer"
                elif series.dtype.kind == "f":
                    kind = "number"
                elif series.dtype.kind == "b":
                    kind = "boolean"
                elif series.dtype.kind in "mM":
                    kind = "date"
                sample = series.dropna().iloc[0] if series.notna().any() else None
                if hasattr(sample, "item"):
                    sample = sample.item()
                fields.append({"name": str(column), "type": kind, "nullCount": int(series.isna().sum()),
                               "sample": sample})
            native = [float(v) for v in gdf.total_bounds] if len(gdf) else None
            if native and not all(math.isfinite(v) for v in native):
                native = None
            return {"layer": {"id": layer.id, "name": layer.name, "kind": "vector", "crs": layer.crs,
                              "displayCrs": "EPSG:4326", "geometryTypes": list(layer.geometry_types),
                              "featureCount": int(layer.feature_count), "bounds": layer.bounds,
                              "data": data_ref},
                    "fields": fields, "rasterStats": None,
                    "extra": {"nativeBounds": native, "displayUrl": layer.url, "columns": len(fields)}}

    def inspect_workspace(self) -> dict[str, Any]:
        layers: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        for layer in self.list():
            try:
                layers.append(self.inspect(layer["id"]))
            except Exception as exc:  # keep the rest of the workspace inspectable
                errors.append({"layerId": layer["id"], "message": str(exc)})
        return {"engine": "desktop-python", "layers": layers, "errors": errors}

    def add_from_path(self, path: str, name: str | None = None, source_crs: str | None = None) -> dict[str, Any]:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path(os.environ.get("TIPHYS_PROJECT_ROOT", Path(__file__).resolve().parent.parent)) / p
        p = p.resolve()
        if not p.is_file():
            raise FileNotFoundError(f"path not found: {p}")
        if p.suffix.lower() in {".tif", ".tiff"}:
            return self.add_raster(p, name=name, source_crs=source_crs)
        gdf = gpd.read_file(p)
        if source_crs:
            if gdf.crs is not None and gdf.crs != source_crs:
                raise ValueError("Dataset already has a different CRS; reproject rather than relabel it")
            gdf = gdf.set_crs(source_crs)
        return self.add_gdf(gdf, name=name or p.stem, source_path=str(p))

    def add_raster(self, path: str | Path, name: str | None = None,
                   source_crs: str | None = None, layer_id: str | None = None,
                   overwrite: bool = False) -> dict[str, Any]:
        """Register a GeoTIFF as a raster layer backed by a managed copy."""
        import rasterio
        from rasterio.warp import transform_bounds

        if source_crs:
            raise ValueError("source_crs is for vector data; a GeoTIFF must carry its own CRS")
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path(os.environ.get("TIPHYS_PROJECT_ROOT", Path(__file__).resolve().parent.parent)) / p
        p = p.resolve()
        if not p.is_file():
            raise FileNotFoundError(f"path not found: {p}")
        suffix = p.suffix.lower()
        if suffix not in {".tif", ".tiff"}:
            raise ValueError(f"not a GeoTIFF: {p}")

        lid = layer_id or f"lyr_{uuid.uuid4().hex[:12]}"
        if not re.fullmatch(r"lyr_[a-zA-Z0-9_]+", lid):
            raise ValueError("Invalid layer id")
        with self._lock:
            previous = self._layers.get(lid)
            if previous and not overwrite:
                raise FileExistsError(f"layer {lid} exists; pass overwrite=true to replace (needs approval)")
        dataset_path = self.data_dir / f"{lid}_{uuid.uuid4().hex[:8]}{suffix}"
        try:
            with rasterio.open(p) as src:
                if src.crs is None:
                    raise ValueError("GeoTIFF has no CRS; analysis cannot place its pixels")
                source_crs_text = (f"EPSG:{src.crs.to_epsg()}" if src.crs.to_epsg()
                                   else str(src.crs))
                bounds_wgs84 = [float(v) for v in transform_bounds(
                    src.crs, "EPSG:4326", *src.bounds, densify_pts=21)]
                width, height, bands = src.width, src.height, src.count
            if not all(math.isfinite(v) for v in bounds_wgs84):
                raise ValueError("GeoTIFF bounds could not be transformed to WGS84")
            if not (-180 <= bounds_wgs84[0] <= bounds_wgs84[2] <= 180
                    and -90 <= bounds_wgs84[1] <= bounds_wgs84[3] <= 90):
                raise ValueError("GeoTIFF bounds are outside WGS84; verify its CRS")
            shutil.copy2(p, dataset_path)
            with rasterio.open(dataset_path) as copy:
                if (copy.width, copy.height, copy.count) != (width, height, bands):
                    raise ValueError("Raster copy verification failed: dimensions differ")
            layer = Layer(lid, name or p.stem, source_crs_text, None, 0, [], bounds_wgs84,
                          None, str(p), {"kind": "raster", "source_crs": source_crs_text,
                                         "dataset_path": str(dataset_path)})
            with self._lock:
                updated = {**self._layers, lid: layer}
                self._save(updated)
                self._layers = updated
            if previous:
                Path(previous.meta["dataset_path"]).unlink(missing_ok=True)
            return self._public(layer)
        except BaseException:
            dataset_path.unlink(missing_ok=True)
            raise

    def reload(self, layer_ref: str) -> dict[str, Any]:
        """Re-read a layer from its original path while preserving its id and name."""
        with self._lock:
            lid = self.resolve(layer_ref)
            layer = self._layers[lid]
            if not layer.source_path:
                raise ValueError("Layer has no original source path; reload is unavailable")
            source = Path(layer.source_path).expanduser()
            if not source.is_absolute():
                source = Path(os.environ.get("TIPHYS_PROJECT_ROOT", Path(__file__).resolve().parent.parent)) / source
            source = source.resolve()
            if not source.is_file():
                raise FileNotFoundError(f"original source path is unavailable: {source}")
            if self._is_raster(layer):
                return self.add_raster(source, name=layer.name, layer_id=lid, overwrite=True)
            gdf = gpd.read_file(source)
            source_crs = layer.meta.get("source_crs")
            if gdf.crs is None and source_crs:
                gdf = gdf.set_crs(source_crs)
            return self.add_gdf(gdf, name=layer.name, source_path=str(source), layer_id=lid, overwrite=True)

    def attributes_page(self, layer_ref: str, offset: int = 0, limit: int = 100,
                        search: str = "", sort: str | None = None, descending: bool = False,
                        filter_field: str = "", filter_op: str = "", filter_value: str | None = None) -> dict[str, Any]:
        """Paged rows with an optional single-field definition query.

        `search` remains a global substring search across every attribute field.
        A definition query is separate, field-qualified, and combined with the
        global search using AND. Both filter the total returned to the caller.
        """
        if offset < 0 or limit < 1 or limit > 500:
            raise ValueError("offset must be >= 0 and limit must be between 1 and 500")
        frame = self.get_gdf(layer_ref)
        if frame is None:
            raise KeyError(f"unknown layer: {layer_ref}")
        frame = frame.reset_index(drop=True)
        geometry_field = frame.geometry.name
        columns = [c for c in frame.columns if c != geometry_field]
        fields = [{"name": c, "type": str(frame[c].dtype)} for c in columns]
        if search:
            mask = frame[columns].astype("string").apply(
                lambda s: s.str.contains(search, case=False, regex=False)).fillna(False).any(axis=1)
            frame = frame.loc[mask]
        if filter_field:
            frame = filter_attribute_frame(frame, filter_field, filter_op or "=", filter_value, geometry_field)
        if sort:
            if sort not in columns:
                raise ValueError("unknown sort field")
            frame = frame.sort_values(sort, ascending=not descending, kind="stable", na_position="last")
        total = len(frame)
        page = frame.iloc[offset:offset + limit]
        values = json.loads(page[columns].to_json(orient="records", date_format="iso"))
        geometries = page.to_crs(4326).geometry
        rows = [{"id": int(idx), "attributes": attributes,
                 "bounds": list(geom.bounds) if geom is not None and not geom.is_empty else None}
                for (idx, geom), attributes in zip(geometries.items(), values)]
        query = None
        if filter_field:
            query = {"field": filter_field, "op": normalize_attribute_operator(filter_op or "="),
                     "value": None if filter_value is None else str(filter_value)}
        return {"fields": fields, "rows": rows, "total": total, "offset": offset, "limit": limit,
                "definition_query": query}

    def rename_field(self, layer_ref: str, field: str, new_field: str) -> dict[str, Any]:
        """Rename one vector attribute field in the managed analysis work copy."""
        with self._lock:
            lid = self.resolve(layer_ref)
            layer = self._layers[lid]
            if self._is_raster(layer):
                raise ValueError("Field rename is only available for vector layers")
            frame = self.get_gdf(lid)
            if frame is None:
                raise KeyError(f"unknown layer: {layer_ref}")
            geometry_field = frame.geometry.name
            if field not in frame.columns or field == geometry_field:
                raise ValueError(f"unknown attribute field: {field}")
            if str(field).casefold() in _RESERVED_FIELD_NAMES:
                raise ValueError(f"Field {field!r} is a reserved record ID or geometry field and cannot be renamed")
            name = validate_field_name(new_field)
            if name == field:
                raise ValueError("New field name is the same as the current field name")
            if name.casefold() in _RESERVED_FIELD_NAMES or name.casefold() == str(geometry_field).casefold():
                raise ValueError(f"Field name {name!r} is reserved for record IDs or geometry")
            folded = name.casefold()
            if any(str(column).casefold() == folded for column in frame.columns if column != field):
                raise ValueError(f"Attribute field {name!r} already exists")
            renamed = frame.rename(columns={field: name})
            layer_info = self.add_gdf(renamed, name=layer.name, source_path=layer.source_path,
                                      layer_id=lid, overwrite=True)
            result_fields = [c for c in renamed.columns if c != renamed.geometry.name]
            return {"ok": True, "renamed": lid, "field": field, "new_field": name,
                    "fields": result_fields, "layer": layer_info}

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
                              {"kind": "vector", "source_crs": str(gdf.crs),
                               "dataset_path": str(dataset_path)})
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
            if layer.path:
                Path(layer.path).unlink(missing_ok=True)
            Path(layer.meta["dataset_path"]).unlink(missing_ok=True)
            return {"ok": True, "removed": lid, "name": layer.name}

    def rename(self, layer_ref: str, name: str) -> dict[str, Any]:
        """Rename a layer's display name; analysis data and files are untouched."""
        name = (name or "").strip()
        if not name:
            raise ValueError("Layer name must not be empty")
        with self._lock:
            lid = self.resolve(layer_ref)
            layer = self._layers[lid]
            if any(v.name == name and k != lid for k, v in self._layers.items()):
                raise ValueError(f"Another layer is already named {name}")
            updated = {**self._layers, lid: Layer(**{**layer.__dict__, "name": name})}
            self._save(updated)
            self._layers = updated
            return {"ok": True, "renamed": lid, "layer": self._public(updated[lid])}

    def reorder(self, ordered_ids: list[str]) -> dict[str, Any]:
        """Set the layer/draw order; must be a permutation of existing layer ids."""
        with self._lock:
            known = set(self._layers)
            if len(ordered_ids) != len(known) or set(ordered_ids) != known:
                raise ValueError("reorder_layers needs exactly the existing layer ids, each once")
            updated = {lid: self._layers[lid] for lid in ordered_ids}
            self._save(updated)
            self._layers = updated
            return {"ok": True, "order": ordered_ids}

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
        kind = "raster" if LayerStore._is_raster(layer) else "vector"
        dataset = Path(layer.meta["dataset_path"])
        return {"id": layer.id, "name": layer.name, "kind": kind, "crs": layer.crs, "display_crs": "EPSG:4326",
                "feature_count": layer.feature_count, "geometry_types": layer.geometry_types,
                "bounds": layer.bounds, "url": layer.url, "path": layer.meta["dataset_path"],
                "source_path": layer.source_path, "source_crs": layer.meta.get("source_crs"),
                "format": dataset.suffix.lower().lstrip(".") or "unknown",
                "bytes": dataset.stat().st_size if dataset.is_file() else None}

    @staticmethod
    def _is_raster(layer: Layer) -> bool:
        if layer.meta.get("kind") == "raster":
            return True
        return Path(layer.meta["dataset_path"]).suffix.lower() in {".tif", ".tiff"}
