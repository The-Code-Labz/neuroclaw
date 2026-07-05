# Task–Agent Lifecycle Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent tasks from getting permanently stuck in `doing` status when their assigned agent goes inactive.

**Architecture:** Three targeted edits — add a new hive event type, add an orphan-detection pass to the watchdog, and patch sentinel to reset instead of skip when it finds a task with a dead agent. No new files, no new tables, no new env vars.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Node.js setInterval

---

## File Map

| File | Change |
|---|---|
| `src/system/hive-mind.ts` | Add `'orphaned_doing_task_requeued'` to `HiveAction` union (line 94) |
| `src/system/task-watchdog.ts` | Add `OrphanedTaskRow` interface + `recoverOrphanedTasks()` function; wrap both passes in `runWatchdogCycle()` |
| `src/system/sentinel.ts` | Import `updateTask`; patch `processStaleTask()` inactive-agent branch to reset instead of skip |

---

## Task 1: Add `orphaned_doing_task_requeued` to HiveAction

**Files:**
- Modify: `src/system/hive-mind.ts:94`

- [ ] **Step 1: Edit `hive-mind.ts`**

Find line 94 (currently `| 'task_recovered';`) and replace with:

```typescript
  | 'task_recovered'
  | 'orphaned_doing_task_requeued';
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors. If you see errors referencing `HiveAction`, check that you didn't accidentally remove the semicolon from the new last line.

- [ ] **Step 3: Commit**

```bash
git add src/system/hive-mind.ts
git commit -m "feat(hive): add orphaned_doing_task_requeued action type"
```

---

## Task 2: Add orphan-detection pass to task watchdog

**Files:**
- Modify: `src/system/task-watchdog.ts`

- [ ] **Step 1: Add `OrphanedTaskRow` interface and `recoverOrphanedTasks()` after the existing `StuckTaskRow` interface (after line 18)**

Insert this block between the `StuckTaskRow` interface and the `recoverStuckTasks` function:

```typescript
interface OrphanedTaskRow {
  id:                string;
  title:             string;
  previous_agent_id: string;
}

