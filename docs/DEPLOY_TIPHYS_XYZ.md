# Deploy tiphys.xyz (origin nginx)

> **Layout (2026-10-26):** root `https://tiphys.xyz/` is a **separate landing page** (“TIPHYS for ArcGIS Pro”) and must **never** be overwritten or deleted. The TIPHYS web app lives at `https://tiphys.xyz/tiphys/`. APKs live at `https://tiphys.xyz/apk/…`. Both `/version.json` and `/tiphys/version.json` are kept identical for old and new installs.

Origin host: `eznine@20.214.241.113` · nginx root `/srv/tiphys-web` · Cloudflare in front. **Not** Cloudflare Pages / wrangler.

## Server layout (read-only reference)

| Path / URL | Role |
|---|---|
| nginx site `sites-enabled/tiphys` | `server_name tiphys.xyz`; `root /srv/tiphys-web` |
| `/srv/tiphys-web/index.html` (+ landing assets) | **Landing only** — never rsync `--delete` the web root |
| `/srv/tiphys-web/tiphys/` | App SPA (`index.html`, `assets/`, `brand/`, `version.json`, …) |
| `/srv/tiphys-web/apk/` | Versioned APKs (`tiphys-0.1.4.apk`, `tiphys.apk` mirror, …) |
| `/srv/tiphys-web/version.json` | Root copy — **old 0.1.3 APKs poll this** (`appUpdate.ts`) |
| `/srv/tiphys-web/tiphys/version.json` | App-dir mirror (deploy keeps both in sync) |
| snippet `snippets/tiphys-apk.conf` | CORS + short cache for `/version.json` and `/apk/` |

`location /tiphys/` → `try_files` SPA; `location /` → landing `try_files`. Do not change nginx unless the user asks.

## Credentials (never commit, never print)

| Machine | SSH key | Sudo / SSH password |
|---|---|---|
| **Linux box** | `~/.ssh/eznine_deploy_b` (optional; may be unauthorized) | `~/.config/tiphys/deploy-pass.txt` + optional `~/.config/tiphys/deploy.env` |
| **Windows** | `F:\server\eznine_deploy_b` | `F:\server\tiphys-deploy-pass.txt` |

Box prefer **password auth via `sshpass`** (`EZNINE_SSH_PASSWORD` / pass file). Set `EZNINE_SSH_USE_KEY=1` only if the key is authorized. Windows scripts use key auth + password piped to remote `sudo -S`.

Optional env (same names on both OSes): `EZNINE_SSH_HOST`, `EZNINE_SSH_USER`, `EZNINE_REMOTE_WEB` (default `/srv/tiphys-web`), `EZNINE_REMOTE_APP` (default `$REMOTE_WEB/tiphys`), `EZNINE_REMOTE_APK`, `EZNINE_REMOTE_TMP`, `TIPHYS_WEB_BASE` (build, default `/tiphys/`).

## Web build base

```bash
npm run build          # Vite base '/tiphys/' → assets under /tiphys/assets/…
CAPACITOR=1 npm run build   # base './' for Android WebView
```

`vite.config.ts`: capacitor / desktop → `./`; `vite` serve (dev) → `/`; production web → `/tiphys/` (override with `TIPHYS_WEB_BASE`).

## Deploy app only

```bash
npm run build
npm run deploy:xyz     # → scripts/deploy-tiphys-xyz.sh|.ps1 via run-deploy-xyz.mjs
```

What the script does:

1. Snapshot **origin disk** SHA-256 of `/srv/tiphys-web/index.html` (CDN HTML bytes can vary; do not use curl of the URL as the guard).
2. Backup remote app dir: `cp -a /srv/tiphys-web/tiphys → tiphys.bak-<stamp>`.
3. Upload `dist/` to `/tmp/tiphys-dist`.
4. `sudo rsync -a --delete` **only** into `/srv/tiphys-web/tiphys/` (nested `apk/` protected if present). **Never** rsync the web root.
5. Copy `tiphys/version.json` → root `/srv/tiphys-web/version.json` when present in dist.
6. Abort if landing hash changed; verify live `/tiphys/` asset hash matches local dist.

## Upload APK

```bash
# After building on Windows (preferred — debug cert matches installed 0.1.3-brand):
npm run android:build
# public/version.json already points at tiphys-0.1.4.apk
npm run upload:apk -- dist-apk/tiphys-debug.apk
# or rename first:
cp dist-apk/tiphys-debug.apk dist-apk/tiphys-0.1.4.apk
npm run upload:apk -- dist-apk/tiphys-0.1.4.apk
```

Uploads to `/srv/tiphys-web/apk/<name>`, mirrors `tiphys.apk`, writes **both** version.json copies from `public/version.json`.

## Verify

```bash
# Landing unchanged (compare hashes before/after yourself if needed)
curl -fsS https://tiphys.xyz/ | sha256sum
curl -fsSI https://tiphys.xyz/tiphys/ | head -5
curl -fsS https://tiphys.xyz/tiphys/ | grep -oE 'assets/index-[^"]+\.js'
curl -fsS https://tiphys.xyz/version.json
curl -fsS https://tiphys.xyz/tiphys/version.json
curl -fsSI https://tiphys.xyz/apk/tiphys-0.1.4.apk | head -5
```

## Safety rules

- **Never** `rsync --delete` onto `/srv/tiphys-web/` root.
- **Never** delete or overwrite landing `index.html` / ArcGIS Pro landing assets.
- Do not commit keys, passwords, or `deploy.env`.
- If layout is ambiguous, stop before writing and report.
