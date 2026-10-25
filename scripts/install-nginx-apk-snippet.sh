#!/usr/bin/env bash
# stdin: sudo password (one line). arg1: path to snippet file on this host.
set -euo pipefail
SNIP_SRC="${1:-/tmp/nginx-tiphys-apk.conf}"
PASS="$(head -n1 || true)"
sudo_s() { printf '%s\n' "$PASS" | sudo -S "$@"; }
sudo_s mkdir -p /etc/nginx/snippets
sudo_s cp "$SNIP_SRC" /etc/nginx/snippets/tiphys-apk.conf
SITE=/etc/nginx/sites-available/tiphys
if ! sudo_s grep -q 'snippets/tiphys-apk.conf' "$SITE"; then
  TMP=$(mktemp)
  sudo_s cat "$SITE" > "$TMP"
  python3 - "$TMP" <<'PY'
import re, sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
if "snippets/tiphys-apk.conf" in text:
    raise SystemExit(0)
include_line = "\n    include /etc/nginx/snippets/tiphys-apk.conf;\n"
marker = "    location = /index.html {\n        add_header Cache-Control \"no-cache\";\n    }\n"
if marker in text:
    text = text.replace(marker, marker + include_line, 1)
else:
    m = re.search(r"location = /index\.html \{[^}]*\}\n", text)
    if not m:
        raise SystemExit("could not find index.html location to insert include")
    text = text[: m.end()] + include_line + text[m.end() :]
path.write_text(text)
print("prepared patched site config")
PY
  sudo_s cp "$TMP" "$SITE"
  rm -f "$TMP"
fi
sudo_s nginx -t
sudo_s systemctl reload nginx
echo "OK nginx tiphys-apk snippet active"
