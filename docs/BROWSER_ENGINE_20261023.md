# Browser engine boundary (2026-10-23)

The web client executes GIS tools in the user's browser with `geolibre-wasm@1.7.1`. It does not send layer contents to the static web server for calculation. Imported layers, generated layers, downloads, tool history and browser settings are kept in that browser profile's IndexedDB; separate users therefore start with separate local workspaces.

The current bridge exposes 24 common operations and 257 native vector-in/vector-out tools from the pinned GeoLibre inventories. Common operations include import, buffer, clip, intersect, erase, dissolve, convex hull, spatial/attribute selection, reprojection, geometry measurement and export. Native tools are listed from their upstream parameter contracts; tools that require raster inputs, multiple dataset inputs or unsupported output kinds remain outside this bridge.

Vector export supports GeoJSON, GeoPackage, FlatGeobuf and CSV. CSV includes the source attributes and a `geometry` WKT column; it uses the layer's original coordinate reference system. GeoJSON output is WGS84. The input size limit is 128 MiB per file.

Current limits: there is no server-side shared workspace, account system, collaborative editing or server-held API key. Heavy browser calculations are bounded by the user's available memory; long jobs run in a Web Worker and can be cancelled, but closing the tab interrupts them. HTTPS and domain routing are deployment concerns and do not add cloud storage or multi-user state.

The import/refresh command is `npm run import:browser-engine`. It reads `.tooling/source-catalog.json` and `.tooling/wasm-manifests.json`, pins GeoLibre at `ffe2665a3b9f32d99fe9bace47fc6fdac4e4e8ae`, and retains the common `union_layers` and `calculate_geometry` operations.
