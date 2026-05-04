#!/usr/bin/env bash
# Starts every Pydantic AI agent in pydantic-agents/. Each agent runs in
# its own python process and exposes itself as an MCP server on its own
# port (see .env). Foreground; Ctrl+C kills both.

set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then set -a; source .env; set +a; fi

python -m deep_research.agent &
DR_PID=$!
python -m web_research.agent &
WR_PID=$!

trap "kill $DR_PID $WR_PID 2>/dev/null || true" EXIT INT TERM
wait
