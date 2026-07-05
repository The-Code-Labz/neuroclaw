# Debug Log Persistence & Dashboard Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `logger.debug()` calls to a `debug_logs` SQLite table with 24h rolling retention, add a `GET /api/logs/debug` endpoint, emit live `debug` SSE events, and wire the Logs page DEBUG filter to pull from the DB instead of the file tail.

**Architecture:** New `debug_logs` table in `src/db.ts` (migration + helpers); `logger.ts` lazy-loads `insertDebugLog` via the same pattern as `tryLogToAnalytics`; `cleanup.ts` purges rows older than 24h on the existing 5-min scheduler; `routes.ts` adds one REST endpoint and one SSE event type; `page-logs.jsx` switches its fetch target and SSE listener when DEBUG is selected.

**Tech Stack:** TypeScript, better-sqlite3, Hono (SSE via `streamSSE`), React (no build step — CDN JSX in browser)

**Verification:** This project has no test suite. Use `npx tsc --noEmit` as the correctness gate after every task. Run from `/home/neuroclaw-v1`.

---

## File Map

| File | Change |
|---|---|
| `src/db.ts` | Add `debug_logs` table to migrations array; add `DebugLogRow` interface + `insertDebugLog()` + `getDebugLogs()` |
| `src/utils/logger.ts` | Add `tryLogToDebug()` (lines 96-130 region); call it from `log()` after `tryLogToAnalytics` |
| `src/system/cleanup.ts` | Add `purgeOldDebugLogs()` function; call it at startup and inside the 5-min interval |
| `src/dashboard/routes.ts` | Add `GET /api/logs/debug` endpoint near line 2963; add `debug` SSE event to `/api/logs/stream` handler |
| `src/dashboard/v2/src/page-logs.jsx` | On DEBUG filter: fetch from `/api/logs/debug`; listen for `debug` SSE events instead of `line` events |

---

## Task 1: Add `debug_logs` table and DB helpers

**Files:**
- Modify: `src/db.ts` (migrations array ends at line 723; `DowntimeEvent` section ends ~line 2931)

- [ ] **Step 1: Add the CREATE TABLE to the migrations array**

In `src/db.ts`, find the end of the `alters` array (the last entry before the closing `];` at line 724). Add these two entries immediately before `'ALTER TABLE tasks ADD COLUMN reviewer_feedback...'`:

