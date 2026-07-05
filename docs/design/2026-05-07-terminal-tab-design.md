# Terminal Tab — Design Spec

**Date:** 2026-05-07  
**Status:** Approved  
**Scope:** Phase 1 — dashboard terminal tab + WebSocket backend. CLI client is a stretch goal.

---

## Goal

Add a Terminal page to the NeuroClaw dashboard that provides a Claude Code / Codex / Gemini CLI-style agent REPL experience — tabbed, keyboard-driven, accessible from any browser pointing at the dashboard URL. A standalone CLI client that connects to the same WebSocket endpoint is defined as a stretch goal.

---

## Architecture

One WebSocket endpoint is added to the existing Hono server on the same port (3141). No new process or port. Both the browser terminal tab and the stretch CLI client connect to this same endpoint.

```
Browser tab (monospace div)  ──WS──┐
                                    ├──► GET /api/terminal  ──► chatStream()  ──► LLM
CLI client (Node.js, stretch) ──WS──┘    (Hono WS upgrade)      (alfred.ts)
```

---

## Backend — WebSocket Endpoint

**Route:** `GET /api/terminal` (HTTP upgrade to WebSocket)  
**Auth:** `?token=<DASHBOARD_TOKEN>` query param — same token as all `/api/*` routes  
**Query params:**
- `agent` — agent id to connect to (defaults to Alfred's id)
- `session` — optional existing session id; if omitted a new UUID is generated

### Wire Protocol

All messages are JSON. The client sends:

```jsonc
{ "type": "message", "content": "summarize coder's task" }
{ "type": "ping" }
```

The server sends:

```jsonc
{ "type": "session",  "sessionId": "uuid" }
{ "type": "agent",    "agentId": "alfred", "agentName": "Alfred" }
{ "type": "route",    "from": "alfred", "to": "coder" }
{ "type": "tool",     "label": "reading task T-204..." }
{ "type": "chunk",    "content": "Coder is tracing a 429 spike..." }
{ "type": "done" }
{ "type": "error",    "message": "provider returned 500" }
{ "type": "pong" }
```

This mirrors the existing `/api/chat` SSE event shape. `chatStream()` in `alfred.ts` needs no changes — only a thin WS adapter is added that calls it and forwards emitted events over the socket.

**Reconnection:** The server sends `pong` in response to `ping`. The client uses exponential backoff (1s → 2s → 4s → 8s cap) on disconnect. The tab's WS status dot reflects connection state: green (connected), amber (reconnecting), red (failed).

---

## Frontend — `page-terminal.jsx`

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ ● alfred  s-1043 │ ● coder │ ○ researcher │ + new    ws●│  ← tab bar
├─────────────────────────────────────────────────────────┤
│                                                          │
│  // NEUROCLAW TERMINAL · alfred · session s-1043         │
│                                                          │
│  you  22:10 ›  what agents are active?                   │
│  alfred  22:10                                           │
│    5 agents active: Alfred (orchestrator), Coder…        │
│                                                          │
│  you  22:13 ›  summarize what coder is working on        │
│  alfred  22:13  → coder                                  │
│    ⟳ reading task T-204...                               │
│    ⟳ reading hive mind (last 10 events)...               │
│    Coder is tracing a 429 spike from 21:50…              │
│                                                          │
│  you  22:14 ›  ▌                                         │
│                                                          │
├─────────────────────────────────────────────────────────┤
│ ›  message alfred...                       ↑↓ history ↵ │  ← input bar
└─────────────────────────────────────────────────────────┘
```

### State

Each tab owns its own state slice:

```js
{
  agentId:    string,       // which agent this tab is connected to
  agentName:  string,
  sessionId:  string | null,
  messages:   Message[],    // rendered exchange history
  ws:         WebSocket,    // live connection, kept open when tab is backgrounded
  history:    string[],     // sent commands for ↑↓ recall
  historyIdx: number,
  draft:      string,
}
```

Tabs array lives at `TerminalPage` level. Switching tabs re-renders without closing WS connections.

### Components

| Component | Responsibility |
|---|---|
| `TerminalPage` | Owns tabs array, handles + new modal, renders tab bar |
| `TerminalTab` | Manages its own WS lifecycle, renders message list + input bar |
| `TerminalMessage` | Renders one user prompt + agent response (tool lines dimmed, chunks streamed in) |
| `AgentPickerModal` | Listed on `+ new` click; picks from active agents; creates new tab on confirm |

### Rendering

Phase 1 uses a scrollable `<div>` with monospace CSS — not xterm.js. This avoids a large dependency and keeps rendering consistent with the rest of the dashboard. xterm.js can be introduced later if real ANSI/PTY support is needed.

**Message rendering rules:**
- User prompt: `you  HH:MM ›  <content>` in neon-2 / text colors
- Agent header: `<agentName>  HH:MM` in violet; if delegated: `alfred  HH:MM  → coder`
- Tool call line: `⟳ <label>` in dim/muted color, indented
- Response chunks: streamed into the current message's response area, white text
- Error: red `✕ <message>`

### Interactions

| Trigger | Behaviour |
|---|---|
| Tab click | Switch active tab; WS stays open in background |
| `+ new` | Open `AgentPickerModal`; on confirm add tab, open WS |
| `↑` / `↓` in input | Walk `history[]` for that tab |
| `Enter` | Send `{ type: "message" }` frame; append user message immediately; await chunks |
| WS `chunk` event | Append to current streaming message |
| WS `tool` event | Append dimmed tool line to current message |
| WS `done` event | Finalise current message, re-enable input |
| WS `route` event | Update agent delegation label on current message |
| WS disconnect | Set tab dot to amber, begin backoff reconnect |

### Nav registration

- Add `terminal` entry to `NAV` in `data.jsx` under the `CORE` group, icon `terminal`
- Register in `PAGES` in `app.jsx`
- Add `Terminal` icon to `icons.jsx`

---

## Stretch — CLI Client (`src/cli/terminal-client.ts`)

A standalone Node.js script. Connects to the same WS endpoint. Reads stdin line by line, sends `{ type: "message" }` frames, prints server events to stdout with ANSI coloring:

- Agent name: magenta bold
- Tool call lines: dim
- Response chunks: white
- Errors: red

**Usage:**
```bash
node src/cli/terminal-client.ts --host http://localhost:3141 --token change-me --agent alfred
# or via npm script:
npm run terminal
```

Can point at any NeuroClaw server on any machine. No global install required.

---

## Out of Scope (Phase 1)

- Real xterm.js / PTY rendering
- Actual bash execution by the user (agents handle that via existing tools)
- Tab persistence across page reloads
- CLI client (stretch — defined above, not implemented in phase 1)
- Multi-user / shared terminal sessions
