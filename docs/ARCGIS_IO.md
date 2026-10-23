# ArcGIS IO adapters

TIPHYS prefers open formats and does not parse proprietary ArcGIS project files in this release.

## What imports today

The file picker and `list_supported_formats` accept:

- Vector: GeoJSON/JSON, GeoPackage, Shapefile ZIP (`.shp`, `.shx`, `.dbf`, optional `.prj`), FlatGeobuf, KML/KMZ, GPX, GML, GeoParquet, TopoJSON
- Raster: GeoTIFF
- Table: CSV (read-only table import)

The browser WASM engine reads the same open vector/raster formats; the Python engine uses GeoPandas/Fiona drivers available in the installed environment.

## ArcGIS adapters

`import_arcgis_project` is an honest diagnostic stub. It never reads or uploads a proprietary file. It returns the detected format, the limitation, and open alternatives.

| Input | Status | Recommended path |
| --- | --- | --- |
| `.mxd` | Not parsed | Export layers to GeoPackage, Shapefile ZIP, or GeoJSON |
| `.aprx` | Not parsed | Export map layers or geodatabase contents to an open format |
| `.gdb` (File GDB) | Not parsed unless a FileGDB driver is available | Use `ogr2ogr`/ArcGIS to convert to GeoPackage or Shapefile ZIP |

File GDB support is intentionally not claimed by default: the browser bundle has no ESRI FileGDB driver, and desktop support depends on the host GDAL/Fiona build. When a driver is present, the preferred conversion target is still GeoPackage so CRS and field types survive cleanly.

## Workflow

1. In ArcGIS, export the layer or geodatabase to GeoPackage (preferred) or GeoJSON.
2. Import the file with **添加数据** in TIPHYS.
3. If a source lacks CRS metadata, supply an EPSG code at import; TIPHYS never guesses silently.
4. Use **数据管理 → 支持的格式** to inspect the current runtime's accepted formats.

No credentials or machine-specific paths are stored under `.tiphys/`.
