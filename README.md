# NeuroClaw v1

Multi-agent AI system with a CLI chat interface, agent registry, task management, and a local dashboard. Built on Node.js + TypeScript, backed by SQLite, and powered by the VoidAI API (OpenAI-compatible).

---

## Features

- **Alfred** — orchestrator agent with a strategic AI butler persona
- **Agent Registry** — create, edit, and manage specialist sub-agents from the dashboard
- **Delegation** — route messages to a specific agent with `@AgentName` in any chat
- **Task Management** — create tasks, assign them to agents, and advance their status through the dashboard
- **Local Dashboard** — dark-mode web UI with live config watching, SSE chat streaming, and full observability
- **SQLite Persistence** — sessions, messages (with `agent_id`), tasks, memories, audit logs, and analytics events
- **Hot-reload Config** — edit `.env` while the server runs; changes are detected and applied within 2 seconds

---

## Seeded Agents

| Agent | Role | Capabilities |
|---|---|---|
| **Alfred** | orchestrator | orchestrate, delegate, plan, respond |
| **Researcher** | specialist | research, summarize, fact-check |
| **Coder** | specialist | code, debug, refactor, review |
| **Planner** | specialist | plan, tasks, roadmap, prioritize |

All agents are seeded automatically on first startup and are idempotent on subsequent starts.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set VOIDAI_API_KEY and DASHBOARD_TOKEN

# 3a. CLI chat (streaming conversation with Alfred)
npm run dev

# 3b. Dashboard (web UI on port 3141)
npm run dashboard
# Open: http://localhost:3141/dashboard?token=<your-token>
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VOIDAI_API_KEY` | Yes | — | API key for VoidAI |
| `VOIDAI_BASE_URL` | No | `https://api.voidai.app/v1` | OpenAI-compatible base URL |
| `VOIDAI_MODEL` | No | `gpt-5.1` | Model identifier |
| `DASHBOARD_PORT` | No | `3141` | Port the dashboard listens on |
| `DASHBOARD_TOKEN` | Yes | `change-me` | Token required for all dashboard routes |
| `DB_PATH` | No | `./neuroclaw.db` | SQLite database file path |

> **VoidAI quirk:** invalid API keys return HTTP 500, not 401. The error handler checks for this.

---

## Dashboard

The dashboard runs at `http://localhost:3141` (localhost only). All routes require `?token=<DASHBOARD_TOKEN>` or `x-dashboard-token` header.

### Sections

| Section | Description |
|---|---|
| Overview | System stats: active agents, sessions, messages, uptime |
| Chat | Live streaming chat; select any agent or use `@AgentName` to delegate |
| Agents | View, create, edit, deactivate, and re-activate agents |
| Tasks | Create tasks, assign to agents, advance status |
| Sessions | Browse conversation history |
| Memory | View stored memories (importance-ranked) |
| Config | Live view of `config_items` table; secrets redacted |
| Analytics | Message/session counts and event breakdown |
| Logs | Recent audit log entries |

### Agent Controls

From **Agents → New Agent**: fill in name, description, role, model, comma-separated capabilities, and a system prompt. Alfred cannot be renamed or deactivated. All other agents support full CRUD.

### Task Controls

From **Tasks → New Task**: set title, description, assigned agent, and priority (0–100). Use the status buttons in each row to move a task through `todo → doing → review → done`.

---

## Delegation

Any message prefixed with `@AgentName` is routed to that agent instead of the selected one:

```
@Researcher Summarise the latest developments in quantum error correction
@Coder Write a Python function to parse ISO 8601 timestamps
@Planner Break down launching a SaaS MVP into a 6-week roadmap
```

Each agent maintains a separate conversation history per session (`sessionId::agentId`), so switching agents within a session starts a fresh context.

The dashboard chat bubble labels update dynamically to show which agent is responding.

---

## API Reference

All endpoints require auth token (query param or header).

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/api/status` | Active agents, session/message counts, uptime |
| `GET` | `/api/agents` | All agents |
| `POST` | `/api/agents` | `{name, description?, system_prompt?, model?, role?, capabilities?}` |
| `PATCH` | `/api/agents/:id` | Any subset of agent fields; Alfred's name is locked |
| `DELETE` | `/api/agents/:id` | Soft-deactivates; Alfred is protected |
| `POST` | `/api/agents/:id/activate` | Re-activates an inactive agent |
| `GET` | `/api/tasks` | All tasks; filter with `?status=todo\|doing\|review\|done` |
| `POST` | `/api/tasks` | `{title, description?, agent_id?, priority?}` |
| `PATCH` | `/api/tasks/:id` | `{status?, agent_id?, title?, description?, priority?}` |
| `POST` | `/api/chat` | `{message, agentId?, sessionId?}` → SSE stream |
| `GET` | `/api/sessions` | Recent 50 sessions |
| `GET` | `/api/messages` | Messages; filter with `?session_id=` |
| `GET` | `/api/memory` | Memories sorted by importance |
| `GET` | `/api/config` | Config items (secrets redacted) |
| `GET` | `/api/analytics` | Message/session/token counts and events by type |
| `GET` | `/api/logs` | Recent 50 audit log entries |
| `GET` | `/api/config/watch` | SSE stream; fires `config_changed` when `.env` is edited |

### Chat SSE Event Types

```
{type: 'session',  sessionId}            — new or reused session ID
{type: 'agent',    name, agentId}        — resolved agent (after @mention routing)
{type: 'chunk',    content}              — token stream
{type: 'done'}                           — stream complete
{type: 'error',    message}              — error during streaming
```

---

## Architecture

```
CLI (src/index.ts)
  └─ messageQueue (FIFO — prevents concurrent streams)
       └─ alfred.chat() → chatStream() → VoidAI SSE → stdout + SQLite

Dashboard (src/dashboard/server.ts)  [Hono, localhost:3141]
  ├─ GET  /dashboard         → inline HTML (src/dashboard/html.ts)
  └─ /api/* (src/dashboard/routes.ts)
       ├─ POST /api/chat     → resolveAgent() → chatStream() → SSE to browser
       ├─ CRUD /api/agents   → agent registry
       ├─ CRUD /api/tasks    → task assignment
       └─ GET  /api/config/watch → SSE, fires on .env change

SQLite (src/db.ts)  [better-sqlite3, WAL mode]
  ├─ agents (orchestrators + specialists)
  ├─ sessions / messages (agent_id on messages)
  ├─ tasks (agent_id assignment)
  ├─ memories / audit_logs / analytics_events / config_items
  └─ runMigrations() — additive ALTER TABLE with try/catch

Config hot-reload (src/system/config-watcher.ts)
  └─ polls .env every 2s → dotenv.config() + resetClient() + SSE emit
```

---

## Planned Expansions

Integration hooks are marked with `// TODO` in the source:

- Discord.js bot replacing or alongside the CLI readline loop
- MCP server bridge for IDE tool integration
- LiveKit voice rooms with ElevenLabs streaming audio
- Two-pass Alfred auto-delegation (detect intent → re-route to sub-agent)
- Vector store memory (pgvector / Chroma / Pinecone) for semantic retrieval
- BullMQ + Redis for durable async task queue workers
- Obsidian memory vault sync via local REST plugin
- Sub-agent spawning based on message intent classification
