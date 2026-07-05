# `nclaw doctor` — Implementation Report (Asagi)

**Date:** 2026-05-13
**Author:** Asagi (OpenCode)
**Status:** Shipped behind `nclaw doctor`. Independent of the dashboard chat overhaul.

## What was implemented

A standalone `nclaw doctor` subcommand that runs a registry of self-contained
diagnostic checks and prints a terminal or JSON report. Read-only by default;
`--fix` runs `automated` remediations (currently: `npm run build`).

### New files

- `src/doctor/types.ts` — `DoctorCheck`, `DoctorResult`, `DoctorCtx`, `DoctorReport`, `Severity`, `Scope`.
- `src/doctor/registry.ts` — `register()`, `listChecks()`, `getCheck()`, `_resetRegistry()` (test-only).
- `src/doctor/runner.ts` — iterates `listChecks()`, executes the optional automated fix in a child shell with a 2-minute timeout, re-runs the check after a successful fix, and produces a `DoctorReport`.
- `src/doctor/format.ts` — terminal renderer (zero deps, inline ANSI, respects `NO_COLOR` and non-TTY) and JSON renderer (strips the function reference from each check before serialising).
- `src/doctor/index.ts` — public exports + `cli(argv)` entry point + `if (require.main === module)` bootstrap for `tsx`.
- `src/doctor/checks/index.ts` — side-effect imports for all shipped checks.
- `src/doctor/checks/vault-dist-fresh.ts` — vault source vs dist mtime comparison.
- `src/doctor/checks/discord-placeholders.ts` — snowflake regex check against `discord_bots`, `discord_channel_routes`, optional `alert_targets`.
- `src/doctor/checks/alert-dispatcher-targets.ts` — validates `ALERT_DISCORD_CHANNEL_ID`, `ALERT_DISCORD_BOT_ID` (cross-checked against `discord_bots`), `NOTIFY_DISCORD_*`, Gotify URL+token pairing, `cron_jobs.on_complete_webhook_url`.
- `src/doctor/checks/voidai-rate-limit-state.ts` — counts VoidAI 429/rate-limit events in `hive_mind` over the last hour; threshold 5.
- `src/doctor/checks/forge-mount-paths.ts` — confirms Forge skill script presence + `FORGE_EMAIL`/`FORGE_PASSWORD` pairing + JWT cache visibility.
- `src/doctor/checks/kimi-context-budget.ts` — flags any active agent whose system-prompt token estimate exceeds 60% of its known context window.
- `src/doctor/checks/mcp-build-stamps.ts` — generalised dist-fresh for the local stdio MCP server plus file-path MCP rows.
- `docs/doctor.md` — operator + developer documentation (usage, exit codes, check table, JSON shape, how to add a check, programmatic API).
- `docs/reports/2026-05-13--asagi-doctor-implementation.md` — this report.

### Modified files

- `src/cli-code.ts` — added a subcommand dispatch block above the chat TUI initialisation. `process.argv[2] === 'doctor'` routes to `./doctor`'s `cli(argv)` and exits with its return code. Kept above the `VOIDAI_API_KEY` and Alfred-existence guards so the doctor can run on a partially-broken system.
- `package.json` — added `doctor` and `doctor:fix` scripts under the existing `check:*` block.

## Acceptance test results

All eight acceptance tests pass.

