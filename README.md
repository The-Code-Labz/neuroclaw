# NeuroClaw v1

Multi-agent AI orchestration system with auto-delegation, temporary agent spawning, a Hive Mind event log, task management, and a local dashboard. Built on Node.js + TypeScript, backed by SQLite, powered by the VoidAI API (OpenAI-compatible).

---

## Features

- **Alfred** — orchestrator agent; classifies intent and routes to the best specialist
- **Agent Registry** — create, edit, and manage specialist sub-agents from the dashboard
- **Auto-Delegation** — LLM classifier picks the best agent per message (configurable confidence threshold)
- **`@mention` Routing** — prefix any message with `@AgentName` to force-route it
- **Temporary Agent Spawning** — agents can spawn short-lived sub-agents via tool call; TTL + idle timeout enforced
- **Hive Mind** — centralized event log for every routing decision, spawn, task, and lifecycle event
- **Task Management** — create tasks, auto-assign via classifier, advance status through the dashboard
- **Live Dashboard** — dark-mode web UI with SSE chat streaming, routing/spawn indicators, config hot-reload
- **SQLite Persistence** — sessions, messages, tasks, memories, audit logs, analytics, hive events
- **Hot-reload Config** — edit `.env` while running; detected and applied within 2 seconds

---

## Seeded Agents

| Agent | Role | Capabilities |
|---|---|---|
| **Alfred** | orchestrator | orchestrate, delegate, plan, respond |
| **Researcher** | specialist | research, summarize, fact-check |
| **Coder** | specialist | code, debug, refactor, review |
| **Planner** | specialist | plan, tasks, roadmap, prioritize |

All agents are seeded on first startup (idempotent). System prompts are always kept current — adding spawn guidance on each boot.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set VOIDAI_API_KEY and DASHBOARD_TOKEN

# 3a. CLI chat (Alfred, streaming)
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
| `VOIDAI_MODEL` | No | `gpt-5.1` | Default model for all agents |
| `DASHBOARD_PORT` | No | `3141` | Dashboard port |
| `DASHBOARD_TOKEN` | Yes | `change-me` | Auth token for all dashboard routes |
| `DB_PATH` | No | `./neuroclaw.db` | SQLite file path |
| `AUTO_DELEGATION_ENABLED` | No | `false` | Enable LLM-based auto-routing |
| `AUTO_DELEGATION_MIN_CONFIDENCE` | No | `0.65` | Minimum classifier confidence to route |
| `ROUTER_MODEL` | No | *(same as VOIDAI_MODEL)* | Override model for the classifier |
| `SPAWN_AGENTS_ENABLED` | No | `false` | Enable temporary agent spawning |
| `TEMP_AGENTS_AUTO_APPROVE` | No | `true` | Auto-approve all spawn requests |
| `TEMP_AGENT_TTL_HOURS` | No | `6` | Hours before a temp agent expires |
| `TEMP_AGENT_IDLE_TIMEOUT_MINUTES` | No | `30` | Idle timeout (reserved for future enforcement) |
| `TEMP_AGENT_SOFT_LIMIT` | No | `10` | Log a warning above this many active temp agents |
| `TEMP_AGENT_HARD_LIMIT` | No | `25` | Block spawn requests above this many active temp agents |

> **VoidAI quirk:** invalid API keys return HTTP 500, not 401.

---

## Dashboard

Runs at `http://localhost:3141` (localhost only). All routes require `?token=<DASHBOARD_TOKEN>` or `x-dashboard-token` header.

### Sections

| Section | Description |
|---|---|
| Overview | Status, model, active/temp agents, sessions, messages, uptime |
| Chat | SSE streaming chat; routing and spawn events shown inline |
| Agents | CRUD for all agents; temp agents highlighted with expiry time |
| Tasks | Create, auto-assign, and advance tasks through status pipeline |
| Sessions | Browse conversation history |
| Memory | View stored memories (importance-ranked) |
| Config | Live config table; secrets redacted |
| Analytics | Counts and event breakdown |
| Hive Mind | Full event log — routing decisions, spawns, task changes, lifecycle |
| Logs | Recent audit log entries |

### Chat Delegation

- **Dropdown**: select any agent to chat with directly
- **`@mention`**: prefix message with `@Researcher`, `@Coder`, or `@Planner` to force-route
- **Auto-routing**: when `AUTO_DELEGATION_ENABLED=true`, the classifier picks the best agent automatically
- Routing decisions appear as green indicators above the response bubble
- Spawn events appear as purple indicators

---

## Auto-Delegation

Routing priority (highest to lowest):

1. `@AgentName` prefix in the message — routes directly, strips the mention
2. LLM classifier (`AUTO_DELEGATION_ENABLED=true`) — picks best agent above confidence threshold
3. Explicit `agentId` from the dashboard dropdown
4. Alfred as final fallback

