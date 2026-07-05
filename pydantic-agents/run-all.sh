#!/usr/bin/env bash
# Starts every Pydantic AI agent in pydantic-agents/. Each agent runs in
# its own python process and exposes itself as an MCP server on its own
# port (see .env). Foreground; Ctrl+C kills both.

set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then set -a; source .env; set +a; fi

# shellcheck source=/dev/null
source "$(dirname "$0")/.venv/bin/activate"

python -m deep_research.agent &
DR_PID=$!
python -m web_research.agent &
WR_PID=$!
python -m notebooklm.agent &
NLM_PID=$!
python -m reviewer_council.agent &
RC_PID=$!
python -m crawl4ai_agent.agent &
CA_PID=$!
python -m image_agent.agent &
IA_PID=$!
python -m chatgpt_image_agent.agent &
CGI_PID=$!
python -m gemini_web_agent.agent &
GWA_PID=$!

trap "kill $DR_PID $WR_PID $NLM_PID $RC_PID $CA_PID $IA_PID $CGI_PID $GWA_PID 2>/dev/null || true" EXIT INT TERM

# wait -n returns the exit code of the first child to exit. If either agent
# crashes (e.g. boot failure), tear down the survivors and propagate non-zero.
if ! wait -n; then
    rc=$?
    kill $DR_PID $WR_PID $NLM_PID $RC_PID $CA_PID $IA_PID $CGI_PID $GWA_PID 2>/dev/null || true
    exit "$rc"
fi
# First child exited cleanly (rare for long-running servers, but handle it).
wait
