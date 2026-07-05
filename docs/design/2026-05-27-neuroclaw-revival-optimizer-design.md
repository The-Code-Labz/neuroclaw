# NeuroClaw Revival + SystemOptimizer Design

**Date:** 2026-05-27  
**Status:** Approved (post-review revision 1)  
**Approach:** A — Revival first, then SystemOptimizer  

---

## Overview

Two sequential phases:

1. **Phase 1 — Revival**: Close 4 pending features (80–90% done) plus one bonus Claude Code skill hygiene script.
2. **Phase 2 — SystemOptimizer**: Add one new autonomous sweep that mines NeuroClaw's own behavioral logs to generate ranked improvement insights, stored in a new `system_insights` table and surfaced on the dashboard.

No changes to existing sweeps (Curator, Dream Cycle), no changes to agent routing, tool registry, or provider stack. Purely additive.

---

## Phase 1 — Revival

### 1. Canvas Tab

**State:** 7 commits local on `main`, not pushed.  
**Finish line:** Browser-test the srcdoc preview, expand overlay, `/view` route, and activity strip. Push to remote once passing.  
**Owner:** Claude Code  

### 2. Perplexity MCP (Sonar Agent)

**State:** Container deployed at `/home/pydantic-compose/perplexity-mcp/`. Awaiting smoke test.  
**Finish line:**
1. Verify container is running (`docker ps` or equivalent)
2. Hit the smoke test endpoint
3. Register `@Sonar` agent in the dashboard
4. Confirm `@Sonar` routing works from the CLI

**Owner:** Claude Code  

### 3. Subagent Tier Fix

**State:** Two confirmed bugs — codex missing mid-tier entry in `model_catalog`; non-chat-capable models surfacing in VoidAI tier selection.

**Codebase reality (verified):**
- Table: `model_catalog` in `src/db.ts`
- `chat_capable` column **already exists** (migration line 868: `ALTER TABLE model_catalog ADD COLUMN chat_capable INTEGER NOT NULL DEFAULT 1`)
- Filter function: `isChatCapable()` in `src/system/sub-agent-triage.ts` lines 55–63 — queries `chat_capable` and falls back to litellm at line 83. The filter logic exists; the gap is the data.

**Fix:**
1. Add missing codex mid-tier row: seed or upsert a `model_catalog` row for the codex provider with `tier='mid'` and `chat_capable=1`. Exact `model_id` to be confirmed from the live Codex model list at implementation time.
2. Mark non-chat models: for VoidAI catalog entries that are embeddings/image models, set `chat_capable=0` via a one-time migration or seed guard in `db.ts:runMigrations()`.
3. No new column or migration needed for `chat_capable` — it already exists.

**Owner:** Claude Code  

### 4. Venice Image MCP

**State:** Code-complete at `/home/pydantic-compose/venice-mcp/`. Blocked on session token.  
**Finish line:**
1. User retrieves session token from venice.ai DevTools (manual step)
2. Inject token into sidecar env
3. Start container
4. Register in dashboard
5. Smoke test image generation

**Owner:** User (token retrieval) → Claude Code (wiring + test)  

### 5. Claude Code Skill Hygiene (Bonus)

A lightweight audit script (not automated deletion) that:
- Reads skill names from `/home/neuroclaw-v1/skills-lock.json`
- Queries `skill_invocations` table for each skill name, looking at `injected_at` over the last 30 days
- Flags skills with zero invocations in that window as stale candidates
- Outputs a markdown report to stdout (human decides what to remove)

Query pattern:
```sql
SELECT skill_name, COUNT(*) as invocations
FROM skill_invocations
WHERE injected_at > datetime('now', '-30 days')
GROUP BY skill_name
```

Cross-reference against skills-lock.json to find entries with zero rows = stale.

**Owner:** Claude Code  

---

## Phase 2 — SystemOptimizer

NeuroClaw produces rich behavioral signal — hive_mind events, analytics_events, routing decisions, task outcomes — but nothing reads that signal back to drive improvement. The SystemOptimizer closes that loop.

### New Table: `system_insights`

```sql
CREATE TABLE system_insights (
  id           TEXT PRIMARY KEY,
  category     TEXT NOT NULL,    -- 'routing' | 'agent' | 'provider' | 'prompt' | 'skill'
  severity     TEXT NOT NULL,    -- 'critical' | 'warning' | 'info'
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,    -- pre-formatted human-readable description
  action       TEXT,             -- pre-formatted suggested fix (human-readable)
  evidence     TEXT,             -- opaque JSON blob for future programmatic use;
                                 -- dashboard renders body+action only, not evidence
  sweep_id     TEXT NOT NULL,    -- groups insights from one run
  dismissed_at TEXT,             -- set when user dismisses
  updated_at   TEXT DEFAULT (datetime('now')),
  created_at   TEXT DEFAULT (datetime('now'))
);
```

`updated_at` is refreshed when an existing open insight is escalated (severity or body changes).  
Migration: additive, via `runMigrations()` try/catch block (existing pattern).

### New File: `src/system/optimizer.ts`

Runs nightly at 03:00 local time — after Curator (02:00), before Dream Cycle (04:00). Controlled by `OPTIMIZER_ENABLED` and `OPTIMIZER_RUN_TIME` env vars.

**Scheduling pattern:** Mirrors `msUntilNext()` from `src/system/curator.ts` exactly — parses `HH:MM`, uses local time via `new Date().setHours()`, falls back to 24h interval on invalid or missing input, reschedules itself after each run.

