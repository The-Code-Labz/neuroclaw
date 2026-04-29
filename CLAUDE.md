# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Run CLI chat loop (tsx src/index.ts)
npm run dashboard  # Run dashboard server (tsx src/dashboard/server.ts)
npm run build      # Compile TypeScript to dist/
npm start          # Run compiled dist/index.js
```

There is no test suite. TypeScript type checking is the primary correctness gate: `npx tsc --noEmit`.

## Architecture

Two entry points share the same SQLite database and agent registry:

**CLI** (`src/index.ts`): Reads stdin → enqueues via `messageQueue` (FIFO, prevents race conditions) → `chat()` in `alfred.ts` → streams tokens to stdout → persists in SQLite.

**Dashboard server** (`src/dashboard/server.ts`): Hono app on `localhost:3141`. Token-protected `/dashboard` serves inline HTML. All data APIs live under `/api/*` (also token-protected). `/api/chat` uses SSE streaming. `/api/config/watch` is a long-lived SSE stream that fires when `.env` changes.

**Agent registry**: The `agents` table is the source of truth. Alfred (orchestrator), Researcher, Coder, and Planner are seeded on every cold start (idempotent). System prompts are always updated at seed time so spawn guidance stays current.

**Routing priority chain** (`src/agent/alfred.ts → resolveAgent()`):
1. `@AgentName` prefix in the message — routes directly, strips mention
2. LLM auto-classifier (`AUTO_DELEGATION_ENABLED=true`) via `src/system/router.ts`
3. Explicit `agentId` from the dashboard dropdown
4. Alfred as final fallback

**Dynamic team awareness**: Every call to `chatStream()` refreshes the system message (history[0]) from the live DB. Alfred gets a fully rebuilt orchestrator prompt listing all active non-temp agents. Sub-agents get their stored prompt plus a "Active team members" section appended. This means user-created agents are immediately visible to all agents without a restart.

**Temporary agent spawning** (`src/system/spawner.ts`): When `SPAWN_AGENTS_ENABLED=true`, agents with `spawn_depth < 3` get the `spawn_agent` LLM tool. `chatStream` accumulates streaming tool call deltas, executes them on `finish_reason: 'tool_calls'`, then loops to get the LLM's synthesis. Max 5 iterations to prevent infinite loops. Spawned agents run their task synchronously via a recursive `chatStream` call.

**Hive Mind** (`src/system/hive-mind.ts`): `logHive()` records every routing decision, spawn, task change, and lifecycle event to the `hive_mind` table. It is wrapped in try/catch so it never crashes the main flow.

**Cleanup scheduler** (`src/system/cleanup.ts`): `startCleanupScheduler()` runs `expireTemporaryAgents()` on startup and every 5 minutes. Expired agents are set to `inactive` and logged to both `audit_logs` and `hive_mind`.

**Config hot-reload** (`src/system/config-watcher.ts`): Polls `.env` every 2s for mtime changes. On change: re-runs `dotenv.config()`, calls `resetClient()` to force a new OpenAI client, and emits on `configEvents`.

**`config.ts`** uses getter properties (not cached values) so live `process.env` changes propagate everywhere.

## Key Constraints

- **Lazy OpenAI client**: `openai-client.ts` must not construct the client at module scope — `dotenv` hasn't run yet at import time. Always use `getClient()`.
- **VoidAI returns HTTP 500 for invalid keys** (not 401).
- **Dashboard binds to `127.0.0.1` only**. Token from `DASHBOARD_TOKEN` required on all `/dashboard` and `/api/*` routes.
- **Alfred is protected**: `deactivateAgent()` returns `{ok: false}` for Alfred; `PATCH /api/agents/:id` prevents renaming Alfred.
- **Schema migration via try/catch**: `runMigrations()` uses try/catch around `ALTER TABLE` statements. SQLite doesn't support `ADD COLUMN IF NOT EXISTS`.
- **History keys**: Per-agent conversation histories are keyed as `"sessionId::agentId"` in `sessionHistories` Map. Each agent has isolated context within a session.
- **Classifier fallback**: If JSON parse fails or confidence < `AUTO_DELEGATION_MIN_CONFIDENCE`, routing falls back silently to Alfred. All decisions logged to hive mind.
- **Spawn depth limit**: Max 3 levels deep. `buildTools()` suppresses `spawn_agent` at depth ≥ 3.
- **Dynamic system prompts**: `history[0]` is overwritten on every `chatStream` turn. Do not rely on the session's cached system message — it is always rebuilt from DB.

## Environment Variables

Copy `.env.example` → `.env`:

| Variable | Default | Notes |
|---|---|---|
| `VOIDAI_API_KEY` | — | Required |
| `VOIDAI_BASE_URL` | `https://api.voidai.app/v1` | OpenAI-compatible endpoint |
| `VOIDAI_MODEL` | `gpt-5.1` | Default model for all agents |
| `DASHBOARD_PORT` | `3141` | |
| `DASHBOARD_TOKEN` | `change-me` | Protects all dashboard routes |
| `DB_PATH` | `./neuroclaw.db` | SQLite file path |
| `AUTO_DELEGATION_ENABLED` | `false` | LLM classifier auto-routes messages |
| `AUTO_DELEGATION_MIN_CONFIDENCE` | `0.65` | Minimum confidence to act on classifier decision |
| `ROUTER_MODEL` | *(same as VOIDAI_MODEL)* | Override model for the classifier |
| `SPAWN_AGENTS_ENABLED` | `false` | Allow agents to spawn temp sub-agents |
| `TEMP_AGENTS_AUTO_APPROVE` | `true` | Auto-approve all spawn requests |
| `TEMP_AGENT_TTL_HOURS` | `6` | Hours before temp agent expires |
| `TEMP_AGENT_IDLE_TIMEOUT_MINUTES` | `30` | Reserved for future enforcement |
| `TEMP_AGENT_SOFT_LIMIT` | `10` | Log warning above this many active temp agents |
| `TEMP_AGENT_HARD_LIMIT` | `25` | Block spawns above this many active temp agents |

## SQLite Schema

Tables: `agents`, `sessions`, `messages`, `tasks`, `memories`, `audit_logs`, `analytics_events`, `config_items`, `hive_mind`. All IDs are `randomUUID()`. Schema created idempotently in `db.ts:initSchema()`. Additive migrations in `runMigrations()`.

**Agent columns**: `id`, `name`, `description`, `system_prompt`, `model`, `role` (`orchestrator`/`specialist`/`assistant`/`agent`), `capabilities` (JSON array), `status` (`active`/`inactive`), `temporary` (0/1), `spawn_depth`, `parent_agent_id`, `created_by_agent_id`, `expires_at`, timestamps.

**Hive Mind columns**: `id`, `agent_id`, `action` (see Hive Mind actions below), `summary`, `metadata` (JSON), `created_at`.

Task status flow: `todo` → `doing` → `review` → `done`.

## Key Files

| File | Purpose |
|---|---|
| `src/agent/alfred.ts` | `chatStream()`, `resolveAgent()`, dynamic prompt builders |
| `src/system/router.ts` | `classifyRoute()` — LLM classifier for auto-delegation |
| `src/system/spawner.ts` | `spawnAgent()` — validates and creates temp agents |
| `src/system/hive-mind.ts` | `logHive()`, `getHiveEvents()` |
| `src/system/cleanup.ts` | TTL cleanup scheduler |
| `src/system/task-manager.ts` | `createTask()` (async, auto-assigns), `updateTask()` |
| `src/dashboard/routes.ts` | All `/api/*` endpoints |
| `src/dashboard/html.ts` | Single-file dashboard SPA (inline HTML/CSS/JS) |
| `src/db.ts` | Schema, migrations, seed, all CRUD helpers |
| `src/config.ts` | Getter-based config (reads live `process.env`) |

## API Endpoints

All `/api/*` require `?token=` or `x-dashboard-token` header.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | Active agents, temp agents, session/message counts |
| GET | `/api/agents` | All agents (including temp) |
| POST | `/api/agents` | Create agent (`name` required) |
| PATCH | `/api/agents/:id` | Update agent fields |
| DELETE | `/api/agents/:id` | Soft-deactivate (Alfred protected) |
| POST | `/api/agents/:id/activate` | Re-activate an inactive agent |
| POST | `/api/agents/spawn` | Manually spawn a temp agent |
| GET | `/api/tasks` | List tasks (`?status=` optional filter) |
| POST | `/api/tasks` | Create task; auto-assigns if `AUTO_DELEGATION_ENABLED` |
| PATCH | `/api/tasks/:id` | Update status, agent, or fields |
| GET | `/api/hive` | Hive Mind events (`?limit=` default 100) |
| POST | `/api/chat` | SSE stream; emits `session`, `agent`, `route`, `spawn`, `spawn_chunk`, `spawn_done`, `chunk`, `done`, `error` |
| GET | `/api/config/watch` | SSE stream for `.env` change notifications |

## Hive Mind Actions

`auto_route`, `route_fallback`, `manual_delegation`, `spawn_request`, `spawn_success`, `spawn_denied`, `agent_spawned`, `agent_expired`, `task_created`, `task_updated`, `agent_activated`, `agent_deactivated`

## Dashboard HTML

`src/dashboard/html.ts` returns the entire dashboard as a single inline HTML string. All onclick handlers use `data-*` attributes + `this.dataset.*` — never inline string parameters — to avoid JS string escaping issues inside TypeScript template literals (where `\'` is NOT a valid escape and becomes a bare `'`).

**Agent tab filters**: `filterAgents(filter)` applies client-side filtering (all/active/temp/inactive) to the rendered agent cards.

**Chat spawn streaming**: When a sub-agent is spawned during chat, `spawn_chunk` and `spawn_done` SSE events stream the sub-agent's response into its own separate message bubble in the UI.
