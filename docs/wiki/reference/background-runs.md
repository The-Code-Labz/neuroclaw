---
title: Background Run Persistence (v3.3)
order: 25
---

# Background Run Persistence

## Overview

The background run persistence system ensures that when an agent has a lot to do and the SSE stream drops, the user never loses the response. Instead of detaching and hoping the client reconnects, the system maintains a **permanent firehose** that any client can subscribe to at any time, receiving live chunks, heartbeat updates, tool activity, and the final terminal event until the run completes.

This is how ChatGPT, Claude, and OpenClaw handle long-running agents: the work continues in the background, the client reconnects transparently, and the response streams in as if nothing happened.

## Problem Solved

The legacy v3.2 `detachOnDisconnect` system worked like this:

1. Client disconnects → run flips to `detached` in the database
2. Agent loop continues → writes chunks to `partial_output`
3. Client reconnects → `/api/chat/resume/:sessionId` replays `partial_output` and subscribes to `agentBus`

**Failure mode:** If the resume SSE *also* dropped (long tool calls, proxy timeouts, flaky networks), the client had no recovery path. The agent was still running but the user had to refresh and might never see the result.

## Three-Layer Recovery

v3.3 adds a third layer that makes recovery robust:

| Layer | Endpoint | When It Triggers |
|-------|----------|------------------|
| **Primary SSE** | `POST /api/chat` | Every normal chat turn |
| **Resume** | `GET /api/chat/resume/:sessionId` | Primary `fetch` errors or drops |
| **Background Watch** (new) | `GET /api/runs/watch/:sessionId` | Resume returns 404 or itself drops |

The background watcher is a **permanent** `EventSource` that auto-reconnects with exponential backoff (1.2s → 10s) and forwards every live event from the process-wide `agentBus`.

## Architecture

```
┌─────────────┐     SSE      ┌──────────────────┐
│   Client    │◄─────────────│  POST /api/chat  │
└─────────────┘              └──────────────────┘
       │                              │
       │ disconnect                     │
       │                              │
       ▼                              ▼
┌─────────────┐              ┌──────────────────┐
│   Client    │◄─────────────│ GET /api/chat/   │
│  (resume)   │  1-shot SSE  │ resume/:sid      │
└─────────────┘              └──────────────────┘
       │                              │
       │ resume also drops            │
       │                              │
       ▼                              ▼
┌─────────────┐              ┌──────────────────┐
│   Client    │◄─────────────│ GET /api/runs/    │
│   (watch)   │ permanent SSE│ watch/:sid         │
│             │  (reconnects)│  agentBus firehose │
└─────────────┘              └──────────────────┘
```

## New Endpoint: `/api/runs/watch/:sessionId`

```
GET /api/runs/watch/:sessionId
```

A **long-lived SSE stream** that forwards every `agentBus` event for the given session until the client disconnects.

### Events Streamed

| Event Type | Purpose |
|---|---|
| `chunk` | Streamed token from the agent |
| `heartbeat` | Periodic status: turn count, elapsed time, current activity |
| `tool_start` | A tool call has started (e.g. `search_memory`) |
| `tool_done` | A tool call has completed |
| `step_start` | Multi-agent orchestration: a step has started |
| `step_done` | Multi-agent orchestration: a step has finished |
| `run_terminal` | The run reached a terminal state (`done`/`error`/`stopped`/`dropped`) |
| `ping` | Silent keep-alive every 10s to keep proxies happy |

### Example: Open with EventSource

```javascript
const es = new EventSource(`/api/runs/watch/${sessionId}`);

es.onmessage = (ev) => {
  const evt = JSON.parse(ev.data);
  if (evt.type === 'chunk') appendToBubble(evt.content);
  if (evt.type === 'heartbeat') updateActivityLine(evt.currentActivity);
  if (evt.type === 'run_terminal') {
    freezeBubble();
    reloadHistory();
    es.close();
  }
};

es.onerror = () => {
  // Auto-reconnect handled by the browser; the server survives restarts.
};
```

## Backend Changes

### Chunk Broadcasting

In `src/dashboard/routes.ts`, the main `/api/chat` handler now **broadcasts every chunk to `agentBus`** before writing to SSE:

```typescript
const writeChunk = async (chunk: string) => {
  finalText += chunk;
  appendPartialOutput(runId, chunk);        // persist for resume
  agentBus.emitAgent({                     // broadcast for watchers
    type: 'chunk', sessionId, runId, content: chunk
  });
  if (!clientGone) {
    stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: chunk }) });
  }
};
```

This means disconnecting the primary SSE **no longer loses data** — the bus copy survives.

