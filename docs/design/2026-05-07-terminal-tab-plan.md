# Terminal Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Terminal page to the NeuroClaw dashboard with tabbed agent sessions backed by WebSockets, plus a note-only CLI client scaffold.

**Architecture:** A `WebSocketServer` (from the `ws` package) is attached to the existing Hono HTTP server by listening to the Node `upgrade` event. The browser terminal page opens one WS connection per tab; each connection maps to an agent and calls `chatStream()` / `orchestrateMultiAgent()` on every user message, streaming events back over the same socket. The frontend renders a monospace `<div>`-based terminal (no xterm.js) styled to match the dashboard aesthetic.

**Tech Stack:** `ws` (Node.js WebSocket server), React hooks, existing `chatStream` / `orchestrateMultiAgent` from `src/agent/alfred.ts`, Hono + `@hono/node-server`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/dashboard/terminal-ws.ts` | **Create** | WS server attachment, auth, per-connection agent chat loop |
| `src/dashboard/server.ts` | **Modify** | Import + attach terminal WS handler after HTTP server starts |
| `src/dashboard/v2/src/page-terminal.jsx` | **Create** | `Terminal`, `TerminalTab`, `TerminalMessage`, `AgentPickerModal` |
| `src/dashboard/v2/src/data.jsx` | **Modify** | Add `terminal` nav entry under CORE group |
| `src/dashboard/v2/src/app.jsx` | **Modify** | Register `terminal` in PAGES |
| `src/dashboard/v2/src/icons.jsx` | **No change** | `terminal` icon already exists at line 46 |

---

## Task 1: Install ws package

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install ws and its types**

```bash
cd /home/neuroclaw-v1
npm install ws
npm install --save-dev @types/ws
```

- [ ] **Step 2: Verify TypeScript is still happy**

```bash
npx tsc --noEmit
```

Expected: no errors (ws types are now available).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws for terminal WebSocket server"
```

---

## Task 2: Backend — `src/dashboard/terminal-ws.ts`

**Files:**
- Create: `src/dashboard/terminal-ws.ts`

- [ ] **Step 1: Create the file**

Create `src/dashboard/terminal-ws.ts` with this complete content:

