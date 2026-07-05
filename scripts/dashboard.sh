#!/usr/bin/env bash
# Wrapper for `npm run dashboard` — kills ALL previous dashboard processes
# before starting a new one, so restarts never accumulate zombie instances.

set -euo pipefail

PIDFILE=/tmp/neuroclaw-dashboard.pgid

# ── Kill previous instance by tracked PGID ───────────────────────────────────
if [ -f "$PIDFILE" ]; then
  OLD_PGID=$(cat "$PIDFILE")
  if [ -n "$OLD_PGID" ]; then
    kill -9 -- "-$OLD_PGID" 2>/dev/null && echo "[dashboard.sh] killed process group $OLD_PGID" || true
  fi
  rm -f "$PIDFILE"
fi

# ── Fallback: force-kill anything with dashboard/server in its cmdline ────────
# Catches orphans that were re-parented to init, and instances started
# without this script. -9 so they can't defer the signal.
pkill -9 -f "dashboard/server" 2>/dev/null || true

# ── Release the port ──────────────────────────────────────────────────────────
fuser -k 3141/tcp 2>/dev/null || true

# Give the OS time to reap and release the port.
sleep 1

# ── Record our actual PGID then exec the server ──────────────────────────────
# `ps -o pgid= -p $$` reads the process group of THIS shell from the kernel —
# reliable regardless of how npm wraps us. The exec replaces bash with tsx so
# the whole tree (tsx + node child) shares that PGID.
MYPGID=$(ps -o pgid= -p $$ | tr -d ' ')
echo "$MYPGID" > "$PIDFILE"

exec ./node_modules/.bin/tsx watch src/dashboard/server.ts