```typescript
  `CREATE TABLE IF NOT EXISTS debug_logs (
    id         TEXT PRIMARY KEY,
    session_id TEXT,
    agent_id   TEXT,
    source     TEXT NOT NULL DEFAULT 'system',
    message    TEXT NOT NULL,
    data       TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_debug_logs_created_at ON debug_logs(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_debug_logs_source     ON debug_logs(source)',
```

- [ ] **Step 2: Add `DebugLogRow` interface after the `DowntimeEvent` block (~line 2931)**

Locate the line `// ── Workflow runs` (around line 2933) and insert before it:

```typescript
// ── Debug logs ────────────────────────────────────────────────────────────

export interface DebugLogRow {
  id:         string;
  session_id: string | null;
  agent_id:   string | null;
  source:     string;
  message:    string;
  data:       string | null;
  created_at: string;
}
```

- [ ] **Step 3: Add `insertDebugLog()` immediately after the interface**

```typescript
export function insertDebugLog(row: Omit<DebugLogRow, 'created_at'>): void {
  try {
    getDb().prepare(`
      INSERT INTO debug_logs (id, session_id, agent_id, source, message, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.session_id ?? null,
      row.agent_id   ?? null,
      row.source,
      row.message.slice(0, 2000),
      row.data ?? null,
    );
  } catch { /* never crash callers */ }
}
```

- [ ] **Step 4: Add `getDebugLogs()` immediately after `insertDebugLog`**

```typescript
export function getDebugLogs(opts: {
  limit?:      number;
  source?:     string;
  session_id?: string;
  agent_id?:   string;
}): DebugLogRow[] {
  try {
    const { limit = 500, source, session_id, agent_id } = opts;
    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (source) {
      conditions.push("source LIKE ?");
      params.push(`%${source}%`);
    }
    if (session_id) {
      conditions.push("session_id = ?");
      params.push(session_id);
    }
    if (agent_id) {
      conditions.push("agent_id = ?");
      params.push(agent_id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(limit, 1000));

    return getDb().prepare(`
      SELECT * FROM debug_logs ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...params) as DebugLogRow[];
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Verify types**

```bash
npx tsc --noEmit
```

Expected: no errors. If you see "Cannot find name 'getDebugLogs'" or similar, check that the functions are exported and the interface is above them.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): add debug_logs table, insertDebugLog, getDebugLogs"
```

---

## Task 2: Wire logger to persist debug entries

**Files:**
- Modify: `src/utils/logger.ts` (lines 58–130 region)

- [ ] **Step 1: Add module-level state for the debug inserter (after line 59)**

Locate these two lines:
```typescript
let analyticsTracker: ((eventType: string, data?: unknown) => void) | null = null;
let analyticsLoading = false;
```

Add immediately after them:
```typescript
let debugInserter: ((row: { id: string; session_id: string | null; agent_id: string | null; source: string; message: string; data: string | null }) => void) | null = null;
let debugLoading = false;
```

- [ ] **Step 2: Add `tryLogToDebug()` function after `tryLogToAnalytics()` (after line 96)**

Find the closing `}` of `tryLogToAnalytics` and add immediately after it:

```typescript
function tryLogToDebug(message: string, data?: unknown): void {
  if (!debugInserter && !debugLoading) {
    debugLoading = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const db = require('../db');
      if (typeof db.insertDebugLog === 'function') {
        debugInserter = db.insertDebugLog;
      }
    } catch {
      debugLoading = false;
    }
  }

  if (debugInserter) {
    try {
      const { randomUUID } = require('crypto') as typeof import('crypto');
      const src = extractSrc(message);
      const rawData = data as Record<string, unknown> | undefined;
      debugInserter({
        id:         randomUUID(),
        session_id: (rawData?.sessionId as string) ?? null,
        agent_id:   (rawData?.agentId   as string) ?? null,
        source:     src,
        message:    message.slice(0, 2000),
        data:       data !== undefined ? JSON.stringify(data).slice(0, 1000) : null,
      });
    } catch { /* never crash the logger */ }
  }
}
```

- [ ] **Step 3: Call `tryLogToDebug` from `log()` (after line 129)**

Find this line in `log()`:
```typescript
  tryLogToAnalytics(level, message, data);
```

Add immediately after it:
```typescript
  if (level === 'debug') tryLogToDebug(message, data);
```

- [ ] **Step 4: Verify types**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/logger.ts
git commit -m "feat(logger): persist debug entries to debug_logs table"
```

---

## Task 3: Add 24h purge to cleanup scheduler

**Files:**
- Modify: `src/system/cleanup.ts`

- [ ] **Step 1: Add `purgeOldDebugLogs()` before `startCleanupScheduler()`**

In `src/system/cleanup.ts`, find `let cleanupTimer: NodeJS.Timeout | null = null;` (line 30) and insert before it:

```typescript
function purgeOldDebugLogs(): void {
  try {
    const db = getDb();
    db.prepare("DELETE FROM debug_logs WHERE created_at < datetime('now', '-24 hours')").run();
  } catch { /* non-fatal */ }
}
```

- [ ] **Step 2: Update `startCleanupScheduler()` to call the purge**

Find the `startCleanupScheduler` function body. The `setInterval` callback currently reads:

```typescript
  cleanupTimer = setInterval(() => {
    const count = expireTemporaryAgents();
    if (count > 0) logger.info(`cleanup: expired ${count} temp agent(s)`);
  }, 5 * 60 * 1000);
```

Replace it with:

```typescript
  cleanupTimer = setInterval(() => {
    const count = expireTemporaryAgents();
    if (count > 0) logger.info(`cleanup: expired ${count} temp agent(s)`);
    purgeOldDebugLogs();
  }, 5 * 60 * 1000);
```

Also call it once at startup — find the existing startup block:

```typescript
  const n = expireTemporaryAgents();
  if (n > 0) logger.info(`cleanup: expired ${n} temp agent(s) on startup`);
```

Add one line after it:

```typescript
  purgeOldDebugLogs();
```

- [ ] **Step 3: Add `getDb` import if not already imported**

Check the top of `src/system/cleanup.ts`. It already imports `{ getDb, logAudit }` from `'../db'` — `getDb` is already there. No change needed.

- [ ] **Step 4: Verify types**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/system/cleanup.ts
git commit -m "feat(cleanup): purge debug_logs entries older than 24h"
```

---

## Task 4: Add REST endpoint and SSE debug events

**Files:**
- Modify: `src/dashboard/routes.ts` (around lines 2963 and 2977)

- [ ] **Step 1: Import `getDebugLogs` and `DebugLogRow` at the top of routes.ts**

Find the existing import from `'../db'` at line ~24. Add `getDebugLogs` and `DebugLogRow` to it. The import will look something like:

```typescript
import {
  // ... existing imports ...
  getDebugLogs,
  type DebugLogRow,
} from '../db';
```

(Add to the existing destructured import list, don't create a second import from `'../db'`.)

- [ ] **Step 2: Add `GET /api/logs/debug` endpoint near line 2963**

Find:
```typescript
  app.get('/api/logs',      (c) => c.json(getRecentLogs()));
```

Add immediately after it:
```typescript
  app.get('/api/logs/debug', (c) => {
    const limit      = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 1000);
    const source     = c.req.query('source')     ?? undefined;
    const session_id = c.req.query('session_id') ?? undefined;
    const agent_id   = c.req.query('agent_id')   ?? undefined;
    return c.json(getDebugLogs({ limit, source, session_id, agent_id }));
  });
```

- [ ] **Step 3: Add `debug` event emission to the SSE stream handler**

Find the `/api/logs/stream` SSE handler (around line 2977). It currently has:

```typescript
      const onLine = async (line: ParsedLogLine) => {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'line', line }) });
        } catch { /* stream closed */ }
      };

      logEvents.on('line', onLine);
```

Add a second listener immediately after `logEvents.on('line', onLine)`:

```typescript
      const onDebug = async (row: DebugLogRow) => {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'debug', line: {
            t:          row.created_at,
            lvl:        'DEBUG',
            src:        row.source,
            msg:        row.message,
            session_id: row.session_id,
            agent_id:   row.agent_id,
          }}) });
        } catch { /* stream closed */ }
      };

      logEvents.on('debug', onDebug);
```

Then find the `stream.onAbort` cleanup block:
```typescript
      stream.onAbort(() => {
        logEvents.off('line', onLine);
        clearInterval(pingId);
        resolve();
      });
```

Add `logEvents.off('debug', onDebug);` inside that block:

```typescript
      stream.onAbort(() => {
        logEvents.off('line', onLine);
        logEvents.off('debug', onDebug);
        clearInterval(pingId);
        resolve();
      });
```

- [ ] **Step 4: Emit `debug` events from `logger.ts`**

In `src/utils/logger.ts`, find the `log()` function. After the existing `logEvents.emit('line', ...)` call (around line 120-126), add:

```typescript
  if (level === 'debug') {
    try {
      // Emit a structured debug event for the SSE stream (picked up by routes.ts)
      logEvents.emit('debug', {
        id:         '',            // not assigned yet; filled by DB insert
        session_id: (data as Record<string, unknown> | undefined)?.sessionId as string ?? null,
        agent_id:   (data as Record<string, unknown> | undefined)?.agentId   as string ?? null,
        source:     extractSrc(message),
        message:    message + dataStr,
        data:       null,
        created_at: new Date().toISOString(),
      });
    } catch { /* never crash */ }
  }
```

- [ ] **Step 5: Verify types**

```bash
npx tsc --noEmit
```

Expected: no errors. Common pitfall: if TypeScript complains about `logEvents.on('debug', onDebug)` because `ParsedLogLine` is the typed event, the `logEvents` EventEmitter is untyped (`EventEmitter`) so any string event name is fine — no cast needed.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/routes.ts src/utils/logger.ts
git commit -m "feat(api): add /api/logs/debug endpoint and debug SSE event"
```

---

## Task 5: Wire Logs page DEBUG filter to DB

**Files:**
- Modify: `src/dashboard/v2/src/page-logs.jsx`

The Logs component currently:
- Fetches `/api/logs/tail?limit=100` on mount for all filters
- SSE `line` events always append to the display

We need to change both behaviors when the `DEBUG` filter is active.

- [ ] **Step 1: Add a `debugLines` state and a fetch-on-DEBUG-select effect**

Find the existing state declarations at the top of the `Logs` component:
```jsx
  const [lines,  setLines]  = React.useState([]);
  const [paused, setPaused] = React.useState(false);
  const [lvl,    setLvl]    = React.useState('ALL');
  const [grep,   setGrep]   = React.useState('');
  const [bufLen, setBufLen] = React.useState(0);
```

Add one new state:
```jsx
  const [debugLines, setDebugLines] = React.useState([]);
```

Then find the first `React.useEffect` (the one that calls `/api/logs/tail`). Replace it with:

```jsx
  // Fetch initial lines: debug from DB, others from file tail
  React.useEffect(() => {
    if (lvl === 'DEBUG') {
      fetch('/api/logs/debug?limit=500', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : [])
        .then(data => {
          if (!Array.isArray(data)) return;
          // Map DebugLogRow → ParsedLogLine shape the component expects
          setDebugLines(data.map(r => ({
            t:   r.created_at,
            lvl: 'DEBUG',
            src: r.source,
            msg: r.message,
          })));
        })
        .catch(() => {});
    } else {
      fetch('/api/logs/tail?limit=100', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : [])
        .then(data => { if (Array.isArray(data)) setLines(data); })
        .catch(() => {});
    }
  }, [lvl]);
```

- [ ] **Step 2: Update the SSE effect to handle `debug` events**

Find the SSE `useEffect`. It currently has:
```jsx
        es.onmessage = (e) => {
          try {
            const ev = JSON.parse(e.data);
            if (ev.type !== 'line') return;
            if (pausedRef.current) {
              bufRef.current.push(ev.line);
              setBufLen(bufRef.current.length);
            } else {
              setLines(prev => [...prev.slice(-300), ev.line]);
            }
          } catch { /* ignore */ }
        };
```

Replace with:
```jsx
        es.onmessage = (e) => {
          try {
            const ev = JSON.parse(e.data);
            if (ev.type === 'debug') {
              // Only append to debug view if DEBUG filter is active
              if (lvl === 'DEBUG') {
                setDebugLines(prev => [...prev.slice(-300), ev.line]);
              }
              return;
            }
            if (ev.type !== 'line') return;
            if (pausedRef.current) {
              bufRef.current.push(ev.line);
              setBufLen(bufRef.current.length);
            } else {
              setLines(prev => [...prev.slice(-300), ev.line]);
            }
          } catch { /* ignore */ }
        };
```

Note: `lvl` is captured in the SSE closure. Because the SSE effect has `[]` deps (mounts once), this creates a stale closure. Fix by adding `lvl` to a ref:

Find `const pausedRef = React.useRef(false);` and add:
```jsx
  const lvlRef = React.useRef(lvl);
  React.useEffect(() => { lvlRef.current = lvl; }, [lvl]);
```

Then update the SSE handler to use `lvlRef.current` instead of `lvl`:
```jsx
              if (lvlRef.current === 'DEBUG') {
```

- [ ] **Step 3: Update the `filtered` computation to use `debugLines` for DEBUG**

Find:
```jsx
  const filtered = lines
    .filter(l => {
      if (lvl === 'ALL') return true;
      ...
    })
    .filter(l => !grep || ...);
```

Replace with:
```jsx
  const activeLines = lvl === 'DEBUG' ? debugLines : lines;
  const filtered = activeLines
    .filter(l => {
      if (lvl === 'ALL') return true;
      if (lvl === 'TRACE') return l.lvl === 'DEBUG';
      if (lvl === 'ARCHIVIST') return (l.src ?? '').toLowerCase().includes('archivist') || (l.msg ?? '').toLowerCase().includes('archivist');
      return l.lvl === lvl;
    })
    .filter(l => !grep || (l.msg + ' ' + l.src).toLowerCase().includes(grep.toLowerCase()));
```

- [ ] **Step 4: Update the line count display**

Find:
```jsx
          <div className="mono muted" style={{ fontSize: 10 }}>{filtered.length} of {lines.length} lines</div>
```

Replace with:
```jsx
          <div className="mono muted" style={{ fontSize: 10 }}>{filtered.length} of {activeLines.length} lines</div>
```

- [ ] **Step 5: Verify the page renders correctly**

Since this project has no build step for the dashboard JSX (it's CDN React), type checking won't catch JSX errors. Start the dashboard and manually verify:

```bash
npm run dashboard
```

Open the dashboard → Logs page. Click DEBUG filter. Confirm:
- The display clears and fetches from `/api/logs/debug` (check Network tab — should see a request to `/api/logs/debug?limit=500`)
- Switching back to `ALL` fetches `/api/logs/tail` again
- New `logger.debug()` calls (e.g. from any agent action) appear live in the DEBUG view

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/v2/src/page-logs.jsx
git commit -m "feat(logs): wire DEBUG filter to DB-backed debug_logs with live SSE"
```

---

## Self-Review

### Spec coverage
- [x] Persist `debug`-level log entries to SQLite (Task 1 + Task 2)
- [x] 24h rolling retention cap (Task 3)
- [x] `session_id` / `agent_id` carried from structured `data` payloads (Task 2 `tryLogToDebug`)
- [x] `GET /api/logs/debug` endpoint with `limit`, `source`, `session_id`, `agent_id` filters (Task 4)
- [x] SSE `debug` event emitted live (Task 4)
- [x] Logs page DEBUG filter fetches from DB (Task 5)
- [x] Logs page DEBUG filter receives live SSE debug events (Task 5)
- [x] All other filters unchanged (Task 5 — only `activeLines` changes, not the filter logic)

### Type consistency
- `DebugLogRow` defined in Task 1; used in Task 4 (`onDebug` parameter type) — consistent
- `insertDebugLog` takes `Omit<DebugLogRow, 'created_at'>` — matches what `tryLogToDebug` passes (no `created_at`)
- `getDebugLogs` returns `DebugLogRow[]` — matches what the route passes to `c.json()`
- SSE `debug` event shape uses `DebugLogRow` fields mapped to `ParsedLogLine`-compatible shape — consistent with what `page-logs.jsx` consumes

### Placeholder scan
None found.
