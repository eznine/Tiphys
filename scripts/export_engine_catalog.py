"""Export the *actual* Python MCP tool registry as JSON for the catalog audit.

This imports engine/tools.py and registers it on a real FastMCP instance, so the
exported schemas come from the same code path the desktop agent sees over MCP
instead of being re-typed by hand.

    engine/.venv/Scripts/python.exe scripts/export_engine_catalog.py [out.json]

The layer store and job registry are not touched: register_tools only closes over
them, and this script never calls a tool.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

from mcp.server.fastmcp import FastMCP  # noqa: E402

import tools as engine_tools  # noqa: E402

# Tools whose handler starts a background job even if the docstring is terse.
JOB_TARGETS = re.compile(r"jobs\.start\(|start_[a-z_]+_job\(")
FILE_PARAMS = {"path", "export_path", "output_path"}


def groups_for(name: str) -> list[str]:
    return [group for group, members in engine_tools.TOOL_GROUPS.items() if name in members]


def main() -> None:
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "baselines" / "stage0" / "engine-catalog.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    mcp = FastMCP("tiphys-engine")
    engine_tools.register_tools(mcp, None, None)  # type: ignore[arg-type]
    listed = asyncio.run(mcp.list_tools())
    by_name = {tool.name: tool for tool in listed}

    # Map MCP tool name -> python function for source-level facts.
    functions = {}
    for name, member in vars(engine_tools).items():
        if inspect.isfunction(member) and name in by_name:
            functions[name] = member

    records = []
    for tool in sorted(listed, key=lambda item: item.name):
        function = functions.get(tool.name)
        source = inspect.getsource(function) if function else ""
        schema = dict(tool.inputSchema or {})
        properties = schema.get("properties", {}) or {}
        required = list(schema.get("required", []) or [])
        annotations = tool.annotations or {}
        records.append(
            {
                "id": tool.name,
                "engine": "desktop-python",
                "description": (tool.description or "").strip(),
                "category": (groups_for(tool.name) or ["未分组"])[0],
                "groups": groups_for(tool.name),
                "input_schema": schema,
                "required": required,
                "param_kinds": {
                    name: ("file" if name in FILE_PARAMS else "value")
                    for name in properties
                },
                # Evidence-based flags, not guesses:
                "async": bool(JOB_TARGETS.search(source)),
                "cancellable": bool(JOB_TARGETS.search(source)),
                "read_only": bool(getattr(annotations, "readOnlyHint", None)),
                "destructive": bool(getattr(annotations, "destructiveHint", None)),
                "cost": "job" if JOB_TARGETS.search(source) else "interactive",
                "error_contract": "raises; MCP call returns isError with message",
            }
        )

    payload = {
        "generated_by": "scripts/export_engine_catalog.py",
        "source": "engine/tools.py via FastMCP.list_tools()",
        "count": len(records),
        "groups": engine_tools.TOOL_GROUPS,
        "tools": records,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)} ({len(records)} tools)")


if __name__ == "__main__":
    main()