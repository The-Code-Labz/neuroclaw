---
title: Dream cycle
order: 35
---

# Dream cycle

The dream cycle is NeuroClaw's nightly offline memory consolidation pass. While no active conversations are expected, the system reviews everything that happened during the day — chat sessions, inter-agent messages, tasks — and distills it into durable, structured knowledge. Raw episodic memories are promoted to semantic or procedural form, near-duplicate entries are merged, noise is pruned, and a prioritised plan for the next day is generated.

The analogy to biological sleep is intentional: the system processes and reorganises recent experience rather than accumulating an ever-growing pile of raw events.

## What it does

The cycle runs as a sequential eight-step pipeline:

1. **Gather.** Pulls sessions, messages, `memory_index` rows, tasks, and `agent_messages` from the last `DREAM_LOOKBACK_HOURS` hours.

2. **Per-session LLM analysis.** Each session transcript is sent to the configured model with a focused prompt. The model returns four structured lists: *decisions* (explicit choices made), *patterns* (recurring problems or themes), *procedures* (step-by-step how-tos worth saving), and *insights* (meta-observations and heuristics).

3. **Memory transformation.** Episodic memories with identical token signatures are grouped. Groups of two are promoted to `semantic`; groups of three or more are promoted to `procedural`. Salience scores are bumped for every member of the group so frequently-visited concepts become easier to retrieve.

4. **Semantic dedupe.** Token Jaccard similarity is computed across pairs of locally-stored, non-vault-mirrored memories of the same type. Pairs scoring ≥ 0.65 are merged — the lower-scoring row is deleted and the winner's salience is nudged up. Vault-anchored memories are never touched by this step.

5. **Prune.** Low-signal entries are deleted from `memory_index`. A row must satisfy all four conditions to be pruned: not vault-mirrored, importance < 0.4, salience < 0.2, and last accessed more than seven days ago.

6. **Next-day plan.** The aggregated decisions, patterns, procedure titles, insight titles, and open tasks (`todo` / `doing`) are passed to a second LLM call. The model produces a structured plan with a title, summary, priorities, suggested tasks, unresolved blockers, and workflow optimisations. The plan is written to the vault as a `plan`-type memory.

7. **Vault writes.** Procedures, insights, the plan, and a daily log summary are all written via `writeVaultNoteTool`. When `MCP_ENABLED` is false, vault mirroring is skipped and the rows live only in SQLite — the cycle degrades cleanly.

8. **Hive Mind logging.** Every meaningful step (`dream_cycle_start`, `procedures_created`, `memories_promoted`, `memories_merged`, `memories_pruned`, `plan_created`, `dream_cycle_complete` or `dream_cycle_failed`) is logged to the `hive_mind` table for auditability.

The cycle is protected against concurrent runs — if a run is already in progress, any additional trigger (scheduled or manual) returns immediately with `ok: false` and the message `dream cycle is already running`.

## When it runs

`startDreamScheduler()` is called when the dashboard server boots. If `DREAM_ENABLED` is `false` (the default), it returns immediately and no timer is set.

When enabled, the scheduler computes how many milliseconds remain until the next wall-clock occurrence of `DREAM_RUN_TIME` (default `03:00` local server time) and sets a `setTimeout` for that moment. After each run completes — successfully or not — the next run is immediately rescheduled, so the cycle fires once per 24-hour period without drift accumulation.

## Manual trigger

Send an authenticated POST request to run the cycle on demand:

```
POST /api/dream/run
```

The call is synchronous — it waits for the full pipeline to finish before responding. The response body is the complete `DreamCycleResult` object:

```json
{
  "ok": true,
  "startedAt": "2026-05-05T03:00:01.234Z",
  "completedAt": "2026-05-05T03:01:47.891Z",
  "durationMs": 106657,
  "scope": {
    "sessionsAnalyzed": 8,
    "messagesScanned": 214,
    "memoriesScanned": 63,
    "tasksScanned": 11,
    "commsScanned": 4
  },
  "output": {
    "decisionsExtracted": 17,
    "patternsDetected": 6,
    "proceduresCreated": 3,
    "insightsCreated": 5,
    "plansCreated": 1,
    "memoriesPromoted": 4,
    "memoriesMerged": 2,
    "memoriesPruned": 9
  },
  "vaultPaths": {
    "procedures": ["vault/procedures/..."],
    "insights": ["vault/insights/..."],
    "log": "vault/logs/...",
    "plan": "vault/plans/..."
  },
  "errors": []
}
```

HTTP 200 on success, HTTP 500 if `ok` is false. Non-fatal errors (e.g. a single procedure write failing) are captured in the `errors` array rather than aborting the whole run.

## Status check

```
GET /api/dream/status
```

Returns the current configuration and the 20 most recent dream-related Hive Mind events (starts, completions, and failures):

```json
{
  "enabled": false,
  "runTime": "03:00",
  "lookback": 24,
  "model": "(extractor / voidai default)",
  "events": [
    {
      "created_at": "...",
      "summary": "Dream cycle complete (106657ms)",
      "metadata": { ... }
    }
  ]
}
```

Use this endpoint to confirm the scheduler is active, verify the last run time, and inspect per-run metadata without querying the database directly.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DREAM_ENABLED` | `false` | Set to `true` to enable the nightly scheduler. Manual triggering via `POST /api/dream/run` works regardless of this setting. |
| `DREAM_RUN_TIME` | `03:00` | Wall-clock time (HH:MM, 24-hour, local server timezone) at which the scheduler fires each night. |
| `DREAM_LOOKBACK_HOURS` | `24` | How far back the gather step reaches when pulling sessions, memories, tasks, and comms. |
| `DREAM_MODEL` | *(MEMORY_EXTRACT_MODEL or VOIDAI_MODEL)* | Override the model used for session analysis and plan generation. Falls back to the memory extractor model, then the global default. |
