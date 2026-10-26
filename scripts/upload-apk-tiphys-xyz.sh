#!/usr/bin/env bash
# Upload a versioned APK to tiphys.xyz/apk/ and sync both version.json copies.
# Usage: scripts/upload-apk-tiphys-xyz.sh [path/to/tiphys-X.Y.Z.apk]
# Reads version/notes from public/version.json (or TIPHYS_VERSION_JSON).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${EZNINE_SSH_HOST:-20.214.241.113}"
USER="${EZNINE_SSH_USER:-eznine}"
REMOTE_WEB="${EZNINE_REMOTE_WEB:-/srv/tiphys-web}"
REMOTE_APK="${EZNINE_REMOTE_APK:-${REMOTE_WEB}/apk}"
REMOTE_APP="${EZNINE_REMOTE_APP:-${REMOTE_WEB}/tiphys}"

if [[ -f "${HOME}/.config/tiphys/deploy.env" ]]; then
  set -a; # shellcheck disable=SC1091
  source "${HOME}/.config/tiphys/deploy.env"; set +a
  HOST="${EZNINE_SSH_HOST:-$HOST}"
  USER="${EZNINE_SSH_USER:-$USER}"
  REMOTE_WEB="${EZNINE_REMOTE_WEB:-$REMOTE_WEB}"
  REMOTE_APK="${EZNINE_REMOTE_APK:-${REMOTE_WEB}/apk}"
  REMOTE_APP="${EZNINE_REMOTE_APP:-${REMOTE_WEB}/tiphys}"
fi

PASSWORD="${EZNINE_SSH_PASSWORD:-${SSHPASS:-}}"
KEY="${EZNINE_SSH_KEY:-}"
for candidate in "${KEY}" "${HOME}/.ssh/eznine_deploy_b" "/f/server/eznine_deploy_b" "/mnt/f/server/eznine_deploy_b"; do
  if [[ -n "${candidate:-}" && -f "$candidate" ]]; then KEY="$candidate"; break; fi
done
if [[ -z "$PASSWORD" ]]; then
  for pf in "${HOME}/.config/tiphys/deploy-pass.txt" "/f/server/tiphys-deploy-pass.txt" "/mnt/f/server/tiphys-deploy-pass.txt"; do
    if [[ -f "$pf" ]]; then PASSWORD="$(tr -d '\r\n' < "$pf")"; break; fi
  done
fi

VERSION_JSON="${TIPHYS_VERSION_JSON:-public/version.json}"
APK_PATH="${1:-}"
if [[ -z "$APK_PATH" ]]; then
  VER="$(python3 -c "import json; print(json.load(open('$VERSION_JSON'))['version'])")"
  for cand in "dist-apk/tiphys-${VER}.apk" "dist-apk/tiphys-debug.apk" "android/app/build/outputs/apk/debug/app-debug.apk"; do
    if [[ -f "$cand" ]]; then APK_PATH="$cand"; break; fi
  done
fi
if [[ -z "$APK_PATH" || ! -f "$APK_PATH" ]]; then
  echo "APK not found. Pass path or place dist-apk/tiphys-<ver>.apk" >&2
  exit 1
fi
if [[ -z "$PASSWORD" ]]; then
  echo "Missing password (deploy-pass.txt / EZNINE_SSH_PASSWORD)." >&2
  exit 2
fi
if ! command -v sshpass >/dev/null 2>&1; then
  echo "Install sshpass." >&2
  exit 3
fi

# Refuse non-canonical signing cert before any network upload.
echo "→ verify APK signing cert (canonical efd833d2…)"
node "$ROOT/scripts/verify-apk-cert.mjs" "$APK_PATH"

APK_NAME="$(basename "$APK_PATH")"
# Prefer versioned name from version.json apkUrl if set
APK_URL_NAME="$(python3 -c "import json; u=json.load(open('$VERSION_JSON')).get('apkUrl',''); print(u.rsplit('/',1)[-1] if u else '')")"
if [[ -n "$APK_URL_NAME" && "$APK_URL_NAME" == *.apk ]]; then
  REMOTE_NAME="$APK_URL_NAME"
else
  REMOTE_NAME="$APK_NAME"
fi

SSH_OPTS=(-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no)
if [[ "${EZNINE_SSH_USE_KEY:-0}" == "1" && -n "$KEY" && -f "$KEY" ]]; then
  SSH_OPTS=(-o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i "$KEY")
fi
export SSHPASS="$PASSWORD"
PW_Q="$(printf '%q' "$PASSWORD")"
ssh_cmd() { sshpass -e ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "$@"; }

echo "→ upload $APK_PATH → ${REMOTE_APK}/${REMOTE_NAME}"
ssh_cmd "mkdir -p /tmp/tiphys-apk-upload"
sshpass -e scp "${SSH_OPTS[@]}" "$APK_PATH" "${USER}@${HOST}:/tmp/tiphys-apk-upload/${REMOTE_NAME}"
sshpass -e scp "${SSH_OPTS[@]}" "$VERSION_JSON" "${USER}@${HOST}:/tmp/tiphys-apk-upload/version.json"

echo "→ install APK + both version.json (root + /tiphys/)"
ssh_cmd "printf '%s\n' ${PW_Q} | sudo -S -p '' bash -lc $(printf '%q' \
  "mkdir -p '${REMOTE_APK}' '${REMOTE_APP}' && \
   install -m 644 '/tmp/tiphys-apk-upload/${REMOTE_NAME}' '${REMOTE_APK}/${REMOTE_NAME}' && \
   cp -f '/tmp/tiphys-apk-upload/${REMOTE_NAME}' '${REMOTE_APK}/tiphys.apk' && \
   install -m 644 /tmp/tiphys-apk-upload/version.json '${REMOTE_WEB}/version.json' && \
   install -m 644 /tmp/tiphys-apk-upload/version.json '${REMOTE_APP}/version.json' && \
   chown eznine:eznine '${REMOTE_WEB}/version.json' '${REMOTE_APP}/version.json' '${REMOTE_APK}/${REMOTE_NAME}' '${REMOTE_APK}/tiphys.apk' 2>/dev/null || true && \
   rm -rf /tmp/tiphys-apk-upload")"

SIZE="$(wc -c < "$APK_PATH" | tr -d ' ')"
echo "OK https://tiphys.xyz/apk/${REMOTE_NAME} (${SIZE} bytes)"
curl -fsSI "https://tiphys.xyz/apk/${REMOTE_NAME}" | head -5 || true
curl -fsS "https://tiphys.xyz/version.json?t=$(date +%s)"
echo
curl -fsS "https://tiphys.xyz/tiphys/version.json?t=$(date +%s)"
echo
