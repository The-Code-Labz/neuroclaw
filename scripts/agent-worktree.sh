#!/usr/bin/env bash
# agent-worktree.sh — per-agent isolated git worktrees.
#
# WHY: multiple agents editing the shared /home/neuroclaw-v1 checkout collide —
# they switch each other's branch, sweep each other's WIP into commits, and race
# on the index. The fix is one worktree per agent: a separate working directory
# with its own branch, sharing the same git object store. No collisions, full
# history, and the shared main checkout stays the stable deploy tree.
#
# USAGE:
#   scripts/agent-worktree.sh new <name> [base-branch]   # create isolated worktree (base default: main)
#   scripts/agent-worktree.sh list                        # show all worktrees
#   scripts/agent-worktree.sh rm  <name>                  # remove a worktree (must be clean)
#
# Each new worktree gets node_modules + .env symlinked from the main checkout so
# `npx tsc --noEmit` and config work immediately. NOTE: the app uses a relative
# DB_PATH (./neuroclaw.db), so running the server inside a worktree creates its
# OWN db — fine for isolation; symlink ./neuroclaw.db yourself if you need shared
# state.
set -euo pipefail

REPO=/home/neuroclaw-v1
WT_ROOT=/home/nclaw-worktrees        # worktrees live OUTSIDE the repo so they never show up as untracked

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

require_name() { [ -n "${1:-}" ] || { echo "error: <name> required" >&2; usage 1; }; }

case "${1:-}" in
  new)
    require_name "${2:-}"
    name=$2
    base=${3:-main}
    dir="$WT_ROOT/$name"
    branch="agent/$name"

    [ -e "$dir" ] && { echo "error: $dir already exists" >&2; exit 1; }
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch"; then
      echo "error: branch $branch already exists (pick another name, or 'rm' the old worktree)" >&2; exit 1
    fi

    mkdir -p "$WT_ROOT"
    git -C "$REPO" worktree add -b "$branch" "$dir" "$base"

    ln -sfn "$REPO/node_modules" "$dir/node_modules"
    [ -f "$REPO/.env" ] && ln -sfn "$REPO/.env" "$dir/.env"

    echo
    echo "✅ Isolated worktree ready:"
    echo "   dir:    $dir"
    echo "   branch: $branch  (off $base)"
    echo "   work there: cd $dir   # tsc + deps + config work via symlinks"
    echo "   when done:  scripts/agent-worktree.sh rm $name   (after merging your branch)"
    ;;

  list)
    git -C "$REPO" worktree list
    ;;

  rm)
    require_name "${2:-}"
    name=$2
    dir="$WT_ROOT/$name"
    # Drop the symlinks we created so they don't count as "untracked" and block
    # removal. git still refuses if REAL uncommitted work remains — the safety net.
    [ -L "$dir/node_modules" ] && rm -f "$dir/node_modules"
    [ -L "$dir/.env" ] && rm -f "$dir/.env"
    git -C "$REPO" worktree remove "$dir"
    git -C "$REPO" worktree prune
    echo "removed worktree $dir (branch agent/$name kept — delete with: git -C $REPO branch -D agent/$name)"
    ;;

  ""|-h|--help|help) usage 0 ;;
  *) echo "error: unknown command '${1}'" >&2; usage 1 ;;
esac
