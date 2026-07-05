# Task–Agent Lifecycle Robustness

**Date:** 2026-05-08  
**Status:** Approved  
**Scope:** `task-watchdog.ts`, `sentinel.ts`, `hive-mind.ts`

## Problem

Tasks get stuck in `doing` status with a dead `agent_id` and nothing requeues them:

- **Watchdog** requeues stuck tasks after 2 hours, but if `agent_id` is set to an inactive agent it still enqueues the job for that inactive agent (the status check only runs in the no-agent fallback path).
- **Sentinel** fires after 3 minutes but silently skips tasks whose agent is inactive — no requeue, just a debug log.
- **Session cleanup** already guards against deleting sessions tied to active tasks — no change needed there.

The root cause: task lifecycle is not coupled to agent lifecycle. When an agent goes inactive, its owned tasks stay in `doing` indefinitely.

## Architecture

Three targeted changes:

### 1. `task-watchdog.ts` — add `recoverOrphanedTasks()` pass

A new function that runs **before** the existing `recoverStuckTasks()` on every poll cycle (every 10 minutes). It has **no time threshold** — a dead agent is an immediate problem regardless of how long the task has been running.

Query: tasks in `doing` status where `agent_id IS NOT NULL` and the joined agent has `status != 'active'` (or no matching agent row at all).

Action per orphaned task:
- `updateTask(id, { status: 'todo', agent_id: null })`
- `logHive('orphaned_doing_task_requeued', ..., { taskId, previousAgentId, source: 'watchdog' })`
- Does **not** increment `failure_count` — this is an infrastructure failure, not a task failure.

### 2. `sentinel.ts` — patch `processStaleTask()` at escalation_level 0

Current behavior at escalation_level 0:
- `agent_id` is null → debug log, return false (skip). **Unchanged.**
- agent is active → `checkInWithAgent()`. **Unchanged.**

New behavior:
- agent is **inactive** → reset task + clean up sentinel state:
  1. `updateTask(id, { status: 'todo', agent_id: null })`
  2. `DELETE FROM sentinel_task_state WHERE task_id = id` — so the next time this task goes `doing` with a new agent, the sentinel cycle starts fresh
  3. `logHive('orphaned_doing_task_requeued', ..., { taskId, previousAgentId, source: 'sentinel' })`
  4. `return false` — do not escalate further

**Why delete the sentinel state row:** Without the delete, when the task next goes `doing` with a fresh agent the sentinel sees a stale `escalation_level=0` record and behaves as if an escalation cycle is already in progress. Deleting ensures a clean slate.

### 3. `hive-mind.ts` — new hive event action

Add `'orphaned_doing_task_requeued'` to the `HiveAction` union type. Payload shape:

```ts
{ taskId: string; previousAgentId: string; source: 'watchdog' | 'sentinel' }
```

## Data Flow

### Watchdog orphan pass

```
recoverOrphanedTasks()  [new, runs first]
  │
  ├─ Query: tasks WHERE status='doing' AND agent_id IS NOT NULL
  │         LEFT JOIN agents ON agents.id = tasks.agent_id
  │         WHERE agents.status != 'active' OR agents.id IS NULL
  │
  ├─ For each orphaned task:
  │   ├─ updateTask(id, { status: 'todo', agent_id: null })
  │   └─ logHive('orphaned_doing_task_requeued', ..., { taskId, previousAgentId, source: 'watchdog' })
  │
  └─ recoverStuckTasks() runs after (time-based, 2h threshold, unchanged)
```

### Sentinel orphan path

```
processStaleTask()
  └─ escalation_level === 0
      ├─ agent_id null        → debug log, return false  [unchanged]
      ├─ agent inactive (NEW) → updateTask todo + clear agent_id
      │                       → DELETE sentinel_task_state row
      │                       → logHive orphaned_doing_task_requeued
      │                       → return false
      └─ agent active         → checkInWithAgent()       [unchanged]
```

## Error Handling

- Both passes wrap per-task operations in try/catch — one bad row does not abort the sweep.
- If `updateTask` throws: log warn, continue to next task.
- The sentinel state DELETE is in the same logical block as `updateTask`. If either fails, the task will be re-discovered on the next cycle and the operation retried.
- No new retry logic needed — idempotent by design.

## Testing

No test suite; `npx tsc --noEmit` is the primary gate.

Manual verification steps:
1. Insert a task with `status='doing'` and `agent_id` pointing to an inactive agent in SQLite.
2. Call `recoverOrphanedTasks()` directly; confirm task is `todo` with `agent_id = null` and a `hive_mind` row with action `orphaned_doing_task_requeued`.
3. Same for the sentinel path: set `updated_at` to 10 minutes ago, call `runSentinelScan()`, confirm task reset + `sentinel_task_state` row deleted.

## Out of Scope

- Alert dispatcher fixes
- Memory schema (tags_any/tags_all mismatch)
- Job worker or background-tasks changes
- Any new environment variables or config
