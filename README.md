# NeuroClaw v1

Multi-agent AI orchestration system with auto-delegation, agent-to-agent communication, temporary agent spawning, background task execution, persistent chat sessions, a Hive Mind event log, task management, memory system, and a local dashboard. Built on Node.js + TypeScript, backed by SQLite, powered by the VoidAI API (OpenAI-compatible).

---

## Features

- **Alfred** — orchestrator agent; classifies intent, routes to specialists, and communicates with agents directly via tools
- **Agent Registry** — create, edit, and manage specialist sub-agents from the dashboard
- **Auto-Delegation** — LLM classifier picks the best agent per message (configurable confidence threshold)
- **`@mention` Routing** — prefix any message with `@AgentName` to force-route it
- **Agent-to-Agent Communication** — agents can message each other and assign tasks to each other via `message_agent` and `assign_task_to_agent` LLM tools
- **Temporary Agent Spawning** — agents can spawn short-lived sub-agents via tool call; TTL + idle timeout enforced
- **Task Decomposition** — Alfred analyzes complexity and breaks multi-domain requests into sequential agent steps
- **Multi-Agent Orchestration** — executes decomposed steps across specialists, collects results, and merges into a unified response
- **Spawn Intelligence** — evaluates whether spawning is genuinely needed before creating a temp agent (benefit threshold)
- **Background Sub-Agent Execution** — sub-agents run in the background, allowing continued conversation with main agent
- **Auto-Deactivation** — temporary agents automatically deactivate when their task completes
- **Persistent Chat Sessions** — resume conversations across server restarts; rename and delete sessions
- **Memory System** — store and manage memories with types (general, fact, preference, context, summary) and importance levels
- **Hive Mind** — centralized event log for every routing decision, spawn, task, comms, and lifecycle event
- **Task Management** — create tasks, auto-assign via classifier, advance status through the dashboard
- **Analytics Dashboard** — comprehensive stats with message charts, top agents, event breakdown
- **Langfuse Integration** — full tracing for LLM calls, tool executions, and router decisions
- **Live Dashboard** — dark-mode web UI with SSE chat streaming, routing/spawn/comms indicators, config hot-reload
- **Hot-Reload Development** — `tsx --watch` auto-restarts on file changes
- **SQLite Persistence** — sessions, messages, tasks, memories, agent comms, audit logs, analytics, hive events
- **Hot-reload Config** — edit `.env` while running; detected and applied within 2 seconds

---

## Seeded Agents

| Agent | Role | Capabilities |
|---|---|---|
| **Alfred** | orchestrator | orchestrate, delegate, plan, respond |
| **Researcher** | specialist | research, summarize, fact-check |
| **Coder** | specialist | code, debug, refactor, review |
| **Planner** | specialist | plan, tasks, roadmap, prioritize |

All agents are seeded on first startup (idempotent). System prompts are always kept current — adding spawn and comms guidance on each boot.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set VOIDAI_API_KEY and DASHBOARD_TOKEN

# 3a. CLI chat (Alfred, streaming)
npm run dev:cli

# 3b. Dashboard with hot-reload (recommended for development)
npm run dashboard

# 3c. Dashboard one-shot (no watch)
npm run dashboard:once

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
| `LANGFUSE_SECRET_KEY` | No | — | Langfuse secret key (enables tracing when set with public key) |
| `LANGFUSE_PUBLIC_KEY` | No | — | Langfuse public key |
| `LANGFUSE_HOST` | No | `https://cloud.langfuse.com` | Custom Langfuse host URL |

> **VoidAI quirk:** invalid API keys return HTTP 500, not 401.

---

## Dashboard

Runs at `http://localhost:3141` (localhost only). All routes require `?token=<DASHBOARD_TOKEN>` or `x-dashboard-token` header.

### Sections

