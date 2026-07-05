# Dream Cycle Journal — Design Spec

**Date:** 2026-05-06  
**Status:** Approved  
**Scope:** Add Live + Journal sub-tabs to the existing Dream Cycle dashboard page

---

## Overview

The Dream Cycle page gets two sub-tabs below the existing pipeline visualization: **LIVE** and **JOURNAL**. The LIVE tab shows last cycle output when idle and streams step-by-step progress when a cycle is running. The JOURNAL tab is a browsable history of every past cycle. Everything flows from the existing `hive_mind` table — no new backend infrastructure required beyond a history API endpoint.

The REM analogy: just as the brain consolidates during sleep, this page lets you watch and review that consolidation in real-time and across time.

---

## Architecture

### Data source: hive_mind table

All data for both tabs already exists or will exist in the `hive_mind` table. The dream cycle already emits these events via `logHive()`:

| action | when emitted | key metadata |
|--------|-------------|--------------|
| `dream_cycle_start` | cycle begins | `lookbackHours` |
| `procedures_created` | procedures extracted | `count` |
| `memories_created` | insights written | `procedures`, `insights` counts |
| `memories_promoted` | transform step | `promoted` count |
| `memories_merged` | dedupe step | `merged` count |
| `memories_pruned` | prune step | `pruned` count |
| `plan_created` | plan written | `vault_path`, `priorities`, `tasks` counts |
| `dream_cycle_complete` | cycle finishes | full `DreamCycleResult` |
| `dream_cycle_failed` | cycle errors | error message |

### Live polling

The LIVE tab polls `/api/hive?limit=50` at **2-second intervals** only when a cycle is running (detected by a `dream_cycle_start` event without a matching `dream_cycle_complete`/`dream_cycle_failed`). At rest it polls on the normal 15s tick.

### History endpoint

New: `GET /api/dream/history` returns all past cycles, each assembled from a `dream_cycle_start` + `dream_cycle_complete` pair in `hive_mind`. Returns an array of `DreamCycleEntry` objects (see Data Models).

---

## Components

### 1. page-dream.jsx — full rewrite

The existing file is mostly static/mock. Replace it with a live-wired component.

**Structure:**
```
<Dream>
  <PageHeader>          — unchanged (title, enabled pill, next-run pill, Run Now button)
  <StatCards>           — unchanged (5 stat cards from last cycle)
  <PipelineVisualization> — unchanged (numbered nodes, gradient track)
  <SubTabs>             — NEW: "LIVE" | "JOURNAL"
    <LiveTab>           — NEW
    <JournalTab>        — NEW
```

### 2. LiveTab component

**Idle state** (no cycle running):
- Header: "LAST RUN · {date} · {duration} · complete ✓"
- Step list: 6 rows (gather / analyze / vault writes / transform / prune / plan), each with: status icon (✓), step name, result counts, timestamp
- Extracted this cycle: 2-column card grid of procedures and insights extracted (title + type + tags)
- Tomorrow plan block: plan title + top 4 priorities

**Running state** (cycle in progress):
- Header: "RUNNING · started {time} · {elapsed}s" with animated green badge
- Same step list, but steps fill in progressively as hive events arrive
- Steps not yet reached show as idle/muted
- Active step pulses

**State detection:** compare `dream_cycle_start` vs `dream_cycle_complete` timestamps in the last 50 hive events.

### 3. JournalTab component

**Layout:** two-column — list on left (220px), detail pane on right.

**List item:** date, "Dream #N" title (sequential counter), badges for memory count and duration.

**Detail pane** (shown when an entry is selected):
- Title + date + duration + status
- 4-stat row: sessions / extracted / promoted / written
- Step breakdown table: each step + its result counts
- Extracted insights: cards for each procedure/insight written that cycle
- Next-day plan block: plan title + top priorities

**Entry numbering:** `Dream #N` where N is the total count of `dream_cycle_complete` events, newest first.

---

## Data Models

### DreamCycleEntry (returned by /api/dream/history)
```typescript
interface DreamCycleEntry {
  id:          string;       // hive_mind row id of the complete event
  number:      number;       // sequential dream number (1-indexed, oldest first)
  startedAt:   string;       // ISO timestamp
  completedAt: string;       // ISO timestamp
  durationMs:  number;
  status:      'complete' | 'failed';
  scope: {
    sessionsAnalyzed: number;
    messagesScanned:  number;
    memoriesScanned:  number;
    tasksScanned:     number;
    commsScanned:     number;
  };
  output: {
    decisionsExtracted: number;
    patternsDetected:   number;
    proceduresCreated:  number;
    insightsCreated:    number;
    plansCreated:       number;
    memoriesPromoted:   number;
    memoriesMerged:     number;
    memoriesPruned:     number;
  };
  vaultPaths: {
    procedures: string[];
    insights:   string[];
    log:        string | null;
    plan:       string | null;
  };
  errors: string[];
}
```

