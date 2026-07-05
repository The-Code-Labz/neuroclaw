# Debug Log Persistence & Dashboard Wiring

**Date:** 2026-05-10
**Status:** Approved

## Problem

`logger.debug()` writes to `logs/neuroclaw.log` only. The analytics DB has no debug-level entries, the Logs page DEBUG filter only works against the in-memory file tail buffer, and agent thought/tool-result traces are lost on restart. There is no way to query or correlate debug activity by session or agent after the fact.

## Goals

1. Persist all `debug`-level log entries to SQLite with a 24-hour rolling retention cap.
2. Wire the existing Logs page DEBUG filter to pull from the DB (live + historical), not just the file tail.
3. Agent-tagged debug entries (`agent-thought`, `tool-result`, etc.) carry `session_id` and `agent_id` so they can be correlated.

## Out of Scope

- A dedicated Debug page or new nav item (the existing Logs page is the surface).
- Analytics page changes.
- Manual debug mode toggle / env var gate — persistence is always on.

---

## Architecture

### New Table: `debug_logs`

Migration added to `runMigrations()` in `src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS debug_logs (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  agent_id   TEXT,
  source     TEXT NOT NULL,
  message    TEXT NOT NULL,
  data       TEXT,                    -- JSON, optional
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_debug_logs_created_at ON debug_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_debug_logs_source     ON debug_logs(source);
```

**Helper functions in `src/db.ts`:**

- `insertDebugLog({ id, session_id?, agent_id?, source, message, data? })` — inserts one row; wrapped in try/catch, never throws.
- `getDebugLogs({ limit, source?, session_id?, agent_id? })` — SELECT newest-first with optional filters; returns `DebugLogRow[]`.

### Retention

`src/system/cleanup.ts` — add `purgeOldDebugLogs()` called inside the existing `startCleanupScheduler()` interval (runs every 5 minutes on startup):

```ts
function purgeOldDebugLogs(): void {
  db.prepare("DELETE FROM debug_logs WHERE created_at < datetime('now', '-24 hours')").run();
}
```

### Logger Integration (`src/utils/logger.ts`)

Add `tryLogToDebug()` alongside the existing `tryLogToAnalytics()`. Same lazy-load pattern — loads `insertDebugLog` from `../db` on first call, cached thereafter. Called only when `level === 'debug'`.

Structured `data` payloads containing `sessionId` / `agentId` fields are mapped to the `session_id` / `agent_id` columns automatically.

```ts
function tryLogToDebug(message: string, data?: unknown): void {
  // lazy load insertDebugLog from db to avoid circular dep
  // extract session_id / agent_id from data if present
  // call insertDebugLog({ id: randomUUID(), source, message, data: JSON.stringify(data), session_id, agent_id })
}
```

No changes needed at call sites — every existing `logger.debug()` call is captured automatically.

### API (`src/dashboard/routes.ts`)

**New endpoint:**

```
GET /api/logs/debug
  ?limit=500       (default 500, max 1000)
  &source=         (partial match on source column)
  &session_id=     (exact match)
  &agent_id=       (exact match)
```

Returns `DebugLogRow[]` newest-first. Token-protected like all `/api/*` routes.

**SSE stream (`/api/logs/stream`):**

The `logEvents` emitter in `logger.ts` already fires on every log call. The stream handler adds a listener for `debug`-level entries and emits them as:

```json
{ "type": "debug", "line": { "t": "...", "lvl": "DEBUG", "src": "...", "msg": "...", "session_id": "...", "agent_id": "..." } }
```

Existing `line` events (INFO/WARN/ERROR) are unchanged.

### Logs Page (`src/dashboard/v2/src/page-logs.jsx`)

**Behavior change for the DEBUG filter tab only:**

1. On mount (or when filter switches to `DEBUG`): fetch `GET /api/logs/debug?limit=500`, replace display buffer with results.
2. SSE handler: when `ev.type === 'debug'` and the current filter is `DEBUG`, append to display (same 300-line rolling cap as `line` events).
3. When filter switches away from `DEBUG`: revert to the existing file-tail buffer, no re-fetch needed.

All other filter tabs (`ALL`, `INFO`, `WARN`, `ERROR`, `TRACE`, `ARCHIVIST`) remain unchanged — they continue operating against the file tail buffer.

The existing grid layout and `colorOf()` logic are unchanged. `agent-thought` and `tool-result` sources keep their violet color.

---

## Data Flow

```
logger.debug(msg, { sessionId, agentId, ... })
  └─ log() writes to file + emits logEvents('line', ...)
  └─ tryLogToDebug() → insertDebugLog() → debug_logs table
                                          cleanup: purge >24h old rows (every 5min)

/api/logs/stream (SSE)
  └─ listens on logEvents for debug entries
  └─ emits { type: 'debug', line: { ...+session_id, agent_id } }

Logs page (DEBUG filter active)
  └─ initial load: GET /api/logs/debug?limit=500
  └─ live: SSE 'debug' events appended to display
```

---

## Files Changed

| File | Change |
|---|---|
| `src/db.ts` | Add `debug_logs` table migration, `insertDebugLog()`, `getDebugLogs()`, `DebugLogRow` type |
| `src/utils/logger.ts` | Add `tryLogToDebug()`, call it from `log()` when `level === 'debug'` |
| `src/system/cleanup.ts` | Add `purgeOldDebugLogs()` to cleanup scheduler |
| `src/dashboard/routes.ts` | Add `GET /api/logs/debug` endpoint; add `debug` event type to SSE stream |
| `src/dashboard/v2/src/page-logs.jsx` | Fetch from DB + consume SSE `debug` events when DEBUG filter is active |

---

## Error Handling

- `insertDebugLog` and `getDebugLogs` are wrapped in try/catch — DB failures never crash the logger or request handler.
- `tryLogToDebug` guards against circular dependency the same way `tryLogToAnalytics` does.
- If `debug_logs` table doesn't exist yet (before migration runs), all debug DB calls fail silently.

## Open Questions

None — all decisions resolved in design session.