| Section | Description |
|---|---|
| Overview | Status, model, active/temp agents, sessions, messages, uptime |
| Chat | SSE streaming chat with session selector; routing, spawn, and comms events shown inline |
| Agents | CRUD for all agents; temp agents highlighted with expiry time; filter by status |
| Tasks | Create, auto-assign, and advance tasks through status pipeline |
| Sessions | Browse and manage conversation history |
| Memory | View, add, and delete memories with type and importance |
| Config | Live config table; secrets redacted |
| Analytics | Comprehensive stats: message charts, top agents, event breakdown, hive activity |
| Hive Mind | Full event log — routing decisions, spawns, task changes, comms, lifecycle |
| Comms | Inter-agent message log — from/to agent, message content, response, status |
| Logs | Recent audit log entries |

### Chat Features

- **Session Dropdown** — switch between existing sessions or start a new chat
- **Session Persistence** — conversations restored from database on page load
- **Rename/Delete** — manage sessions directly from the chat toolbar
- **Agent Selector** — pick any active agent to chat with
- **`@mention`** — prefix message with `@Researcher`, `@Coder`, or `@Planner` to force-route
- **Auto-routing** — when `AUTO_DELEGATION_ENABLED=true`, the classifier picks the best agent automatically
- **Background Tasks** — sub-agent results appear automatically when complete
- Routing decisions appear as green indicators above the response bubble
- Spawn events appear as purple indicators
- Agent-to-agent messages appear as amber indicators
- Task assignments appear as green indicators

### Memory Management

- **Add Memory** — create memories with content, type, and importance (1-10)
- **Memory Types** — general, fact, preference, context, summary
- **Delete** — remove memories from the table

### Analytics

- **Stats Cards** — messages (today/7d/all), sessions, active/temp agents, tasks, memories, tokens
- **Message Chart** — bar visualization of messages over last 14 days
- **Top Agents** — leaderboard with 🥇🥈🥉 medals
- **Event Types** — breakdown of tracked analytics events
- **Hive Activity** — last 24 hours of agent coordination events

---

## Auto-Delegation

Routing priority (highest to lowest):

1. `@AgentName` prefix in the message — routes directly, strips the mention
2. LLM classifier (`AUTO_DELEGATION_ENABLED=true`) — picks best agent above confidence threshold
3. Explicit `agentId` from the dashboard dropdown
4. Alfred as final fallback

The classifier makes a separate (non-streaming) LLM call with a structured prompt. If JSON parsing fails or confidence is below `AUTO_DELEGATION_MIN_CONFIDENCE`, it falls back silently to Alfred. All decisions are logged to the Hive Mind.

---

## Agent-to-Agent Communication

Every active agent has two communication tools available at all times (no feature flag required):

### `message_agent`

Sends a direct message to a named agent and returns their response synchronously. Alfred will call this automatically when asked to "ask", "check with", or "get a response from" another agent. The exchange is saved to the `agent_messages` table and visible in the **Comms** dashboard tab.

```
Alfred.message_agent({ to: "Researcher", message: "What's the latest on X?" })
  → Researcher chatStream() called in dedicated comms session
  → response returned to Alfred as tool result
  → saved to agent_messages with status: "responded"
```

### `assign_task_to_agent`

Creates a task in the `tasks` table assigned to a specific agent. With `execute_now: true`, the agent executes the task immediately and returns the result; without it, the task is queued for manual advancement.

```
Alfred.assign_task_to_agent({ to: "Coder", title: "...", description: "...", execute_now: true })
  → createTask() called with explicit agent_id
  → if execute_now: chatStream() for target agent, result returned
  → task record persisted for dashboard visibility
```

All inter-agent communication is logged to the Hive Mind as `agent_message_sent` or `agent_task_assigned`.

---

## Temporary Agent Spawning

When `SPAWN_AGENTS_ENABLED=true`, agents that have the `spawn_agent` tool available can create short-lived sub-agents. Alfred and active non-temp agents can spawn; the depth limit is 3 (prevents infinite recursion).

### Lifecycle

```
Agent decides to spawn
  → spawnAgent() validates limits + parent
  → temp agent created in DB (temporary=1, expires_at set)
  → sub-agent runs in background (async execution)
  → parent confirms spawn and stays available for conversation
  → sub-agent completes → result streamed to dashboard
  → temp agent auto-deactivated on completion
  → cleanup scheduler expires any remaining agents after TTL
```

### Background Execution

