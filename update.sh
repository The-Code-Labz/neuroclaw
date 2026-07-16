#!/usr/bin/env bash
# update.sh — pull the latest NeuroClaw release, rebuild, and restart.
#
# Safe by design:
#   • Records the current commit for one-line rollback.
#   • Refuses to clobber uncommitted local changes (stash or abort — never
#     force-resets over your edits).
#   • Your config and data are gitignored (.env, *.db, backups/, workspaces/,
#     dist/) so a pull can't touch them.
#   • Schema migrations run automatically on next boot.
#
# Channels:
#   stable (default) — checks out the latest vX.Y.Z release tag. Predictable.
#   edge             — tracks the tip of the default branch. Set CHANNEL=edge.
#
# Usage:
#   ./update.sh                 # update to latest stable release
#   CHANNEL=edge ./update.sh    # track the latest commit on the main branch
#   ./update.sh --check         # show what an update would do, change nothing
#   ./update.sh --rollback SHA  # return to a previous commit (printed on update)
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CHANNEL="${CHANNEL:-stable}"
REMOTE="${REMOTE:-origin}"
CHECK_ONLY=0
ROLLBACK_TO=""
STASHED=0
LOCKFILE_BEFORE=""

# ── Output helpers ─────────────────────────────────────────────────────────
say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Build + restart helpers ────────────────────────────────────────────────
restart_service() {
  if systemctl list-units --type=service 2>/dev/null | grep -q neuroclaw-dashboard; then
    say "Restarting neuroclaw-dashboard service ..."
    systemctl restart neuroclaw-dashboard && ok "Service restarted."
  else
    warn "No systemd service detected — restart NeuroClaw manually to load the update."
    echo "     (e.g.  npm start   or your process manager's restart command)"
  fi
}

rebuild_and_restart() {
  local lockfile_after
  lockfile_after="$(git hash-object package-lock.json 2>/dev/null || echo none)"
  if [ -n "$LOCKFILE_BEFORE" ] && [ "$LOCKFILE_BEFORE" != "$lockfile_after" ]; then
    say "Dependencies changed — running npm ci ..."
    npm ci
  else
    ok "Dependencies unchanged — skipping npm ci."
  fi

  say "Building server + dashboard ..."
  npm run build
  npm run build:dashboard
  npm run build:dashboard:v4 2>/dev/null || true

  # Report any newly-required env keys (read-only — never writes .env).
  if [ -f scripts/env-diff.sh ]; then
    bash scripts/env-diff.sh || true
  fi

  restart_service
}

# ── Parse args ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --check)    CHECK_ONLY=1 ;;
    --edge)     CHANNEL=edge ;;
    --stable)   CHANNEL=stable ;;
    --rollback) ROLLBACK_TO="${2:-}"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v git >/dev/null || die "git is not installed."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Not a git checkout — did you clone the repo?"

CURRENT_SHA="$(git rev-parse HEAD)"
CURRENT_SHORT="$(git rev-parse --short HEAD)"

# ── Rollback path ──────────────────────────────────────────────────────────
if [ -n "$ROLLBACK_TO" ]; then
  LOCKFILE_BEFORE="$(git hash-object package-lock.json 2>/dev/null || echo none)"
  say "Rolling back to $ROLLBACK_TO ..."
  git checkout -q "$ROLLBACK_TO" || die "Could not check out $ROLLBACK_TO"
  ok "Checked out $ROLLBACK_TO. Rebuilding ..."
  rebuild_and_restart
  ok "Rolled back to $ROLLBACK_TO."
  exit 0
fi

# ── Guard: uncommitted local changes ───────────────────────────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "You have uncommitted local changes."
  echo "  Choose how to proceed:"
  echo "    1) Stash them, update, then restore  (git stash)"
  echo "    2) Abort and let me handle them myself"
  read -r -p "  Enter 1 or 2: " choice </dev/tty
  if [ "$choice" = "1" ]; then
    git stash push -u -m "update.sh autostash $(date -u +%FT%TZ)"
    STASHED=1
    ok "Local changes stashed."
  else
    die "Aborted. Commit or stash your changes, then re-run ./update.sh"
  fi
fi

say "Fetching latest from $REMOTE (channel: $CHANNEL) ..."
git fetch --tags --prune "$REMOTE"

# ── Resolve the target ref ─────────────────────────────────────────────────
if [ "$CHANNEL" = "edge" ]; then
  DEFAULT_BRANCH="$(git remote show "$REMOTE" | sed -n 's/.*HEAD branch: //p')"
  DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
  TARGET_REF="$REMOTE/$DEFAULT_BRANCH"
  TARGET_LABEL="$DEFAULT_BRANCH (edge)"
else
  TARGET_REF="$(git tag -l 'v*' --sort=-v:refname | head -1)"
  [ -n "$TARGET_REF" ] || die "No release tags (v*) found on $REMOTE. Use CHANNEL=edge to track the branch instead."
  TARGET_LABEL="$TARGET_REF (stable)"
fi

TARGET_SHA="$(git rev-parse "$TARGET_REF")"

restore_stash_if_any() {
  [ "$STASHED" = "1" ] && { git stash pop || warn "Stash pop had conflicts — resolve manually (git stash list)."; ok "Restored your stashed changes."; }
}

if [ "$TARGET_SHA" = "$CURRENT_SHA" ]; then
  ok "Already up to date ($TARGET_LABEL)."
  restore_stash_if_any
  exit 0
fi

# ── Show what will change ──────────────────────────────────────────────────
say "Update available: $TARGET_LABEL"
echo "  current: $CURRENT_SHORT"
echo "  target:  $(git rev-parse --short "$TARGET_SHA")"
echo ""
echo "  Changes:"
git log --no-merges --pretty='    • %s' "$CURRENT_SHA..$TARGET_SHA" 2>/dev/null | head -40 || true
echo ""

if [ "$CHECK_ONLY" = "1" ]; then
  ok "Check-only mode — nothing changed. Run ./update.sh to apply."
  restore_stash_if_any
  exit 0
fi

echo "  Rollback command (save this):  ./update.sh --rollback $CURRENT_SHORT"
echo ""

# ── Apply ──────────────────────────────────────────────────────────────────
LOCKFILE_BEFORE="$(git hash-object package-lock.json 2>/dev/null || echo none)"

say "Checking out $TARGET_LABEL ..."
git checkout -q "$TARGET_REF"

rebuild_and_restart
restore_stash_if_any

NEW_VERSION="$(cat VERSION 2>/dev/null || echo unknown)"
ok "Updated to $TARGET_LABEL (version $NEW_VERSION)."
echo "  Rolled forward from $CURRENT_SHORT. To undo:  ./update.sh --rollback $CURRENT_SHORT"
