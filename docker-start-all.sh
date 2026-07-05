#!/usr/bin/env bash
# Starts all pydantic-agent Docker Compose stacks.
#
# - Main stack  : pydantic-agents/docker-compose.yml  (10 agents, ports 7100-7113)
# - Unique sidecars in /home/pydantic-compose/ that are NOT in the main stack:
#     browser-agent  → port 7107
#     perplexity-mcp → port 7205
#     sonar-smart    → port 7207
#     venice-mcp     → port 7206

set -euo pipefail

MAIN_DIR="$(cd "$(dirname "$0")/pydantic-agents" && pwd)"

# Sidecar dirs that are NOT already covered by the main compose
SIDECARS=(
  /home/pydantic-compose/browser-agent
  /home/pydantic-compose/perplexity-mcp
  /home/pydantic-compose/sonar-smart
  /home/pydantic-compose/venice-mcp
)

BUILD_FLAG="${BUILD:-}"   # set BUILD=--build to force image rebuild

log() { printf '\n\033[1;36m>>> %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; }

# ── Main stack ──────────────────────────────────────────────────────────────
log "Starting main pydantic-agents stack ($MAIN_DIR)"
if docker compose -f "$MAIN_DIR/docker-compose.yml" up -d $BUILD_FLAG; then
  ok "main stack up"
else
  err "main stack failed — continuing with sidecars anyway"
fi

# ── Unique sidecars ──────────────────────────────────────────────────────────
for dir in "${SIDECARS[@]}"; do
  name="$(basename "$dir")"
  if [[ ! -f "$dir/docker-compose.yml" ]]; then
    err "$name: docker-compose.yml not found, skipping"
    continue
  fi
  log "Starting sidecar: $name ($dir)"
  if docker compose -f "$dir/docker-compose.yml" up -d $BUILD_FLAG; then
    ok "$name up"
  else
    err "$name failed"
  fi
done

# ── Status summary ───────────────────────────────────────────────────────────
printf '\n\033[1;33m─── Running pydantic containers ───\033[0m\n'
docker ps --filter "name=pa-" --filter "name=nc-" \
  --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || \
  docker ps --filter "name=pa-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

printf '\n\033[1;32mDone.\033[0m  Tip: BUILD=--build bash docker-start-all.sh  to force image rebuild.\n'
