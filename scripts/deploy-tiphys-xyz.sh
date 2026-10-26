#!/usr/bin/env bash
# Deploy dist/ to tiphys.xyz app subpath ONLY (/srv/tiphys-web/tiphys/).
# Never touches the landing page at web root or /apk/.
# Origin nginx on 20.214.241.113 (Cloudflare in front). Not Cloudflare Pages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${EZNINE_SSH_HOST:-20.214.241.113}"
USER="${EZNINE_SSH_USER:-eznine}"
REMOTE_TMP="${EZNINE_REMOTE_TMP:-/tmp/tiphys-dist}"
REMOTE_WEB="${EZNINE_REMOTE_WEB:-/srv/tiphys-web}"
REMOTE_APP="${EZNINE_REMOTE_APP:-${REMOTE_WEB}/tiphys}"
APP_PUBLIC_URL="${TIPHYS_APP_PUBLIC_URL:-https://tiphys.xyz/tiphys/}"
LANDING_URL="${TIPHYS_LANDING_URL:-https://tiphys.xyz/}"

if [[ -f "${HOME}/.config/tiphys/deploy.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HOME}/.config/tiphys/deploy.env"
  set +a
  HOST="${EZNINE_SSH_HOST:-$HOST}"
  USER="${EZNINE_SSH_USER:-$USER}"
  REMOTE_TMP="${EZNINE_REMOTE_TMP:-$REMOTE_TMP}"
  REMOTE_WEB="${EZNINE_REMOTE_WEB:-$REMOTE_WEB}"
  REMOTE_APP="${EZNINE_REMOTE_APP:-${REMOTE_WEB}/tiphys}"
fi

PASSWORD="${EZNINE_SSH_PASSWORD:-${SSHPASS:-}}"
KEY="${EZNINE_SSH_KEY:-}"

for candidate in \
  "${KEY}" \
  "${HOME}/.ssh/eznine_deploy_b" \
  "/f/server/eznine_deploy_b" \
  "/mnt/f/server/eznine_deploy_b"
do
  if [[ -n "${candidate:-}" && -f "$candidate" ]]; then KEY="$candidate"; break; fi
done

if [[ -z "$PASSWORD" ]]; then
  for pf in \
    "${HOME}/.config/tiphys/deploy-pass.txt" \
    "/f/server/tiphys-deploy-pass.txt" \
    "/mnt/f/server/tiphys-deploy-pass.txt"
  do
    if [[ -f "$pf" ]]; then PASSWORD="$(tr -d '\r\n' < "$pf")"; break; fi
  done
fi

if [[ ! -d dist || ! -f dist/index.html ]]; then
  echo "dist/ missing. Run: npm run build" >&2
  exit 1
fi
if ! grep -qE '(/tiphys/|\./)assets/' dist/index.html; then
  echo "dist/index.html does not look like a /tiphys/ (or capacitor relative) build. Abort." >&2
  exit 1
fi
if [[ -z "$PASSWORD" ]]; then
  echo "Missing sudo/SSH password. Set EZNINE_SSH_PASSWORD, or put one line in ~/.config/tiphys/deploy-pass.txt or F:\\server\\tiphys-deploy-pass.txt (never commit)." >&2
  exit 2
fi
if ! command -v sshpass >/dev/null 2>&1; then
  echo "Install sshpass (needed for non-interactive password auth / sudo)." >&2
  exit 3
fi

SSH_OPTS=(-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no)
# Prefer password (box key may not be authorized). Still allow -i when EZNINE_SSH_USE_KEY=1.
if [[ "${EZNINE_SSH_USE_KEY:-0}" == "1" && -n "$KEY" && -f "$KEY" ]]; then
  SSH_OPTS=(-o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i "$KEY")
fi

export SSHPASS="$PASSWORD"
PW_Q="$(printf '%q' "$PASSWORD")"

ssh_cmd() { sshpass -e ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "$@"; }
sudo_remote() {
  local remote_cmd="$1"
  ssh_cmd "printf '%s\n' ${PW_Q} | sudo -S -p '' bash -lc $(printf '%q' "$remote_cmd")"
}

echo "→ snapshot landing file on origin disk (CDN HTML hash is flaky)"
LANDING_BEFORE="$(sshpass -e ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sha256sum '${REMOTE_WEB}/index.html'" | awk '{print $1}')"
echo "   landing disk sha256: ${LANDING_BEFORE}"

echo "→ backup remote app dir ${REMOTE_APP}"
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo_remote "if [[ -d '${REMOTE_APP}' ]]; then cp -a '${REMOTE_APP}' '${REMOTE_APP}.bak-${STAMP}'; fi; mkdir -p '${REMOTE_APP}' '${REMOTE_TMP}'"

echo "→ upload dist/ → ${USER}@${HOST}:${REMOTE_TMP}"
ssh_cmd "rm -rf '${REMOTE_TMP}' && mkdir -p '${REMOTE_TMP}'"
if command -v rsync >/dev/null 2>&1; then
  sshpass -e rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "dist/" "${USER}@${HOST}:${REMOTE_TMP}/"
else
  tar -C dist -cf - . | sshpass -e ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "tar -C '${REMOTE_TMP}' -xf -"
fi

echo "→ sudo install → ${REMOTE_APP}/ ONLY (never web root / landing /apk)"
# Scoped --delete to app dir. Protect nested apk/ if present. Do NOT touch REMOTE_WEB root.
sudo_remote "rsync -a --delete --filter='P apk/' --filter='P apk/**' '${REMOTE_TMP}/' '${REMOTE_APP}/' && if [[ -f '${REMOTE_APP}/version.json' ]]; then cp -f '${REMOTE_APP}/version.json' '${REMOTE_WEB}/version.json'; chown eznine:eznine '${REMOTE_WEB}/version.json' 2>/dev/null || true; fi && rm -rf '${REMOTE_TMP}'"

echo "→ verify landing disk unchanged + app live"
LANDING_AFTER="$(sshpass -e ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sha256sum '${REMOTE_WEB}/index.html'" | awk '{print $1}')"
if [[ "$LANDING_BEFORE" != "$LANDING_AFTER" ]]; then
  echo "FATAL: landing file on disk changed (${LANDING_BEFORE} → ${LANDING_AFTER}). Investigate immediately." >&2
  exit 4
fi
echo "   landing OK (disk unchanged)"

LOCAL_JS="$(grep -oE 'assets/index-[^\"[:space:]]+\.js' dist/index.html | head -1 || true)"
REMOTE_JS="$(curl -fsS "${APP_PUBLIC_URL}?v=$(date +%s)" | grep -oE 'assets/index-[^\"[:space:]]+\.js' | head -1 || true)"
echo "local: ${LOCAL_JS:-unknown}"
echo "live:  ${REMOTE_JS:-unknown}"
if [[ -n "$LOCAL_JS" && "$LOCAL_JS" == "$REMOTE_JS" ]]; then
  echo "OK ${APP_PUBLIC_URL} matches this dist/"
else
  echo "WARN: live app asset differs (CDN delay or mismatch). Hard-refresh and recheck." >&2
fi
