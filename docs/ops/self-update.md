# GitHub Self-Update

One-action "pull from GitHub → rebuild frontend → restart" with automatic rollback.
Ships **DORMANT** — `UPDATE_ENABLED=false` by default.

## How it works

1. `GET /api/system/update/check` — fetches `UPDATE_REMOTE/UPDATE_BRANCH` (PAT injected
   via `http.extraHeader`, never in a URL), reports behind-count + changelog, and issues
   a single-use nonce.
2. `POST /api/system/update` (must echo the nonce) — tags a rollback anchor, `merge --ff-only`,
   conditionally `npm install` (if `package*.json` changed) and `npm run build:dashboard`
   (if `src/dashboard/**` frontend changed), gates on `tsc --noEmit`, then restarts.
   Progress streams over SSE.
3. On `tsc` / build / deps failure mid-update → auto `git reset --hard <rollback-tag>` (no restart).

## Boot canary (crash-loop protection)

- **Layer A (systemd `ExecStartPre` → `scripts/update-precheck.cjs`)** — runs *before* tsx, so it
  catches import-time/syntax crashes no in-process hook can see. Counts failed post-update boots
  and, after `UPDATE_CANARY_MAX_ATTEMPTS` (default 2), auto-reverts to the pre-update SHA.
  Fail-open (never blocks a normal boot); no-op when no `.update-marker.json` is present.
  Wired via drop-in `/etc/systemd/system/neuroclaw-dashboard.service.d/self-update.conf`.
- **Layer B (`server.ts` `uncaughtException`)** — while a post-update boot is unproven, a startup
  throw calls `process.exit(1)` so it actually crashes (and Layer A counts it) instead of limping.
- **Clear-marker** — a healthy boot (HTTP listening + migrations run) clears the marker so the
  next boot won't revert.

## Config (env)

| var | default | meaning |
|-----|---------|---------|
| `UPDATE_ENABLED` | `false` | kill switch — flip to `true` to expose the feature |
| `UPDATE_REMOTE` | `origin` | trust-pinned remote (request bodies can't override) |
| `UPDATE_BRANCH` | `main` | trust-pinned branch |
| `UPDATE_CANARY_MAX_ATTEMPTS` | `2` | failed boots before auto-revert |
| `UPDATE_ROLLBACK_KEEP` | `5` | rollback tags retained |

## Operating rules / caveats

- **Migrations must stay backward-compatible with the immediately-prior release.** Code-rollback
  (Layer A/B revert) reverts CODE only, never schema — an auto-reverted old binary runs against a
  forward-migrated DB. All current migrations add nullable/defaulted columns (safe); keep it that way.
- **`ff-only` requires the remote to be a fast-forward.** If local `main` has diverged from the
  trust-pinned remote, update refuses — keep the release remote fast-forward-clean.
- **The stdio MCP bridge** (`dist/mcp/stdio-server.js`, Claude-Desktop) is a *compiled* artifact
  self-update does NOT touch — run `npm run build` manually if that bridge needs the new code.
- **`/chat-mode`** (`chat-mode.html`) is served directly, not Vite-built — not part of the rebuild.
- **Dirty tree** — update refuses on uncommitted *tracked* changes unless `{stash:true}`; untracked
  dirs (`_shared/` etc.) are ignored. A stashed change is surfaced in the result (`stashRef`) — pop
  it manually after the restart.

## Activation checklist

1. Ensure the trust-pinned remote (`origin`/`main` or a dedicated release remote) is current &
   fast-forwardable from the running commit.
2. Set `UPDATE_ENABLED=true` in `.env`, restart.
3. Use the **System Update** card in Settings, or curl `/api/system/update/check`.
