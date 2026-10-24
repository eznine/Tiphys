# Attribute table: field rename and definition query

The attribute table keeps two separate filtering concepts:

- **Global search** (`search`) scans every attribute field as a case-insensitive substring. It is a convenience search, not a definition query.
- **Definition query** targets one field with one operator. It is evaluated before sorting and paging, so `total`, page boundaries, CSV export of the visible page, and the record count all describe the filtered set.

When both are present they are combined with AND. The UI labels the global search as `全文搜索（跨字段）` and shows the active field query in a separate chip.

## API

Both the browser-WASM and desktop-Python engines implement the same REST shape:

```text
GET /layers/{layer_id}/attributes
    ?offset=0&limit=100
    &search=...
    &sort=field&descending=false
    &filter_field=field
    &filter_op=%3D
    &filter_value=value
```

Supported definition-query operators (aliases such as `eq`, `ne`, `gt`, `lt`, `isnull` and `notnull` are accepted by the engines):

| UI operator | Meaning | Value required |
|---|---|---|
| `=` | Equal; numbers compare numerically and text keeps leading zeros | yes |
| `!=` | Not equal; null cells do not match | yes |
| `contains` | Case-insensitive text substring | yes |
| `>` | Numeric greater-than | yes |
| `<` | Numeric less-than | yes |
| `is null` | Null / missing value | no |
| `is not null` | Present value, including empty text | no |

`=` and `!=` on a numeric field parse the query value as a number. `>` and `<` reject non-numeric fields. The response echoes `definition_query` (or `null`). Filter failures return a clear `400`-equivalent engine error; they never fall back to global search.

## Field rename

```text
POST /layers/{layer_id}/attributes/rename-field
Content-Type: application/json

{"field":"old_name","new_field":"new_name"}
```

The operation updates the managed analysis work copy, not only a transient display object:

- **Desktop Python:** renames the GeoDataFrame column and rewrites the layer's managed GeoPackage work copy, preserving layer id, CRS, geometry, row order and feature count.
- **Browser WASM:** runs the real `rename_field` operation when the requested name is ASCII; for non-ASCII names it round-trips native bytes through `vector_convert` because upstream `rename_field` 1.7.1 mangles those names to `__`. The resulting FlatGeobuf work copy and display GeoJSON are both verified before IndexedDB is updated. The layer id and selection ids stay unchanged.

Rules enforced by the UI and both engines:

- The source field must exist on a vector layer.
- The new name is trimmed, non-empty, at most 64 characters, and starts with a letter, number or underscore; only letters, numbers, spaces, underscores and hyphens are accepted.
- Names are unique case-insensitively.
- Reserved record-id and geometry columns (`id`, `fid`, `objectid`, `ogc_fid`, `_tiphys_fid`, `geometry`, `geom`) cannot be renamed to or from.
- Errors leave the work copy untouched.

## NOT_SUPPORTED

This is intentionally not a SQL editor. The following are **not supported**:

- Multiple conditions or parentheses; there is exactly one field query, optionally ANDed with global search.
- `>=`, `<=`, `LIKE`, `NOT LIKE`, `IN`, `NOT IN`, `BETWEEN`, `OR`, `AND` expressions, calculated fields and arbitrary SQL.
- Spatial predicates in the definition-query endpoint; use the dedicated spatial selection tools.
- Automatic rewriting of existing symbology, labels or other saved styles that referenced the old field name. Review those styles after a rename.