### Terminal Events on the Bus

`endRun()` in `src/db.ts` now emits `run_terminal` on `agentBus`:

```typescript
agentBus.emitAgent({
  type: 'run_terminal',
  sessionId: run.session_id,
  runId,
  status: finalStatus,
  partialOutput: run.partial_output,
  finalOutput: run.final_output,
});
```

When a background run finishes, every watcher immediately knows to freeze the bubble and reload history.

### Tool Events from the Agent Loop

Both OpenAI and Anthropic tool execution paths in `alfred.ts` now wrap each tool call:

```typescript
agentBus.emitAgent({ type: 'tool_start', sessionId, runId: activeRunId, tool: tc.function.name });
// ... tool executes ...
agentBus.emitAgent({ type: 'tool_done',   sessionId, runId: activeRunId, tool: tc.function.name });
```

The multi-agent orchestrator also broadcasts `step_start`/`step_done` for each parallel/sequential step.

## Frontend Changes

### Persistent Background Watcher (`startBackgroundWatch`)

Added to `src/dashboard/v2/src/page-chat.jsx`:

```javascript
const startBackgroundWatch = (sessionId, opts = {}) => {
  // Stops any previous watcher first
  stopWatch();

  let es = new EventSource(`/api/runs/watch/${sessionId}`);

  es.onmessage = (ev) => {
    const evt = JSON.parse(ev.data);
    if (evt.type === 'chunk') appendChunk(evt.content);
    if (evt.type === 'heartbeat') updateActivity(evt.currentActivity);
    if (evt.type === 'tool_start') pushActivityLog('tool · ' + evt.tool);
    if (evt.type === 'tool_done') markActivityDone('tool · ' + evt.tool);
    if (evt.type === 'run_terminal') {
      freezeBubble();
      reloadHistory();
      stopWatch();
    }
  };

  es.onerror = () => {
    es.close();
    setTimeout(connect, reconnectDelay);  // exponential backoff
  };
};
```

### Session Loading

When a session with a background run is opened:

- **Old:** Poll `/api/runs/:id` every 3s, back off to 10s (fragile, stale, racy)
- **New:** Start `EventSource('/api/runs/watch/' + sessionId)` → live events stream immediately

### Cleanup

- `stopWatch()` called when the user changes sessions
- `stopWatch()` called in `send()` finally block
- Prevents watcher leaks between turns

## Event Bus Schema

The `AgentEvent` union in `src/system/event-bus.ts` was expanded:

| Event | Fields | Emitter |
|---|---|---|
| `chunk` | `sessionId`, `runId`, `content` | `/api/chat` handler, every token |
| `heartbeat` | `sessionId`, `runId`, `agentId`, `turn`, `elapsedMs`, `currentActivity` | Per-turn heartbeat emitter |
| `tool_start` | `sessionId`, `runId`, `tool` | Alfred.ts (OpenAI + Anthropic paths) |
| `tool_done` | `sessionId`, `runId`, `tool` | Alfred.ts (OpenAI + Anthropic paths) |
| `step_start` | `sessionId`, `runId`, `stepIndex`, `task`, `agentName` | Alfred.ts orchestrator |
| `step_done` | `sessionId`, `runId`, `stepIndex`, `agentName` | Alfred.ts orchestrator |
| `run_terminal` | `sessionId`, `runId`, `status`, `partialOutput`, `finalOutput` | `endRun()` in db.ts |

## Configuration

No new environment variables are required. The system reuses existing infrastructure:

- `DASHBOARD_HEARTBEAT_INTERVAL_MS` — cadence of heartbeat events (default 10s)
- `AGENT_RUN_STALE_MS` — how long before a `detached` run is marked `dropped` (default 10min)

## Comparison with Other Platforms

| Platform | Approach |
|---|---|
| **ChatGPT** | Persistent SSE that auto-reconnects; chunks accumulate server-side |
| **Claude** | Same pattern — EventSource with transparent reconnects |
| **OpenClaw** | Same pattern — background run continues, client reconnects seamlessly |
| **NeuroClaw v3.2** | Detach + resume only; fragile if resume drops |
| **NeuroClaw v3.3** | Three-layer recovery: primary → resume → **permanent watcher** |

## Files Modified

- `src/system/event-bus.ts` — schema expansion
- `src/db.ts` — terminal bus emit
- `src/dashboard/routes.ts` — watch endpoint + chunk broadcast
- `src/agent/alfred.ts` — tool + step broadcasts
- `src/dashboard/v2/src/page-chat.jsx` — background watcher + recovery
- `src/dashboard/chat-mode.html` — terminal + heartbeat handling
