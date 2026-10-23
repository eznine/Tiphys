"""Collect installed build-environment notices alongside redistributed Python binaries."""
import importlib.metadata
import json
import re
import shutil
import sys
from pathlib import Path

target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)
index = []
for distribution in importlib.metadata.distributions():
    name = distribution.metadata["Name"]
    destination = target / re.sub(r"[^\w.-]", "_", name)
    copied = []
    for item in distribution.files or []:
        if not re.search(r"(^|/)(licen[cs]e[^/]*|copying[^/]*|notice[^/]*)(/|$)", str(item), re.I):
            continue
        source = distribution.locate_file(item)
        if source.is_file():
            destination.mkdir(exist_ok=True)
            output = destination / str(item).replace("..", "_").replace("/", "__").replace("\\", "__")
            shutil.copyfile(source, output)
            copied.append(output.name)
    index.append({"name": name, "version": distribution.version,
                  "license": distribution.metadata.get("License-Expression") or distribution.metadata.get("License"), "files": copied})
python_license = Path(sys.base_prefix) / "LICENSE_PYTHON.txt"
if not python_license.exists():
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
if python_license.exists():
    shutil.copyfile(python_license, target / "PYTHON-LICENSE.txt")
(target / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