The classifier makes a separate (non-streaming) LLM call with a structured prompt. If JSON parsing fails or confidence is below `AUTO_DELEGATION_MIN_CONFIDENCE`, it falls back silently to Alfred. All decisions are logged to the Hive Mind.

---

## Temporary Agent Spawning

When `SPAWN_AGENTS_ENABLED=true`, agents that have the `spawn_agent` tool available can create short-lived sub-agents. Alfred and active non-temp agents can spawn; the depth limit is 3 (prevents infinite recursion).

### Lifecycle

```
Agent decides to spawn
  → spawnAgent() validates limits + parent
  → temp agent created in DB (temporary=1, expires_at set)
  → sub-agent runs its task (synchronous chatStream call)
  → result returned to parent
  → parent streams synthesized response
  → cleanup scheduler expires agent after TTL
```

### Limits

| Check | Value (default) |
|---|---|
| Max spawn depth | 3 |
| Soft limit | 10 active temp agents (logs warning) |
| Hard limit | 25 active temp agents (blocks spawn) |
| TTL | 6 hours |
| Cleanup interval | Every 5 minutes |

Expired agents are set to `inactive` and logged to both `audit_logs` and `hive_mind`.

---

## Hive Mind

Every significant system event is logged to the `hive_mind` table:

| Action | Trigger |
|---|---|
| `auto_route` | Classifier picks an agent |
| `route_fallback` | Classifier fails or confidence too low |
| `manual_delegation` | User uses `@mention` |
| `spawn_request` | Soft limit warning during spawn |
| `spawn_success` | Agent successfully spawned |
| `spawn_denied` | Spawn blocked (hard limit, depth, or disabled) |
| `agent_spawned` | DB record created |
| `agent_expired` | Temp agent TTL elapsed |
| `task_created` | Task created (with auto-assign info) |
| `task_updated` | Task status changed |
| `agent_activated` / `agent_deactivated` | Lifecycle events |

Query: `GET /api/hive?limit=100`

---

## API Reference

All endpoints require `?token=` or `x-dashboard-token`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/status` | Active agents, temp agents, session/message counts |
| `GET` | `/api/agents` | All agents (including temp) |
| `POST` | `/api/agents` | Create agent (`name` required) |
| `PATCH` | `/api/agents/:id` | Update agent fields |
| `DELETE` | `/api/agents/:id` | Soft-deactivate; Alfred protected |
| `POST` | `/api/agents/:id/activate` | Re-activate |
| `POST` | `/api/agents/spawn` | Manually spawn a temp agent |
| `GET` | `/api/tasks` | All tasks; filter `?status=` |
| `POST` | `/api/tasks` | Create task; auto-assigns if `AUTO_DELEGATION_ENABLED` |
| `PATCH` | `/api/tasks/:id` | Update status, agent, or fields |
| `GET` | `/api/hive` | Hive Mind events; `?limit=` |
| `POST` | `/api/chat` | SSE stream; `@mention` routing; emits `route`/`spawn` events |
| `GET` | `/api/config/watch` | SSE — fires on `.env` change |

### Chat SSE Event Types

```
{type: 'session',  sessionId}
{type: 'agent',    name, agentId}
{type: 'route',    from, to, confidence, reason, manual}
{type: 'spawn',    agentName, agentId}
{type: 'chunk',    content}
{type: 'done'}
{type: 'error',    message}
```

---

## Architecture

```
User message
  ├─ @mention? → resolveAgent() routes directly
  ├─ AUTO_DELEGATION_ENABLED? → classifyRoute() (LLM call, non-streaming)
  └─ fallback → Alfred

chatStream() [alfred.ts]
  ├─ Builds tools: spawn_agent (if SPAWN_AGENTS_ENABLED + depth < 3)
  ├─ Streaming LLM call
  ├─ finish_reason=tool_calls?
  │   ├─ executeTool(spawn_agent) → spawnAgent() → sub-agent chatStream()
  │   └─ Continue loop → LLM synthesizes result
  └─ Save messages to SQLite (agent_id on assistant turns)

Hive Mind [hive-mind.ts] — logHive() called from router, spawner, task-manager
Cleanup [cleanup.ts] — expires temp agents on startup + every 5 min
Config watcher [config-watcher.ts] — polls .env every 2s, resets OpenAI client
```

---

## Safety Rules

- Alfred cannot be deactivated or renamed
- Inactive agents cannot spawn
- Max spawn depth: 3 (prevents recursion)
- Hard limit: 25 concurrent temp agents
- Classifier JSON parse failure → silent fallback to Alfred
- All failures logged to `hive_mind` and `audit_logs`

---

## Planned Expansions

| Version | Feature |
|---|---|
| v1.3 | Memory system (Obsidian vault sync + auto-extractor) |
| v1.4 | Discord integration |
| v1.5 | LiveKit + ElevenLabs voice agents |
| v2 | Full NeuroClaw OS |
