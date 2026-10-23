"""Standalone stdio debugging server; its project is isolated from the live HTTP engine."""
import os
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from jobs import JobRegistry
from layers import LayerStore
from tools import register_tools

DATA_DIR = Path(os.environ.get("TIPHYS_DATA_DIR", Path(__file__).resolve().parent / "data")) / "stdio"
STORE = LayerStore(DATA_DIR)
JOBS = JobRegistry(state_path=DATA_DIR / "jobs.json")
mcp = FastMCP("tiphys-engine", instructions="Standalone debug workspace; connect to the HTTP engine for the live desktop project.")
register_tools(mcp, STORE, JOBS)

if __name__ == "__main__":
    try:
        mcp.run(transport="stdio")
    finally:
        JOBS.close()