| # | Test | Result |
| - | ---- | ------ |
| 1 | Clean system passes (exit 0, all green) | ✅ `7 passed, 0 warned, 0 failed (7 total · 0.03s)` |
| 2 | Stale vault dist detected | ✅ `touch src/memory/vault-client.ts` → `vault.dist-fresh` flips to `fail` with `npm run build` suggestion |
| 3 | `--fix` runs build | ✅ Re-run after `touch` with `--fix` ran `npm run build` (16.3s), re-checked, green |
| 4 | Placeholder Discord ID detected | ✅ Inserted `discord_channel_routes` row with `channel_id='your_channel_id_here'` → check fails listing the row, exit 1 |
| 5 | Scope filter works | ✅ `--scope=discord` ran 1 check |
| 6 | JSON output is valid | ✅ `node dist/cli-code.js doctor --json 2>/dev/null | python3 -c "import sys,json;json.load(sys.stdin)"` parses, contains the full report shape |
| 7 | One check throwing doesn't break others | ✅ Test-only `test.boom` check registered alongside the 7 shipped checks; runner reports `ok=false, detail="Check threw: boom"` and all other 7 still ran and passed |
| 8 | Exit codes correct | ✅ Clean → 0. `severity=fail` failing → 1. `severity=warn` failing only → 0 (verified by inserting 6 fake VoidAI 429 events into `hive_mind`) |

Runtime on a healthy system: **~30 ms** (well under the 5-second budget).

## Deviations from the spec and reasoning

1. **`getDb()` logs to stderr during `initSchema`.** The spec's JSON-output
   acceptance test assumed clean stdout. `getDb()` writes
   `[INFO] Database schema initialized` via the logger; that line goes to
   stderr (verified — `2>/dev/null` suppresses it). The shipped renderer
   writes to `process.stdout.write` so `nclaw doctor --json 2>/dev/null`
   produces clean parseable JSON. **No change to logger or db.** When run
   under `npm run doctor`, npm itself prefixes stdout with its `> tsx ...`
   header line, so the documented invocation is via the `nclaw` binary
   directly, not the npm script. This is reflected in `docs/doctor.md`.

2. **`hive_mind` not `hive_events`.** The spec's snippet referenced a
   `hive_events` table with `level` and `source` columns. The actual table
   is `hive_mind(id, agent_id, action, summary, metadata, run_id, created_at, session_id)`. The check was rewritten to filter on
   `action LIKE '%rate_limit%' OR summary LIKE '%429%'` AND
   `summary LIKE '%VoidAI%'` (lowercase + capitalised, since alfred.ts writes
   "VoidAI error HTTP 429 (..." literally).

3. **No `alert_targets` table exists.** The shipped schema routes all alerts
   through `ALERT_DISCORD_CHANNEL_ID` env. The `discord.placeholder-ids`
   check still queries `alert_targets` inside a `try {}` (per the spec) so
   the code is forward-compatible when that table lands; it's silently
   skipped today.

4. **`vault-search.ts` does not exist.** Only `vault-client.ts` is in
   `src/memory/`. The check lists both pairs but skips any source that
   doesn't exist on disk (per the spec's `try {}` pattern). Today only
   `vault-client.ts` is enforced; if/when `vault-search.ts` is split out, it
   becomes enforced automatically.

5. **`alert_targets`-style cross-check inside `alert-dispatcher.targets`** is
   limited because the dispatcher is env-driven (single channel + bot), not
   table-driven. The check therefore validates `ALERT_DISCORD_*`,
   `NOTIFY_DISCORD_*`, `GOTIFY_*`, and `cron_jobs.on_complete_webhook_url`.

6. **Forge mount paths are a soft `info` check.** This repo does not store
   mount-path config — the Forge skill talks to a remote backend and (when
   used) caches JWT in-process. The check verifies script presence, env
   pairing, and JWT cache file; treats "Forge unused" as the default ok
   state. Severity downgraded to `info` so an absent Forge configuration
   never fails CI.

7. **`kimi.context-budget` suggestion mentions `tool_scope='core'` but the
   `agents.tool_scope` column does not yet exist.** Per the spec: the
   suggestion text is still actionable today (reduce skills/tools, shorten
   prompt) and forward-compatible once the OpenClaw tool-scope work lands.

