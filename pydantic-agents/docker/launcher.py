"""Generic launcher for any Pydantic-AI MCP agent in this repo.

Reads AGENT_MODULE (e.g. ``deep_research.agent``) from the environment, imports it
to obtain the module-level ``mcp`` FastMCP instance and ``PORT`` constant, then
starts the HTTP server bound to 0.0.0.0 so Docker can publish the port.

This deliberately bypasses each agent's ``if __name__ == "__main__"`` block so we
do not need to modify upstream agent source to change the bind host.
"""
from __future__ import annotations

import importlib
import os
import sys


def main() -> None:
    module_name = os.environ.get("AGENT_MODULE")
    if not module_name:
        print("ERROR: AGENT_MODULE env var is required", file=sys.stderr)
        sys.exit(2)

    print(f"[launcher] importing {module_name}", flush=True)
    mod = importlib.import_module(module_name)

    mcp = getattr(mod, "mcp", None)
    if mcp is None:
        print(f"ERROR: module {module_name} has no `mcp` attribute", file=sys.stderr)
        sys.exit(2)

    port = int(os.environ.get("PORT") or getattr(mod, "PORT", 0) or 0)
    if not port:
        print("ERROR: no PORT set (env or module)", file=sys.stderr)
        sys.exit(2)

    host = os.environ.get("HOST", "0.0.0.0")
    print(f"[launcher] starting {module_name} on {host}:{port}", flush=True)
    mcp.run(transport="http", host=host, port=port)


if __name__ == "__main__":
    main()