The `output` and `vaultPaths` fields come from the `metadata` JSON column on the `dream_cycle_complete` hive event (the dream cycle already stores `DreamCycleResult` there).

### Live step mapping (hive event → step row)
```
dream_cycle_start      → step ① gather (active)
memories_created       → step ② analyze + ③ vault writes (done)
memories_promoted      → step ④ transform (done)
memories_merged        → step ④ transform (done, show merged count)
memories_pruned        → step ⑤ prune (done)
plan_created           → step ⑥ plan (done)
dream_cycle_complete   → all steps done, switch to idle state
dream_cycle_failed     → show error state
```

---

## Backend changes

### 1. New route: GET /api/dream/history

In `src/dashboard/routes.ts`:

```typescript
app.get('/api/dream/history', (c) => {
  const db = getDb();
  const completes = db.prepare(`
    SELECT id, metadata, created_at FROM hive_mind
    WHERE action = 'dream_cycle_complete'
    ORDER BY created_at DESC
    LIMIT 100
  `).all();

  // `startedAt` is already embedded in each complete event's DreamCycleResult metadata.
  // number = total count - index so newest entry gets the highest dream number.
  const entries = completes.map((row, i) => {
    const meta = JSON.parse(row.metadata || '{}');
    return {
      id:          row.id,
      number:      completes.length - i,
      startedAt:   meta.startedAt ?? row.created_at,
      completedAt: meta.completedAt ?? row.created_at,
      durationMs:  meta.durationMs ?? 0,
      status:      meta.ok === false ? 'failed' : 'complete',
      scope:       meta.scope  ?? {},
      output:      meta.output ?? {},
      vaultPaths:  meta.vaultPaths ?? { procedures: [], insights: [], log: null, plan: null },
      errors:      meta.errors ?? [],
    };
  });

  return c.json({ history: entries });
});
```

### 2. live-data.jsx — add DREAM live mapping

In the `applyLiveData()` function, add a `DREAM` section that reads from `r.hive` and `r.dream` (the history endpoint response):

```javascript
// ── DREAM (live tab state) ──
if (Array.isArray(r.hive)) {
  const dreamEvents = r.hive.filter(e => e.action && e.action.startsWith('dream_'));
  const lastStart    = dreamEvents.find(e => e.action === 'dream_cycle_start');
  const lastComplete = dreamEvents.find(e => e.action === 'dream_cycle_complete');
  const isRunning    = lastStart && (!lastComplete || lastStart.created_at > lastComplete.created_at);
  window.NC_DATA.DREAM = {
    ...window.NC_DATA.DREAM,
    running: isRunning,
    events:  dreamEvents,
    last:    lastComplete ? JSON.parse(lastComplete.metadata || '{}') : window.NC_DATA.DREAM.last,
  };
}
```

### 3. live-data.jsx — wire DREAM.history

In the `applyLiveData()` function, add a separate fetch to `/api/dream/history` and store the result:

```javascript
// Fetch dream history separately (not part of the main bundle)
try {
  const dh = await window.NC_API.get('/api/dream/history');
  if (Array.isArray(dh.history)) {
    window.NC_DATA.DREAM = { ...window.NC_DATA.DREAM, history: dh.history };
  }
} catch { /* leave existing DREAM.history intact */ }
```

This runs on every 15s tick. The JournalTab reads `window.NC_DATA.DREAM.history`.

---

## Frontend changes

### page-dream.jsx — full rewrite

Replace static mock with live-wired component that:
1. Reads `window.NC_DATA.DREAM` for live state and last-run stats
2. Reads `window.NC_DATA.DREAM.history` for journal entries
3. Manages `activeTab` state (`'live'` | `'journal'`) locally
4. Manages `activeEntry` state (selected journal entry) locally
5. Uses `window.NC_LIVE.refresh()` to manually trigger a data refresh after Run Now

The pipeline visualization nodes switch to `done` / `live` / `idle` CSS classes based on `DREAM.running` and which hive events have arrived.

---

## What does NOT change

- `src/memory/dream-cycle.ts` — no changes. All hive events it already emits are sufficient.
- The pipeline visualization layout and the 5 stat cards at the top of the page.
- The "Run Now" button behavior (already calls `POST /api/dream/run`).
- The vault write logic, memory consolidation, plan generation.

---

## Success criteria

1. **LIVE tab idle:** After a completed cycle, all 6 steps show ✓ with correct counts and timestamps drawn from hive_mind metadata.
2. **LIVE tab running:** Trigger a cycle via "Run Now"; steps fill in progressively within 2s of each hive event being written. Pipeline nodes animate.
3. **JOURNAL tab:** Past cycle runs appear in the list; clicking any entry populates the detail pane with that cycle's full stats, steps, insights, and plan.
4. **Vault + memory persistence:** unchanged — already works via `writeVaultNoteTool`.
5. **No regressions:** rest of the dashboard unaffected.
