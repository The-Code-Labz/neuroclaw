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

**Dashboard server** (`src/dashboard/server.ts`): Hono app on `localhost:3141`. Token-protected `/dashboard` serves inline HTML. All data APIs live under `/api/*` (also token-protected). `/api/chat` uses SSE streaming with `@mention` delegation routing. `/api/config/watch` is a long-lived SSE stream that fires when `.env` changes.

**Agent registry**: The `agents` table is the source of truth. Alfred is the orchestrator (seeded at startup). Researcher, Coder, and Planner are specialists (also seeded). Alfred's system prompt lists all sub-agents and tells users to address them with `@Name`.

**Delegation flow**: When a chat message starts with `@AgentName`, `resolveAgent()` in `alfred.ts` finds that agent and routes the (mention-stripped) message to it using that agent's system prompt. Conversation histories are isolated per `sessionId::agentId` pair so each agent keeps its own context within a session. The SSE response emits `{type:'agent', name, agentId}` before chunks so the dashboard can label the responding agent.

**Config hot-reload** (`src/system/config-watcher.ts`): Polls `.env` every 2 s for mtime changes. On change: re-runs `dotenv.config()`, updates `config_items` table, calls `resetClient()` to force a new OpenAI client, and emits on `configEvents` so `/api/config/watch` SSE connections are notified.

**`config.ts`** uses getter properties (not cached values) so live `process.env` changes propagate everywhere without imports needing to re-read.

## Key Constraints

- **Lazy OpenAI client**: `openai-client.ts` must not construct the client at module scope — `dotenv` hasn't run yet at import time. Always use `getClient()`.
- **VoidAI returns HTTP 500 for invalid keys** (not 401). Error handlers in `src/index.ts` check for `"api key"` in the message and `"500"` as distinct cases.
- **Dashboard binds to `127.0.0.1` only**. The token from `DASHBOARD_TOKEN` is required on all `/dashboard` and `/api/*` routes. `/api/config` redacts `is_secret=1` rows.
- **Alfred is protected**: `deactivateAgent()` returns `{ok: false}` for Alfred, and `PATCH /api/agents/:id` prevents renaming Alfred.
- **Schema migration via try/catch**: `runMigrations()` in `db.ts` uses try/catch around `ALTER TABLE` statements because SQLite doesn't support `ADD COLUMN IF NOT EXISTS`. New additive columns go there.
- **Agent seed is idempotent**: Each agent is checked by name before insertion. Alfred and the three sub-agents (Researcher, Coder, Planner) are seeded on every cold start but only inserted if missing.

## Environment Variables

Copy `.env.example` → `.env`:

| Variable | Default | Notes |
|---|---|---|
| `VOIDAI_API_KEY` | — | Required |
| `VOIDAI_BASE_URL` | `https://api.voidai.app/v1` | OpenAI-compatible endpoint |
| `VOIDAI_MODEL` | `gpt-5.1` | |
| `DASHBOARD_PORT` | `3141` | |
| `DASHBOARD_TOKEN` | `change-me` | Protects all dashboard routes |
| `DB_PATH` | `./neuroclaw.db` | SQLite file path |

## SQLite Schema

Tables: `agents`, `sessions`, `messages`, `tasks`, `memories`, `audit_logs`, `analytics_events`, `config_items`. All IDs are `randomUUID()`. Schema is created idempotently in `db.ts:initSchema()`. Additive migrations run in `runMigrations()`.

Agent columns: `id`, `name`, `description`, `system_prompt`, `model`, `role` (`orchestrator`/`specialist`/`assistant`/`agent`), `capabilities` (JSON array), `status` (`active`/`inactive`), timestamps.

Messages now carry `agent_id` to track which agent produced each assistant turn.

Task status flow: `todo` → `doing` → `review` → `done`.

## API Endpoints

All `/api/*` require `?token=` or `x-dashboard-token` header.

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | System overview counts |
| GET | `/api/agents` | List all agents |
| POST | `/api/agents` | Create agent (`name` required) |
| PATCH | `/api/agents/:id` | Update agent fields |
| DELETE | `/api/agents/:id` | Deactivate agent (soft; Alfred protected) |
| POST | `/api/agents/:id/activate` | Re-activate an inactive agent |
| GET | `/api/tasks` | List tasks (optional `?status=`) |
| POST | `/api/tasks` | Create task (`title` required, optional `agent_id`) |
| PATCH | `/api/tasks/:id` | Update task status, agent, or fields |
| POST | `/api/chat` | SSE stream; supports `@mention` delegation |
| GET | `/api/config/watch` | SSE stream for `.env` change notifications |

## Planned Expansions (TODOs in code)

The codebase has `// TODO` comments marking integration points for: Discord.js bot, HTTP API routes, MCP bridge for IDE extensions, LiveKit voice rooms, ElevenLabs audio streaming, two-pass auto-delegation from Alfred's response, vector-store memory (pgvector/Chroma/Pinecone), BullMQ/Redis task queue, and Obsidian memory vault sync.