async function recoverOrphanedTasks(): Promise<void> {
  const db = getDb();

  const orphaned = db.prepare(`
    SELECT t.id, t.title, t.agent_id AS previous_agent_id
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    WHERE t.status   = 'doing'
      AND t.archived = 0
      AND t.agent_id IS NOT NULL
      AND (a.id IS NULL OR a.status != 'active')
  `).all() as OrphanedTaskRow[];

  if (orphaned.length === 0) return;
  logger.info(`task-watchdog: found ${orphaned.length} orphaned task(s) with inactive/deleted agent`);

  for (const task of orphaned) {
    try {
      updateTask(task.id, { status: 'todo', agent_id: null });
      logHive(
        'orphaned_doing_task_requeued',
        `Task "${task.title}" reset to todo — agent ${task.previous_agent_id} is inactive/deleted`,
        undefined,
        { taskId: task.id, previousAgentId: task.previous_agent_id, source: 'watchdog' },
      );
      logger.info(`task-watchdog: orphaned task "${task.title}" (${task.id}) reset — previous agent ${task.previous_agent_id}`);
    } catch (err) {
      logger.warn(`task-watchdog: failed to reset orphaned task ${task.id}`, { error: (err as Error).message });
    }
  }
}
```

- [ ] **Step 2: Replace the two direct `recoverStuckTasks()` calls in `startTaskWatchdog()` with a combined cycle**

Current `startTaskWatchdog()` (lines 95–105) calls `recoverStuckTasks()` directly in two places. Replace the entire function body with:

```typescript
export function startTaskWatchdog(): void {
  const runCycle = (): void => {
    recoverOrphanedTasks().catch(err =>
      logger.warn('task-watchdog: orphan scan error', { error: (err as Error).message }),
    );
    recoverStuckTasks().catch(err =>
      logger.warn('task-watchdog: stuck scan error', { error: (err as Error).message }),
    );
  };

  runCycle();
  watchdogTimer = setInterval(runCycle, POLL_INTERVAL_MS);
  logger.info('task-watchdog: started (orphan pass + 2h stuck threshold, 10m interval)');
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors. The `OrphanedTaskRow` type and the `updateTask`/`logHive` imports are already available (both were imported at the top of the file in the original).

- [ ] **Step 4: Verify manually**

Open a SQLite shell against the database:

```bash
sqlite3 neuroclaw.db
```

Insert a test orphan (use a real inactive agent id from your agents table, or temporarily set one to inactive):

```sql
-- Find an inactive agent id (or set one temporarily)
SELECT id, name, status FROM agents WHERE status = 'inactive' LIMIT 1;

-- Insert a fake doing task pointing at that agent
INSERT INTO tasks (id, title, status, agent_id, assignee, priority, priority_level, sources, code_examples, archived)
VALUES (
  'test-orphan-001', 'Test orphan task', 'doing',
  '<inactive-agent-id-here>', 'User', 50, 'medium', '[]', '[]', 0
);
```

Then in the running server (or by calling the function in a quick script), trigger a watchdog cycle. Confirm:

```sql
SELECT id, title, status, agent_id FROM tasks WHERE id = 'test-orphan-001';
-- Expected: status='todo', agent_id=NULL

SELECT action, summary FROM hive_mind WHERE action = 'orphaned_doing_task_requeued' ORDER BY created_at DESC LIMIT 1;
-- Expected: one row with the task title in summary
```

Clean up:

```sql
DELETE FROM tasks WHERE id = 'test-orphan-001';
```

- [ ] **Step 5: Commit**

```bash
git add src/system/task-watchdog.ts
git commit -m "feat(watchdog): add orphan pass — immediately requeues doing tasks with inactive agent"
```

---

## Task 3: Patch sentinel to reset orphaned tasks instead of skipping

**Files:**
- Modify: `src/system/sentinel.ts:14` (imports), `src/system/sentinel.ts:334-345` (processStaleTask)

- [ ] **Step 1: Add `updateTask` import**

Find the existing import from `'../db'` (lines 13–17):

```typescript
import {
  getDb, createSession, getAllAgents, getAgentById,
  getAlfredAgent, getSentinelAgent,
  type AgentRecord,
} from '../db';
```

Add a new import line directly below it:

```typescript
import { updateTask } from './task-manager';
```

- [ ] **Step 2: Replace the inactive-agent branch in `processStaleTask()`**

Find this block inside `processStaleTask()` (around lines 334–345):

```typescript
    const agent = getAgentById(agentId);
    if (!agent || agent.status !== 'active') {
      logger.debug('sentinel: stale task agent inactive, skipping', { taskId: task.id, agentId });
      return false;
    }
```

Replace it with:

```typescript
    const agent = getAgentById(agentId);
    if (!agent || agent.status !== 'active') {
      try {
        updateTask(task.id, { status: 'todo', agent_id: null });
        getDb().prepare('DELETE FROM sentinel_task_state WHERE task_id = ?').run(task.id);
        logHive(
          'orphaned_doing_task_requeued',
          `Sentinel reset task "${task.title}" to todo — agent ${agentId} is inactive/deleted`,
          undefined,
          { taskId: task.id, previousAgentId: agentId, source: 'sentinel' },
        );
        logger.info('sentinel: orphaned task reset to todo', { taskId: task.id, agentId });
      } catch (err) {
        logger.warn('sentinel: failed to reset orphaned task', { taskId: task.id, error: (err as Error).message });
      }
      return false;
    }
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors. If you see a circular import error between `sentinel.ts` and `task-manager.ts`, check whether `task-manager.ts` imports from `sentinel.ts` — it doesn't, so this should be clean.

- [ ] **Step 4: Verify manually**

Insert a stale doing task with an inactive agent, with `updated_at` in the past (so sentinel's stale threshold triggers), and no existing sentinel state:

```sql
INSERT INTO tasks (id, title, status, agent_id, assignee, priority, priority_level, sources, code_examples, archived, updated_at)
VALUES (
  'test-sentinel-orphan-001', 'Test sentinel orphan', 'doing',
  '<inactive-agent-id-here>', 'User', 50, 'medium', '[]', '[]', 0,
  datetime('now', '-10 minutes')
);
```

Trigger `runSentinelScan()` (either wait for the interval or call via a test script). Confirm:

```sql
SELECT id, title, status, agent_id FROM tasks WHERE id = 'test-sentinel-orphan-001';
-- Expected: status='todo', agent_id=NULL

SELECT * FROM sentinel_task_state WHERE task_id = 'test-sentinel-orphan-001';
-- Expected: 0 rows (state was deleted)

SELECT action, summary FROM hive_mind WHERE action = 'orphaned_doing_task_requeued' ORDER BY created_at DESC LIMIT 1;
-- Expected: row with 'sentinel' in metadata source field
```

Clean up:

```sql
DELETE FROM tasks WHERE id = 'test-sentinel-orphan-001';
```

- [ ] **Step 5: Commit**

```bash
git add src/system/sentinel.ts
git commit -m "fix(sentinel): reset orphaned tasks to todo instead of skipping when agent is inactive"
```

---

## Final Verification

- [ ] **Full type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors across all three modified files.

- [ ] **Confirm hive event appears in dashboard**

Start the server (`npm run dashboard`) and check `GET /api/hive?limit=20`. After the next watchdog cycle, if any real orphaned tasks exist you should see `orphaned_doing_task_requeued` events in the response JSON.