Sub-agents run in the background, allowing you to continue chatting with the main agent while work proceeds. Results appear automatically in the dashboard when complete. This is handled by the `background-tasks.ts` module using an in-memory task runner with EventEmitter.

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
| `agent_deactivated` | Temp agent auto-deactivated after task completion |
| `task_created` | Task created (with auto-assign info) |
| `task_updated` | Task status changed |
| `agent_activated` / `agent_deactivated` | Lifecycle events |
| `background_task_complete` | Sub-agent finished background task |
| `background_task_failed` | Sub-agent task failed |
| `agent_message_sent` | Agent sent a direct message to another agent |
| `agent_task_assigned` | Agent assigned a task to another agent |

Query: `GET /api/hive?limit=100`

---

## Langfuse Integration

When both `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` are set, full tracing is enabled:

| Event | What's Logged |
|---|---|
| **Chat Trace** | Session ID, user message, agent, final output |
| **LLM Generation** | Model, input messages, output, iteration count, token estimates |
| **Tool Calls** | Tool name, input args, output, duration |
| **Router** | Classification decision, confidence, reason, duration |

All traces include estimated token counts (rough ~4 chars/token approximation).

Set `LANGFUSE_HOST` to use a self-hosted Langfuse instance.

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
| `GET` | `/api/sessions` | All sessions with last message preview |
| `GET` | `/api/sessions/:id` | Single session details |
| `GET` | `/api/sessions/:id/messages` | All messages in a session |
| `PATCH` | `/api/sessions/:id` | Update session title |
| `DELETE` | `/api/sessions/:id` | Delete session and all messages |
| `GET` | `/api/tasks` | All tasks; filter `?status=` |
| `POST` | `/api/tasks` | Create task; auto-assigns if `AUTO_DELEGATION_ENABLED` |
| `PATCH` | `/api/tasks/:id` | Update status, agent, or fields |
| `GET` | `/api/memory` | All memories |
| `POST` | `/api/memory` | Create memory (`content`, `type`, `importance`) |
| `DELETE` | `/api/memory/:id` | Delete memory |
| `GET` | `/api/analytics` | Comprehensive stats and aggregates |
| `GET` | `/api/hive` | Hive Mind events; `?limit=` |
| `GET` | `/api/agent-messages` | Inter-agent communication log; `?limit=` |
| `POST` | `/api/chat` | SSE stream; `@mention` routing; emits `route`/`spawn`/`agent_message` events |
| `GET` | `/api/config/watch` | SSE — fires on `.env` change |
| `GET` | `/api/tasks/watch` | SSE — fires on background task completion |

### Chat SSE Event Types

```
{type: 'session',            sessionId}
{type: 'agent',              name, agentId}
{type: 'route',              from, to, confidence, reason, manual}
{type: 'spawn',              agentName, agentId}
{type: 'spawn_started',      taskId, agentName}
{type: 'spawn_chunk',        taskId, content}
{type: 'spawn_done',         taskId, result}
{type: 'spawn_eval',         task, shouldSpawn, benefit, reason}
{type: 'plan',               steps[]}
{type: 'step_start',         stepIndex, task, agentName}
{type: 'step_chunk',         stepIndex, agentName, content}
{type: 'step_done',          stepIndex, agentName}
{type: 'merge_start'}
{type: 'agent_message',      fromName, toName, preview}
{type: 'agent_task_assigned', fromName, toName, title, taskId, executing}
{type: 'chunk',              content}
{type: 'done'}
{type: 'error',              message}
```

---

## Development

### Hot-Reload

```bash
# Auto-restart on TypeScript file changes
npm run dashboard

# Without watch (one-shot)
npm run dashboard:once
```

The config watcher also detects `.env` changes every 2 seconds and hot-reloads without restart.

### Scripts

| Script | Description |
|---|---|
| `npm run dev` | CLI chat with hot-reload |
| `npm run dev:cli` | CLI chat (one-shot) |
| `npm run dashboard` | Dashboard with hot-reload |
| `npm run dashboard:once` | Dashboard (one-shot) |
| `npm run build` | TypeScript compile |
| `npm run start` | Production (from dist/) |

---

## Architecture

