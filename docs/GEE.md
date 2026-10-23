# Google Earth Engine status and auth path

TIPHYS currently exposes a structured GEE preparation path, not a live Earth Engine session. The tools never invent imagery or report a connection merely because an environment variable exists.

## Status contract

`gee_auth_status` returns:

| Field | Meaning |
| --- | --- |
| `connected` | Always `false` until a server-side Earth Engine initialization succeeds. |
| `status` | `not_configured`, `configured_unverified`, or `demo`. A verified implementation may add `connected`. |
| `project` | Configured GEE project ID, or `null`. |
| `hasToken` | Whether `TIPHYS_GEE_TOKEN` / `VITE_TIPHYS_GEE_TOKEN` is non-empty. The value is never returned. |
| `hasServiceAccount` | Whether a service-account path is configured. The path or file contents are never returned or read by these tools. |
| `demo` | Whether `TIPHYS_GEE_DEMO=1` is active. Demo mode only proves the local job/form flow. |
| `hint` | The exact next action for the current status. |

`gee_search_collection` always returns an honest empty result unless a future verified client is wired. `gee_export_raster` creates a local job only in demo mode; otherwise it returns the requested path plus a structured not-connected result and writes no raster. `gee_job_status` reads local job records and also reports the current auth status.

Search and export are disabled in the toolbox until `connected` is true or demo mode is enabled. Auth status and local job status remain available while disconnected so users can diagnose configuration.

## Environment variables

Browser builds read Vite-exposed names; Node/desktop runtimes read the non-prefixed names. A value being present proves configuration only, not authentication.

| Purpose | Browser name | Node / Python name |
| --- | --- | --- |
| GEE project ID | `VITE_TIPHYS_GEE_PROJECT` | `TIPHYS_GEE_PROJECT` |
| Access token presence | `VITE_TIPHYS_GEE_TOKEN` | `TIPHYS_GEE_TOKEN` |
| Service-account JSON path | `VITE_TIPHYS_GEE_SA_PATH` | `TIPHYS_GEE_SA_PATH` |
| Local demo mode | `VITE_TIPHYS_GEE_DEMO=1` | `TIPHYS_GEE_DEMO=1` |

Do not commit `.env` files, tokens, service-account JSON, or downloaded credentials. Do not expose a service-account key to browser JavaScript. The frontend only receives booleans and non-secret project metadata.

## Exact next implementation step

1. Add a server-side Earth Engine client in the trusted Python desktop engine, for example `earthengine-api`, initialized with the service-account path from `TIPHYS_GEE_SA_PATH`. Read the path only; never copy file contents to logs, API responses, or the repository.
2. Perform an explicit verification call such as `ee.Number(1).getInfo()` with a bounded timeout. Return `connected: true` and `status: "connected"` only after that call succeeds.
3. Route `gee_search_collection` through `ee.ImageCollection(...)` with date, bounds, and cloud filters, and return real collection metadata.
4. Implement `gee_export_raster` with an Earth Engine download/export operation and a server-owned job ID. Keep `gee_job_status` polling that job rather than simulating completion.
5. For tiphys.xyz, proxy these operations through the trusted service. Never ship a service-account private key or long-lived token to the web client.

No npm dependency that phones home was added for this slice. The current code reports configuration honestly and remains safe when the optional Earth Engine client is absent.

## Demo mode

`TIPHYS_GEE_DEMO=1` makes export return a deterministic local demo result. It intentionally keeps `connected: false`, marks `demo: true`, and states that no real imagery was downloaded. Demo success must not be used to claim GEE availability.