8. **The runner re-runs a check after a successful automated fix.** The
   spec implied the report shows the pre-fix state; I chose to show the
   post-fix state (with `fixApplied: { ok: true, output: ... }` adjacent)
   because that matches the human mental model when reading the terminal
   output ("✓ ok, fix applied OK"). The pre-fix detail is recoverable from
   `git diff` of the source if anyone needs it; the report semantics are
   "this is the current state after doctor finished".

9. **`renderTerminal` writes via `process.stdout.write` instead of
   `console.log`** so trailing newlines are explicit and don't get
   double-buffered with the logger's writes. `renderJson` likewise. No
   functional difference, just predictable output.

## Suggested follow-up checks (future PRs)

A short list, ordered by how soon the underlying schema / runtime will support
them:

1. **`runtime.queue-depth`** — after Sprint 2.5 LaneQueue lands. Warn when
   the per-lane backlog exceeds a configurable threshold; surfaces the same
   thing the Sentinel dashboard panel does but as a CI gate.
2. **`runs.stuck`** — once the `agent_runs` table extension lands, count
   `status='running'` rows older than `TASK_HEALTH_ERROR_MIN`. Today the
   runtime auto-marks them `dropped` on restart, but mid-flight stalls are
   invisible.
3. **`discord.bot-reconnect-loops`** — count `discord_bots.status='error'`
   rows that have flipped status more than N times in the last hour
   (requires a new `discord_bot_status_history` table — out of scope for
   doctor itself).
4. **`memory.heartbeat-gaps`** — flag any agent whose last `agent_heartbeat`
   in `hive_mind` is older than 2×`TASK_HEALTH_INTERVAL_MIN` while the
   agent is active.
5. **`mcp.server-probe-fresh`** — flag any `mcp_servers` row whose
   `last_probed_at` is more than 1 hour old AND `enabled=1`.
6. **`tools.composio-cache`** — when `composio_enabled=1`, verify the
   Composio tool cache for that user is non-empty and not older than 24 h.
7. **`vault.disk-space`** — warn when the NeuroVault checkout has < 10%
   free disk on its mount; today this only surfaces when a save throws.
8. **`auth.voidai-key`** — best-effort: hit a lightweight VoidAI endpoint
   (e.g. `/v1/models`); flag HTTP 500 (which VoidAI returns for bad keys
   per `AGENTS.md`).
9. **`mcp.tool-manifest-size`** — sum tool count across all enabled
   `mcp_servers`; warn when total exceeds the size that's known to push
   small-context models over their window.
10. **`config.env-required`** — sweep `process.env` for the required vars
    listed in `.env.example` and flag any that are missing.

## What was not implemented (and why)

- **Sentinel scheduled run.** The spec called out adding doctor to
  `src/system/sentinel.ts` "later, but not in this PR." Honoured. The
  programmatic API (`runDoctor({ ctx, emit: false })`) is in place and
  documented for the follow-up.
- **A unit-test suite.** The repo doesn't currently have a test framework
  (per `AGENTS.md`: "No unit test framework yet"). The eight acceptance
  tests were run manually using the verified commands; one-shot Node
  scripts under `/tmp/opencode` were used to verify the throw-isolation
  case. When a test framework lands, the doctor surfaces are ideal first
  candidates: `register()` collisions, `listChecks(scope)` filtering,
  `runDoctor()` summary math, and golden-file snapshots of `renderJson`.

## Definition-of-done checklist

- [x] All 8 acceptance tests pass.
- [x] `npm run build` is clean (no new TS errors anywhere in the repo).
- [x] `nclaw doctor` runs in well under 5 s on a healthy system (~30 ms).
- [x] `nclaw doctor --json` produces machine-parseable output suitable for
      Sentinel to consume later (verified with `python3 -c json.load`).
- [x] `docs/doctor.md` documents every shipped check with id, scope,
      severity, what it checks, and what the fix is.
- [x] No changes to the dashboard, agent runtime, Discord bot, memory
      consolidator, existing `src/diagnostics/` scripts, or any of the
      schemas listed in the spec's "What you must NOT change" section.