```typescript
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Server } from 'http';
import { config } from '../config';
import { getAgentById, getAllAgents, createSession } from '../db';
import { chatStream, orchestrateMultiAgent, type MetaEvent } from '../agent/alfred';
import { logger } from '../utils/logger';

type ClientMsg =
  | { type: 'message'; content: string }
  | { type: 'ping' };

type ServerMsg =
  | { type: 'session';  sessionId: string }
  | { type: 'agent';    agentId: string; agentName: string }
  | { type: 'route';    from: string; to: string }
  | { type: 'tool';     label: string }
  | { type: 'chunk';    content: string }
  | { type: 'done' }
  | { type: 'error';    message: string }
  | { type: 'pong' };

function safeSend(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function extractToken(reqUrl: string, cookieHeader: string): string {
  try {
    const url = new URL(reqUrl, 'http://x');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch { /* bad URL, fall through */ }
  return /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookieHeader)?.[1] ?? '';
}

export function attachTerminalWs(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return;
    }
    if (pathname !== '/api/terminal') return;

    const cookie = req.headers.cookie ?? '';
    const token  = extractToken(req.url ?? '', cookie);
    if (token !== config.dashboard.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket, req: import('http').IncomingMessage) => {
    let agentParam: string | undefined;
    let sessionParam: string | undefined;
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      agentParam   = url.searchParams.get('agent')   ?? undefined;
      sessionParam = url.searchParams.get('session') ?? undefined;
    } catch { /* use defaults */ }

    // Look up agent by id, fall back to Alfred
    const agent = (agentParam ? getAgentById(agentParam) : null)
      ?? getAllAgents().find(a => a.name === 'Alfred' && a.status === 'active')
      ?? getAllAgents().find(a => a.status === 'active');

    if (!agent) {
      safeSend(ws, { type: 'error', message: 'no active agent found' });
      ws.close();
      return;
    }

    const sessionId = sessionParam ?? createSession(agent.id, 'Terminal');
    safeSend(ws, { type: 'session',  sessionId });
    safeSend(ws, { type: 'agent', agentId: agent.id, agentName: agent.name });

    ws.on('message', async (data: Buffer) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(data.toString()) as ClientMsg; } catch { return; }

      if (msg.type === 'ping') { safeSend(ws, { type: 'pong' }); return; }
      if (msg.type !== 'message' || !msg.content?.trim()) return;

      const onMeta = (e: MetaEvent): void => {
        if      (e.type === 'route')         safeSend(ws, { type: 'route', from: e.event.from, to: e.event.to });
        else if (e.type === 'mcp_call_start') safeSend(ws, { type: 'tool',  label: `${e.tool}...` });
        else if (e.type === 'spawn')          safeSend(ws, { type: 'tool',  label: `spawning ${e.event.agentName}...` });
      };

      const onChunk = async (chunk: string): Promise<void> => {
        safeSend(ws, { type: 'chunk', content: chunk });
      };

      try {
        if (agent.name === 'Alfred') {
          await orchestrateMultiAgent(msg.content, sessionId, onChunk, agent.id, onMeta, 'terminal');
        } else {
          await chatStream(msg.content, sessionId, onChunk, agent.system_prompt ?? '', agent.id, onMeta);
        }
        safeSend(ws, { type: 'done' });
      } catch (err) {
        safeSend(ws, { type: 'error', message: (err as Error).message });
      }
    });

    ws.on('error', (err) => logger.warn('terminal ws error', { err: err.message }));
  });

  logger.info('Terminal WebSocket handler attached at /api/terminal');
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no new errors. If you see `Cannot find module 'ws'`, confirm Step 1 of Task 1 ran.

---

## Task 3: Wire WS into server.ts

**Files:**
- Modify: `src/dashboard/server.ts`

- [ ] **Step 1: Add import at the top of server.ts**

After the last existing import (around line 27), add:

```typescript
import { attachTerminalWs } from './terminal-ws';
```

- [ ] **Step 2: Capture the http.Server returned by serve()**

Find this line (around line 270):

```typescript
serve({ fetch: app.fetch, port: config.dashboard.port, hostname: '127.0.0.1' }, (info) => {
```

Change it to:

```typescript
const httpServer = serve({ fetch: app.fetch, port: config.dashboard.port, hostname: '127.0.0.1' }, (info) => {
```

- [ ] **Step 3: Attach terminal WS inside the serve callback**

Inside the callback, right after the `logger.info('Dashboard →...')` line, add:

```typescript
  attachTerminalWs(httpServer);
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Quick smoke test**

```bash
npm run dashboard &
sleep 3
# Test WS auth rejects bad token
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "http://localhost:3141/api/terminal?agent=x&token=wrong" 2>&1 | head -5
```

Expected: `HTTP/1.1 101` is NOT in the output (you get 401).

```bash
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/terminal-ws.ts src/dashboard/server.ts
git commit -m "feat: add WebSocket terminal endpoint at /api/terminal"
```

---

## Task 4: Frontend — `src/dashboard/v2/src/page-terminal.jsx`

**Files:**
- Create: `src/dashboard/v2/src/page-terminal.jsx`

- [ ] **Step 1: Create the file with all four components**

Create `src/dashboard/v2/src/page-terminal.jsx` with this complete content:

```jsx
/* Terminal page — WebSocket-backed agent REPL with tabbed sessions */

const makeTabId = () => Math.random().toString(36).slice(2, 8);

// ── TerminalMessage ───────────────────────────────────────────────────────────

const TerminalMessage = ({ msg, agentName }) => {
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 10 }}>
        <span style={{ color: 'var(--neon-2)', flexShrink: 0 }}>you</span>
        <span className="muted" style={{ fontSize: 10 }}>{msg.time} ›</span>
        <span style={{ color: 'var(--text)' }}>{msg.content}</span>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 4, marginBottom: 6 }}>
      <div>
        <span style={{ color: 'var(--violet)' }}>{agentName.toLowerCase()}</span>
        <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>{msg.time}</span>
        {msg.routeTo && (
          <span className="muted" style={{ fontSize: 10 }}> → {msg.routeTo.toLowerCase()}</span>
        )}
      </div>
      {(msg.toolCalls || []).map((label, i) => (
        <div key={i} style={{ paddingLeft: 12, color: 'var(--muted)', fontSize: 11, lineHeight: 1.7 }}>
          <span style={{ opacity: 0.5, marginRight: 4 }}>⟳</span>{label}
        </div>
      ))}
      {!msg.content && !msg.done && (msg.toolCalls || []).length === 0 && (
        <div style={{ paddingLeft: 12, color: 'var(--muted)', fontSize: 11 }}>
          <span style={{ marginRight: 4 }}>⟳</span>thinking...
        </div>
      )}
      {msg.content && (
        <div style={{ paddingLeft: 12, color: msg.error ? 'var(--danger)' : 'var(--text-soft)', lineHeight: 1.6, marginTop: 3, whiteSpace: 'pre-wrap' }}>
          {msg.error ? `✕ ${msg.error}` : msg.content}
          {!msg.done && !msg.error && <span className="blink neonc" style={{ marginLeft: 4 }}>▌</span>}
        </div>
      )}
    </div>
  );
};

// ── TerminalTab ───────────────────────────────────────────────────────────────

const TerminalTab = ({ tabId, agentId, agentName, active, onWsStateChange }) => {
  const [messages,   setMessages]   = React.useState([]);
  const [draft,      setDraft]      = React.useState('');
  const [history,    setHistory]    = React.useState([]);
  const [historyIdx, setHistoryIdx] = React.useState(-1);
  const [wsState,    setWsState]    = React.useState('connecting');
  const [sessionId,  setSessionId]  = React.useState(null);
  const wsRef     = React.useRef(null);
  const scrollRef = React.useRef(null);

  const setWs = (state) => {
    setWsState(state);
    onWsStateChange(state);
  };

  // Open (and auto-reconnect) the WebSocket when the tab mounts
  React.useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url   = `${proto}://${location.host}/api/terminal?agent=${agentId}`;
    let destroyed = false;
    let retryDelay = 1000;
    let ws;

    const connect = () => {
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setWs('open');
        retryDelay = 1000;
      };

      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'session') {
          setSessionId(msg.sessionId);
          return;
        }
        if (msg.type === 'pong' || msg.type === 'agent') return;

        if (msg.type === 'route') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent' || last.done) return prev;
            return [...prev.slice(0, -1), { ...last, routeTo: msg.to }];
          });
          return;
        }
        if (msg.type === 'tool') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent' || last.done) return prev;
            return [...prev.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls || []), msg.label] }];
          });
          return;
        }
        if (msg.type === 'chunk') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent' || last.done) return prev;
            return [...prev.slice(0, -1), { ...last, content: (last.content || '') + msg.content }];
          });
          return;
        }
        if (msg.type === 'done') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent') return prev;
            return [...prev.slice(0, -1), { ...last, done: true }];
          });
          return;
        }
        if (msg.type === 'error') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'agent') return prev;
            return [...prev.slice(0, -1), { ...last, error: msg.message, done: true }];
          });
        }
      };

      ws.onclose = () => {
        if (destroyed) return;
        setWs('reconnecting');
        setTimeout(() => {
          if (!destroyed) { retryDelay = Math.min(retryDelay * 2, 8000); connect(); }
        }, retryDelay);
      };

      ws.onerror = () => setWs('error');
    };

    connect();
    return () => {
      destroyed = true;
      ws?.close();
      wsRef.current = null;
    };
  }, [agentId]);

  // Auto-scroll when new messages arrive (only if this tab is active)
  React.useEffect(() => {
    if (active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, active]);

  const sendMessage = () => {
    const content = draft.trim();
    if (!content || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'message', content }));
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    setMessages(prev => [
      ...prev,
      { id: makeTabId(), role: 'user',  content, time },
      { id: makeTabId(), role: 'agent', content: '', toolCalls: [], routeTo: null, done: false, error: null, time },
    ]);
    setHistory(h => [content, ...h].slice(0, 100));
    setHistoryIdx(-1);
    setDraft('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(next);
      if (history[next] !== undefined) setDraft(history[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.max(historyIdx - 1, -1);
      setHistoryIdx(next);
      setDraft(next === -1 ? '' : (history[next] ?? ''));
    }
  };

  const waiting = messages.length > 0
    && messages[messages.length - 1].role === 'agent'
    && !messages[messages.length - 1].done;

  const dotColor = wsState === 'open' ? 'var(--neon-2)' : wsState === 'connecting' || wsState === 'reconnecting' ? 'var(--amber)' : 'var(--muted)';
  const placeholder = waiting ? 'waiting...' : wsState !== 'open' ? `${wsState}...` : `message ${agentName.toLowerCase()}...`;

  return (
    <div style={{ display: active ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Session header */}
      <div style={{ padding: '6px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0, display: 'inline-block' }} />
        <span className="mono muted" style={{ fontSize: 10 }}>
          {sessionId ? `session ${sessionId.slice(0, 8)}` : 'connecting...'}
        </span>
      </div>

      {/* Message area */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: 12, display: 'flex', flexDirection: 'column' }}>
        <div className="muted" style={{ fontSize: 10, marginBottom: 10, letterSpacing: '0.08em' }}>
          // NEUROCLAW TERMINAL · {agentName.toLowerCase()}
        </div>
        {messages.map(msg => (
          <TerminalMessage key={msg.id} msg={msg} agentName={agentName} />
        ))}
        {messages.length === 0 && wsState === 'open' && (
          <div className="muted" style={{ fontSize: 11 }}>
            Connected to {agentName}. Type a message below, or try <span style={{ color: 'var(--neon)' }}>@AgentName</span> to delegate.
          </div>
        )}
      </div>

      {/* Input bar */}
      <div style={{ borderTop: '1px solid var(--line)', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(0,8,20,0.6)', flexShrink: 0 }}>
        <span style={{ color: 'var(--neon)', fontSize: 14 }}>›</span>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={waiting || wsState !== 'open'}
          placeholder={placeholder}
          style={{ flex: 1, background: 'transparent', border: 0, outline: 0, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12 }}
          autoFocus={active}
        />
        <span className="mono muted hide-mobile" style={{ fontSize: 10 }}>↑↓ history · ↵ send</span>
      </div>
    </div>
  );
};

// ── AgentPickerModal ──────────────────────────────────────────────────────────

const AgentPickerModal = ({ onPick, onClose }) => {
  const agents = (window.NC_DATA.AGENTS || []).filter(a => a.status === 'active' || a.status === 'live');
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="nc-panel glow" onClick={e => e.stopPropagation()} style={{ width: 400 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)' }}>
          <div className="label-tiny neonc">NEW TERMINAL TAB · SELECT AGENT</div>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {agents.length === 0 && (
            <div className="mono muted" style={{ padding: '18px 16px', fontSize: 11 }}>// no active agents</div>
          )}
          {agents.map(a => (
            <div key={a.id}
              onClick={() => { onPick(a); onClose(); }}
              className="mono"
              style={{ padding: '10px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px dashed rgba(0,183,255,0.06)', fontSize: 12 }}
              onMouseOver={e => e.currentTarget.style.background = 'rgba(0,183,255,0.08)'}
              onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
              <span className="dot cyan pulse" />
              <span style={{ flex: 1 }}>{a.name}</span>
              <span className="muted" style={{ fontSize: 10 }}>{a.role || 'agent'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── Terminal (page root) ──────────────────────────────────────────────────────

const Terminal = () => {
  const [tabs, setTabs] = React.useState(() => {
    const agents = window.NC_DATA.AGENTS || [];
    const alfred = agents.find(a => a.name === 'Alfred' && (a.status === 'active' || a.status === 'live'))
      ?? agents.find(a => a.status === 'active' || a.status === 'live');
    return alfred ? [{ id: makeTabId(), agentId: alfred.id, agentName: alfred.name }] : [];
  });
  const [activeTabId, setActiveTabId] = React.useState(() => tabs[0]?.id ?? null);
  const [pickerOpen,  setPickerOpen]  = React.useState(false);
  const [wsStates,    setWsStates]    = React.useState({});

  const addTab = (agent) => {
    const tab = { id: makeTabId(), agentId: agent.id, agentName: agent.name };
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
  };

  const closeTab = (tabId, e) => {
    e.stopPropagation();
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId && next.length > 0) {
        setActiveTabId(next[next.length - 1].id);
      }
      return next;
    });
    setWsStates(prev => { const s = { ...prev }; delete s[tabId]; return s; });
  };

  const dotColor = (tabId) => {
    const s = wsStates[tabId] ?? 'connecting';
    return s === 'open' ? 'var(--neon-2)' : (s === 'connecting' || s === 'reconnecting') ? 'var(--amber)' : 'var(--muted)';
  };

  return (
    <>
      <PageHeader
        title="Terminal"
        subtitle="WebSocket agent REPL — one tab per agent session"
      />
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)', background: '#020617', borderRadius: 4, border: '1px solid var(--line)', overflow: 'hidden' }}>

        {/* Tab bar */}
        <div style={{ background: '#060f1e', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'stretch', flexShrink: 0, overflowX: 'auto' }}>
          {tabs.map(tab => (
            <div key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              style={{
                padding: '8px 14px',
                borderBottom: `2px solid ${activeTabId === tab.id ? 'var(--neon)' : 'transparent'}`,
                color: activeTabId === tab.id ? 'var(--text)' : 'var(--muted)',
                fontFamily: 'var(--mono)', fontSize: 11,
                display: 'flex', alignItems: 'center', gap: 6,
                cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
              }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor(tab.id), display: 'inline-block', flexShrink: 0 }} />
              {tab.agentName.toLowerCase()}
              {tabs.length > 1 && (
                <span onClick={e => closeTab(tab.id, e)}
                  style={{ marginLeft: 4, opacity: 0.4, cursor: 'pointer', fontSize: 10, lineHeight: 1 }}>×</span>
              )}
            </div>
          ))}
          <div onClick={() => setPickerOpen(true)}
            style={{ padding: '8px 12px', color: 'var(--neon)', fontFamily: 'var(--mono)', fontSize: 11, display: 'flex', alignItems: 'center', cursor: 'pointer', borderBottom: '2px solid transparent' }}>
            + new
          </div>
          <div style={{ marginLeft: 'auto', padding: '0 12px', display: 'flex', alignItems: 'center' }}>
            <span className="mono muted hide-mobile" style={{ fontSize: 10 }}>⌘K cmd</span>
          </div>
        </div>

        {/* Tab panels — all mounted; inactive ones are hidden via display:none */}
        {tabs.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="mono muted" style={{ fontSize: 12, textAlign: 'center' }}>
              <div>// no tabs open</div>
              <button className="nc-btn" style={{ marginTop: 12 }} onClick={() => setPickerOpen(true)}>
                + new tab
              </button>
            </div>
          </div>
        ) : (
          tabs.map(tab => (
            <TerminalTab
              key={tab.id}
              tabId={tab.id}
              agentId={tab.agentId}
              agentName={tab.agentName}
              active={activeTabId === tab.id}
              onWsStateChange={(state) => setWsStates(prev => ({ ...prev, [tab.id]: state }))}
            />
          ))
        )}
      </div>

      {pickerOpen && <AgentPickerModal onPick={addTab} onClose={() => setPickerOpen(false)} />}
    </>
  );
};
```

- [ ] **Step 2: No tsc check needed** — JSX files are not type-checked by the project's tsconfig. Move directly to Task 5.

---

## Task 5: Register terminal in nav and app

**Files:**
- Modify: `src/dashboard/v2/src/data.jsx`
- Modify: `src/dashboard/v2/src/app.jsx`

- [ ] **Step 1: Add terminal to NAV in data.jsx**

In `src/dashboard/v2/src/data.jsx`, find the CORE group (line 3). Add the `terminal` entry after `sessions`:

Find:
```javascript
    { id: 'sessions', label: 'Sessions', icon: 'sessions' },
  ]},
  { group: 'MEMORY', items: [
```

Replace with:
```javascript
    { id: 'sessions', label: 'Sessions', icon: 'sessions' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  ]},
  { group: 'MEMORY', items: [
```

- [ ] **Step 2: Register Terminal page in app.jsx**

In `src/dashboard/v2/src/app.jsx`, find the PAGES object (line 29). Add `terminal` after `sessions`:

Find:
```javascript
  sessions: { label: 'Sessions', cmp: () => <Sessions/> },
```

Replace with:
```javascript
  sessions: { label: 'Sessions', cmp: () => <Sessions/> },
  terminal: { label: 'Terminal', cmp: () => <Terminal/> },
```

- [ ] **Step 3: Add page-terminal.jsx to NeuroClaw.html**

In `src/dashboard/v2/NeuroClaw.html`, find this line (around line 1302):

```html
<script type="text/babel" src="src/page-sessions.jsx"></script>
```

Add the terminal script tag immediately after it:

```html
<script type="text/babel" src="src/page-sessions.jsx"></script>
<script type="text/babel" src="src/page-terminal.jsx"></script>
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors (no TypeScript files were changed in this task).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/v2/src/page-terminal.jsx \
        src/dashboard/v2/src/data.jsx \
        src/dashboard/v2/src/app.jsx \
        src/dashboard/v2/NeuroClaw.html
git commit -m "feat: add Terminal page with tabbed WebSocket agent sessions"
```

---

## Task 6: Manual smoke test

- [ ] **Step 1: Start the dashboard**

```bash
npm run dashboard
```

- [ ] **Step 2: Open the Terminal page**

Visit `http://localhost:3141/dashboard?token=<your-token>` and click **Terminal** in the sidebar. Verify:
- Page renders with a tab bar showing "alfred"
- The dot turns green (WS connected)
- Session id appears in the header strip

- [ ] **Step 3: Send a message**

Type `what agents are active?` and press Enter. Verify:
- User message appears immediately with timestamp
- Agent name + tool call lines stream in
- Response chunks appear incrementally
- Cursor `▌` disappears when done

- [ ] **Step 4: Open a second tab**

Click `+ new`, pick Coder. Verify:
- Second tab appears in the tab bar
- Switching tabs preserves each tab's message history
- Both WS connections stay open (both dots green)

- [ ] **Step 5: Commit final**

```bash
git add -p  # nothing new to stage unless you made fixes
git commit -m "feat: terminal tab smoke tested and working" --allow-empty
```

---

## Stretch Goal — CLI Client (not implemented here)

The spec at `docs/design/2026-05-07-terminal-tab-design.md` describes a standalone CLI client at `src/cli/terminal-client.ts`. When ready to implement, it should:

1. Accept `--host`, `--token`, `--agent` flags
2. Open `ws://<host>/api/terminal?token=<token>&agent=<agentId>` via the `ws` package (already installed)
3. Read stdin line by line via `readline`, send `{ type: 'message', content }` frames
4. Print `chunk` events to stdout; print `tool` events as dim lines; print `route` events as `agent → agent` headers
5. Exit cleanly on `done` if `--once` flag is passed, otherwise loop

Add as an npm script: `"terminal": "tsx src/cli/terminal-client.ts"` in package.json.