**Five analyzers:**

| Analyzer | Signal Source | Insight Category | What it finds |
|---|---|---|---|
| `routingAnalyzer` | `hive_mind WHERE action='route_fallback'` | `routing` | Agents with chronic fallback-routing → classifier confidence gap |
| `agentAnalyzer` | `hive_mind` + `sessions` | `agent` | Agents with 0 calls in `OPTIMIZER_AGENT_INACTIVE_DAYS` days → prune candidates |
| `providerAnalyzer` | `analytics_events WHERE event_type LIKE '%_error'` | `provider` | Providers with error rate >10% over `OPTIMIZER_LOOKBACK_DAYS` days (verified types: `server_error`, `discord_error`) |
| `promptAnalyzer` | `messages WHERE role='assistant' AND agent_id = ?` | `prompt` | Recurring "I don't know" / "I can't" patterns per agent → prompt gaps (uses confirmed `agent_id` column) |
| `skillAnalyzer` | `skill_invocations` | `skill` | Skills in `skills-lock.json` with zero invocations in `OPTIMIZER_LOOKBACK_DAYS` days → dead weight; skills with very high frequency → promote to core capability |

Note: Tool call analytics are not instrumented in `analytics_events`. The former `toolAnalyzer` is replaced by `skillAnalyzer` which uses the `skill_invocations` table (already populated).

**Sweep execution:**
1. Generate `sweep_id` (UUID)
2. Run all 5 analyzers in parallel via `Promise.all`
3. **Deduplication with escalation:** for each draft insight, check for an existing open (non-dismissed) insight with the same `category` + `title`:
   - If **none found**: `INSERT` as new insight
   - If **found and severity/body changed**: `UPDATE` existing row — set new `severity`, `body`, `action`, `evidence`, `updated_at`. Do NOT insert a duplicate.
   - If **found and unchanged**: skip (no-op)
4. Log to `hive_mind` with action `optimizer_sweep_complete` and `metadata: { sweep_id, inserted, updated, skipped }`

**Error handling:** Each analyzer is wrapped in try/catch. A failing analyzer logs to hive_mind (`optimizer_analyzer_failed`) and is skipped — the sweep continues with remaining analyzers.

### Dashboard: System Health Panel

Added to the existing **Status** tab (no new tab). Positioned below the agent/session counts.

- **Header:** "System Health" + last sweep timestamp + total open insight count
- **Grouped by severity:** 🔴 Critical → 🟠 Warning → 🔵 Info
- **Each card:** title, body text, suggested action, "Dismiss" button
- **Dismiss behavior:** sets `dismissed_at = now()` on the insight; card disappears from UI immediately (optimistic remove)
- **Evidence:** not rendered in the UI — stored for future programmatic use only
- **Auto-cleanup:** dismissed insights older than 7 days are deleted by Curator. Query added to `runCuratorSweep()` in `src/system/curator.ts`:
  ```sql
  DELETE FROM system_insights
  WHERE dismissed_at IS NOT NULL
    AND dismissed_at < datetime('now', '-7 days');
  ```

### New API Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/insights` | List open (non-dismissed) insights; optional `?category=` and `?severity=` filters |
| POST | `/api/insights/:id/dismiss` | Set `dismissed_at = now()` on an insight |

Both endpoints follow existing auth pattern (`?token=` or `x-dashboard-token` header).

### New Config Variables

| Variable | Default | Notes |
|---|---|---|
| `OPTIMIZER_ENABLED` | `true` | Disable to turn off the sweep entirely |
| `OPTIMIZER_RUN_TIME` | `03:00` | 24h local time; mirrors `CURATOR_RUN_TIME` parsing pattern |
| `OPTIMIZER_LOOKBACK_DAYS` | `7` | Window for routing, provider, and skill pattern analysis |
| `OPTIMIZER_AGENT_INACTIVE_DAYS` | `14` | Separate window for agent-staleness check (slower signal than errors) |
| `OPTIMIZER_MIN_CALLS_THRESHOLD` | `1` | Agent call count below this = "never called" for agentAnalyzer |

### Startup Integration

`startOptimizer()` exported from `src/system/optimizer.ts`, called in the same startup block as `startCurator()` and `startCleanupScheduler()` in `src/index.ts` (and `src/dashboard/server.ts` if applicable). Checks `OPTIMIZER_ENABLED` before scheduling.

---

## What Does Not Change

- Dream Cycle logic (memory consolidation)
- Curator logic (session archiving) — except one `DELETE` query added to `runCuratorSweep()` for dismissed insights
- Agent routing, classifier, decomposer
- Tool registry and provider stack
- All existing dashboard tabs and API endpoints

---

## Implementation Order

```
Phase 1:
  1. Canvas tab browser test + push
  2. Perplexity MCP smoke test + register
  3. Subagent tier fix (codex mid-tier row + VoidAI non-chat guard)
  4. Venice Image MCP (pending user token)
  5. Skill hygiene report script

Phase 2:
  6. system_insights schema + migration (including updated_at)
  7. optimizer.ts (5 analyzers + sweep runner with update-on-escalation dedup)
  8. Startup integration in src/index.ts
  9. /api/insights endpoints in src/dashboard/routes.ts
  10. Dashboard System Health panel in dashboard HTML/JSX
  11. Curator cleanup query in src/system/curator.ts:runCuratorSweep()
  12. .env.example additions + CLAUDE.md env table update (project-local /home/neuroclaw-v1/CLAUDE.md)
```