```
User message
  ├─ @mention? → resolveAgent() routes directly
  ├─ AUTO_DELEGATION_ENABLED? → classifyRoute() (LLM call, non-streaming)
  └─ fallback → Alfred

chatStream() [alfred.ts]
  ├─ Restores session history from DB if resuming
  ├─ Builds tools: message_agent + assign_task_to_agent (always)
  │               + spawn_agent (if SPAWN_AGENTS_ENABLED + depth < 3)
  ├─ Streaming LLM call (tracked in Langfuse)
  ├─ finish_reason=tool_calls?
  │   ├─ executeTool(message_agent) → chatStream(target) → save to agent_messages
  │   ├─ executeTool(assign_task_to_agent) → createTask() → optional chatStream(target)
  │   ├─ executeTool(spawn_agent) → evaluateSpawn() → spawnAgent() → background task
  │   ├─ Tool execution tracked in Langfuse
  │   └─ Continue loop → LLM synthesizes tool results
  └─ Save messages to SQLite (agent_id on assistant turns)

orchestrateMultiAgent() [alfred.ts]
  ├─ decomposeTask() — LLM decides if multi-agent needed
  ├─ Simple → chatStream(Alfred) with full tool set
  └─ Complex → sequential steps with context chaining → mergeResults()

Background Tasks [background-tasks.ts]
  ├─ In-memory Map + EventEmitter
  ├─ createBackgroundTask() → sub-agent chatStream() async
  ├─ completeBackgroundTask() → auto-deactivate temp agent
  └─ /api/tasks/watch SSE → dashboard receives results

Agent Comms [agent_messages table]
  ├─ message_agent tool → synchronous chatStream for target agent
  ├─ assign_task_to_agent tool → createTask() + optional execution
  └─ All exchanges persisted + visible in /api/agent-messages + Comms tab

Hive Mind [hive-mind.ts] — logHive() called from router, spawner, task-manager, comms
Cleanup [cleanup.ts] — expires temp agents on startup + every 5 min
Config watcher [config-watcher.ts] — polls .env every 2s, resets OpenAI client
Langfuse [langfuse.ts] — tracing for LLM calls, tools, router
```

---

## Safety Rules

- Alfred cannot be deactivated or renamed
- Inactive agents cannot spawn or receive messages
- Max spawn depth: 3 (prevents recursion)
- Hard limit: 25 concurrent temp agents
- Classifier JSON parse failure → silent fallback to Alfred
- All failures logged to `hive_mind` and `audit_logs`

---

## Recent Updates

### v1.4 (Current)

- **Agent-to-Agent Communication** — `message_agent` and `assign_task_to_agent` LLM tools available to all active agents; Alfred uses them proactively instead of redirecting the user
- **Comms Dashboard Tab** — inter-agent message log showing from/to, message, response, and status
- **`GET /api/agent-messages`** — API endpoint for the full comms log
- **Hive Mind comms events** — `agent_message_sent` and `agent_task_assigned` logged on every agent interaction

### v1.3

- **Task Decomposition** — Alfred decides if a task needs multiple agents and creates a step-by-step plan
- **Multi-Agent Orchestration** — executes steps across specialists with context chaining, merges results into a final response
- **Spawn Intelligence** — `evaluateSpawn()` gates all spawning on benefit threshold — prevents unnecessary temp agents
- **Execution Plan UI** — dashboard shows live plan steps, per-step progress, merge indicator, spawn approval/denial

### v1.2

- **Background Sub-Agent Execution** — sub-agents run async, main chat stays responsive
- **Auto-Deactivation** — temp agents deactivate when their task completes
- **Persistent Chat Sessions** — resume conversations, rename, delete sessions
- **Memory Management** — add/delete memories with type and importance
- **Enhanced Analytics** — message charts, top agents, event breakdown
- **Langfuse Integration** — full tracing for LLM calls, tools, router
- **Hot-Reload Development** — `tsx --watch` for auto-restart on file changes
- **Agent Filter Buttons** — filter agents by all/active/temp/inactive

---

## Planned Expansions

| Version | Feature |
|---|---|
| v1.4 | Memory system enhancements (Obsidian vault sync + auto-extractor) |
| v1.5 | Discord integration |
| v1.6 | LiveKit + ElevenLabs voice agents |
| v2 | Full NeuroClaw OS |
