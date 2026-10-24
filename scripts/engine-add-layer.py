"""Open one file as a desktop-engine layer and print the resulting inspection.

Small, explicit helper for the stage-1 WASM spike: it uses the same LayerStore
code path as the `add_data` MCP tool, so "the WASM output can be opened" is
demonstrated by the real implementation, not a parallel one.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from layers import LayerStore  # noqa: E402


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: engine-add-layer.py <path>")
    with tempfile.TemporaryDirectory(prefix="tiphys-spike-") as tmp:
        store = LayerStore(Path(tmp))
        layer = store.add_from_path(sys.argv[1])
        inspected = store.inspect(layer["id"])
        print(json.dumps({
            "layer": layer,
            "kind": inspected["layer"]["kind"],
            "sha256": inspected["layer"]["data"]["sha256"],
            "data_location": inspected["layer"]["data"]["location"],
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()