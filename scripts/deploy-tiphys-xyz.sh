#!/usr/bin/env bash
# Deploy dist/ to tiphys.xyz origin (nginx on 20.214.241.113). Not Cloudflare Pages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${EZNINE_SSH_HOST:-20.214.241.113}"
USER="${EZNINE_SSH_USER:-eznine}"
REMOTE_TMP="${EZNINE_REMOTE_TMP:-/tmp/tiphys-dist}"
REMOTE_WEB="${EZNINE_REMOTE_WEB:-/srv/tiphys-web}"

if [[ -f "${HOME}/.config/tiphys/deploy.env" ]]; then
  set -a; # shellcheck disable=SC1091
  source "${HOME}/.config/tiphys/deploy.env"; set +a
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
if [[ -z "$PASSWORD" ]]; then
  echo "Missing sudo password. Set EZNINE_SSH_PASSWORD, or one line in F:\\server\\tiphys-deploy-pass.txt / ~/.config/tiphys/deploy-pass.txt (never commit)." >&2
  exit 2
fi
if ! command -v sshpass >/dev/null 2>&1; then
  echo "Install sshpass (needed for non-interactive sudo)." >&2
  exit 3
fi

SSH_OPTS=(-o StrictHostKeyChecking=no -o IdentitiesOnly=yes)
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")

export SSHPASS="$PASSWORD"

echo "→ upload dist/ → ${USER}@${HOST}:${REMOTE_TMP}"
if command -v rsync >/dev/null 2>&1; then
  sshpass -e rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "dist/" "${USER}@${HOST}:${REMOTE_TMP}/"
else
  sshpass -e ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "rm -rf '${REMOTE_TMP}' && mkdir -p '${REMOTE_TMP}'"
  tar -C dist -cf - . | sshpass -e ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "tar -C '${REMOTE_TMP}' -xf -"
fi

echo "→ sudo install → ${REMOTE_WEB}"
# Password must be expanded locally into the remote printf (remote has no SSHPASS).
# Protect /apk/ so separately uploaded APKs survive --delete of the SPA tree.
sshpass -e ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" \
  "printf '%s\n' $(printf '%q' "$PASSWORD") | sudo -S rsync -a --delete --filter='P apk/' --filter='P apk/**' '${REMOTE_TMP}/' '${REMOTE_WEB}/'"

LOCAL_JS="$(grep -oE 'assets/index-[^\"[:space:]]+\.js' dist/index.html | head -1 || true)"
REMOTE_JS="$(curl -fsS "https://tiphys.xyz/?v=$(date +%s)" | grep -oE 'assets/index-[^\"[:space:]]+\.js' | head -1 || true)"
echo "local: ${LOCAL_JS:-unknown}"
echo "live:  ${REMOTE_JS:-unknown}"
if [[ -n "$LOCAL_JS" && "$LOCAL_JS" == "$REMOTE_JS" ]]; then
  echo "OK tiphys.xyz matches this dist/"
else
  echo "WARN: live asset differs (CDN delay or mismatch). Hard-refresh and recheck." >&2
fi
