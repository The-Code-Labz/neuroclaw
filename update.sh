#!/usr/bin/env bash
# update.sh — fetch the latest NeuroClaw release, rebuild, and restart.
#
# Safe by design:
#   • Records the current commit for one-line rollback.
#   • Refuses to clobber uncommitted local changes (stash or abort — never
#     force-resets over your edits).
#   • Your config and data are gitignored (.env, *.db, backups/, workspaces/,
#     dist/) so a fetch/checkout can't touch them.
#   • Schema migrations run automatically on next boot.
#   • Git fetch/checkout operations route through scripts/nc-git.sh when it is
#     present (the private multi-agent checkout uses it to serialize writes and
#     sanction the detached HEAD); public single-user clones fall back to plain
#     git automatically.
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

# ── Git wrapper ────────────────────────────────────────────────────────────
# Route git through scripts/nc-git.sh WHEN PRESENT (the private multi-agent
# checkout uses it to serialize concurrent writes and sanction the detached
# HEAD for its drift guard). Public single-user clones don't ship that wrapper
# (it's an internal-only tool), so transparently fall back to plain git.
ncgit() {
  if [ -x ./scripts/nc-git.sh ]; then
    NC_GIT_SELF_UPDATE=1 ./scripts/nc-git.sh "$@"
  else
    git "$@"
  fi
}

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

# ── Node version guard (Vite build needs Node 20+) ─────────────────────────
# The build (esbuild/Vite) requires Node >= 20. A box may default to an older
# `node` on PATH even when Node 20 is installed via nvm (e.g. the systemd
# service pins Node 20 but a plain shell does not). Activate Node 20 here so
# the build never silently fails on an old runtime.
ensure_node() {
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  if [ -n "$major" ] && [ "$major" -ge 20 ]; then
    ok "Node $(node -v) is OK for the build."
    return 0
  fi
  warn "Active node ($(node -v 2>/dev/null || echo none)) is < 20 — the build needs Node 20+. Trying nvm ..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +eu
    . "$NVM_DIR/nvm.sh"
    nvm use 20 >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || nvm use node >/dev/null 2>&1
    set -eu
  fi
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  if [ -z "$major" ] || [ "$major" -lt 20 ]; then
    die "Build requires Node >= 20 but the active node is $(node -v 2>/dev/null || echo none). Install/enable it (e.g. 'nvm install 20 && nvm use 20') and re-run ./update.sh"
  fi
  ok "Using Node $(node -v) for the build."
}

rebuild_and_restart() {
  ensure_node
  local lockfile_after nm_drift
  lockfile_after="$(git hash-object package-lock.json 2>/dev/null || echo none)"
  # Detect a direct dependency whose INSTALLED version no longer satisfies the
  # range in package.json — e.g. a stale jimp 1.x left behind by an install that
  # predated the current pin. The git-tip lockfile comparison alone misses this:
  # if the lockfile is identical between tips but node_modules was never
  # reconciled to it, we'd build against the wrong version and fail. If node/
  # semver/node_modules are missing or unreadable, this returns "1" (reinstall).
  nm_drift="$(node -e 'try{const semver=require("semver");const pj=require("./package.json");const deps=Object.assign({},pj.dependencies,pj.devDependencies);const inst=require("./node_modules/.package-lock.json").packages;let s="0";for(const name of Object.keys(deps)){const range=deps[name];const p=inst["node_modules/"+name];const have=p&&p.version;if(have&&range&&semver.validRange(range)&&!semver.satisfies(have,range)){s="1";break;}}process.stdout.write(s);}catch(e){process.stdout.write("1");}' 2>/dev/null || echo 1)"
  if { [ -n "$LOCKFILE_BEFORE" ] && [ "$LOCKFILE_BEFORE" != "$lockfile_after" ]; } || [ "$nm_drift" != "0" ]; then
    if [ "$nm_drift" != "0" ]; then
      say "Installed dependencies out of sync with package.json — running npm ci ..."
    else
      say "Dependencies changed — running npm ci ..."
    fi
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
  ncgit checkout -q "$ROLLBACK_TO" || die "Could not check out $ROLLBACK_TO"
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
ncgit fetch --tags --prune "$REMOTE"

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
ncgit checkout -q "$TARGET_REF"

rebuild_and_restart
restore_stash_if_any

NEW_VERSION="$(cat VERSION 2>/dev/null || echo unknown)"
ok "Updated to $TARGET_LABEL (version $NEW_VERSION)."
echo "  Rolled forward from $CURRENT_SHORT. To undo:  ./update.sh --rollback $CURRENT_SHORT"
