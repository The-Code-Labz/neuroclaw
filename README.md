# NeuroClaw

**NeuroClaw** is a self-hosted, multi-agent AI orchestration system. A central orchestrator agent ("Alfred") receives every incoming message, classifies intent, and either answers directly or routes the work to specialist agents — each with their own persona, model, and tool access. Agents can talk to each other, spawn short-lived sub-agents for parallel work, execute shell/filesystem tools, remember what they've learned across sessions (SQLite + optional vector-backed long-term memory / RAG), and manage a shared task board. You interact with the system through a local web dashboard, a Discord bot, or a terminal chat client — all backed by the same agent registry and tool surface.

This repository is a **clean template**: clone it, provide your own API keys and secrets, and stand up your own instance.

---

## What's inside

- **Alfred** — the orchestrator: classifies intent, routes to specialists, can message or assign tasks to any other agent
- **Agent registry** — define specialist agents (persona, model, tools, skills) via the dashboard or config
- **Tool registry** — a shared surface of tools (memory, filesystem/shell exec, browser, audio, agent-to-agent comms, task management, MCP) that agents call during a turn
- **Memory system** — per-session SQLite persistence, long-term "vault" memory with importance scoring, and optional semantic search / RAG (via Supabase pgvector)
- **Task board** — create, assign, and progress tasks across agents; an optional autonomous loop can drain the board unattended
- **Interfaces** — local dashboard (Hono + React), a Discord bot, and CLI chat modes
- **NC Broker** — a secrets broker so agents reference credentials by name instead of holding raw values

See `CONTRIBUTING.md` in this repo for a deeper architecture write-up (presentation / orchestration / backend layers) and contribution guidelines.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** | 20 LTS or newer (developed against Node 22). Check with `node -v`. |
| **npm** | Ships with Node; no separate install needed. |
| **An OpenAI-compatible LLM provider** | NeuroClaw talks to models through an OpenAI-compatible API (referred to as "VoidAI" in config, but any compatible gateway/proxy works if you point the base URL at it). You need at least one API key. |
| **SQLite** | No install needed — bundled via `better-sqlite3`; the database is just a local file. |

Everything below is **optional**, enabling additional capabilities:

- **Discord bot token** — only if you want to chat with NeuroClaw from Discord.
- **Supabase (self-hosted or managed) with pgvector** — only if you want semantic memory search or the built-in Knowledge Base (RAG) feature instead of the default local keyword-based memory index.
- **Anthropic API key** or a local **Claude CLI** login — only if you want agents backed by Claude.
- **Langfuse, Composio, n8n, Kestra, Browserless, Brave Search, ElevenLabs, LiveKit, etc.** — each is an optional integration; the system runs fully without any of them.

---

## Setup

```bash
# 1. Clone the repository
git clone <your-fork-or-repo-url>.git
cd neuroclaw-v1

# 2. Install dependencies
npm install

# 3. Create your local environment file
cp .env.example .env

# 4. Edit .env — at minimum set:
#    VOIDAI_API_KEY=<your-provider-api-key>
#    DASHBOARD_TOKEN=<a-strong-random-token>   # replace the "change-me" default
#    (see Configuration below for everything else)

# 5. Build (only needed for a production/compiled run — dev modes below use tsx directly)
npm run build

# 6. Run it (pick one — see "Running NeuroClaw" below)
npm run dashboard        # local dashboard, recommended for first run
```

Then open:

```
http://localhost:3141/dashboard?token=<your DASHBOARD_TOKEN>
```

> Tip: run `npm run doctor` any time to sanity-check your local setup (config, DB, provider connectivity), and `npm run doctor:fix` to have it attempt safe auto-fixes.

---

## Configuration

All configuration lives in `.env`, seeded from `.env.example`. **Do not commit `.env`** — it's already covered by `.gitignore`. The example file is heavily commented; every block below only lists the variables that actually exist there.

### Required

```env
VOIDAI_API_KEY=sk-voidai-your-key      # your LLM provider key
DASHBOARD_TOKEN=CHANGE_ME              # auth token for every dashboard route — set a real secret
```

### Core runtime

```env
VOIDAI_BASE_URL=https://api.voidai.app/v1   # point at your own OpenAI-compatible gateway if not using VoidAI
VOIDAI_MODEL=gpt-5.1                         # default model for all agents
DASHBOARD_PORT=3141
DB_PATH=./neuroclaw.db
```

### Discord bot (optional — enables chatting with NeuroClaw from Discord)

```env
DISCORD_BOT_TOKEN=
DISCORD_DEFAULT_AGENT=Alfred
DISCORD_CHANNEL_ROUTES=        # optional JSON map of channel_id -> agent name/id
DISCORD_ALLOWED_USERS=         # optional allowlist of Discord user IDs
```

Create the bot at https://discord.com/developers/applications, enable the Message Content + Server Members intents, and paste the token in.

### Claude / Anthropic (optional — only if you want Claude-backed agents)

```env
CLAUDE_BACKEND=claude-cli      # 'claude-cli' uses a local Claude Code CLI subscription; 'anthropic-api' uses a direct key below
CLAUDE_CLI_COMMAND=claude
ANTHROPIC_API_KEY=            # required only when CLAUDE_BACKEND=anthropic-api
```

### Memory, RAG & Knowledge Base (optional — defaults to local SQLite memory)

```env
MEMORY_BACKEND=sqlite                 # or 'supabase' for pgvector-backed semantic memory
MEMORY_EMBEDDINGS_ENABLED=false       # required (true) if you switch to supabase or enable the Knowledge Base
KB_ENABLED=false
SUPABASE_URL=                         # your self-hosted or managed Supabase gateway URL
SUPABASE_SERVICE_KEY=                 # service_role key
KB_DB_SCHEMA=neuroclaw_kb
```

### MCP / NeuroVault long-term memory (optional)

```env
MCP_ENABLED=true
NEUROVAULT_MCP_URL=                   # your MCP endpoint
NEUROVAULT_DEFAULT_VAULT=
```

### Secrets broker (NC Broker)

```env
NC_BROKER_STORAGE=env-manager         # default: secrets live in .env. 'infisical' for an encrypted, audited backend
NC_BROKER_HMAC_KEY=                   # generate with `npm run broker:bootstrap` (auto-created at .nc-broker-hmac-key on first boot)
```

If you switch to Infisical, the self-hosted container variables (`INFISICAL_ENCRYPTION_KEY`, `INFISICAL_AUTH_SECRET`, `INFISICAL_DB_PASSWORD`, `INFISICAL_SITE_URL`) and the connection variables (`NC_BROKER_INFISICAL_*`) are documented inline in `.env.example` — generate each with `openssl rand` as the comments instruct.

### Everything else

`.env.example` also documents (all optional, all off/blank by default): Langfuse tracing, OpenRouter/Venice/Abacus/Ollama/LiteLLM/Kimi/Codex/Opencode providers, Composio (500+ app toolkits), n8n and Kestra workflow orchestration, Browserless + Brave Search + SearXNG web tools, ElevenLabs/Kokoro/Chatterbox TTS + Deepgram STT, LiveKit real-time rooms, the Dream cycle (nightly memory consolidation), autonomous task-board draining, and Sentinel task monitoring. Read the inline comments in `.env.example` before enabling any of these — each explains exactly what it unlocks and where to get credentials.

**Never hardcode any of the above directly into source files.** Everything flows through `.env` (or the NC Broker) by design.

---

## Running NeuroClaw

| Command | What it does |
|---|---|
| `npm run dashboard` | Dashboard with hot-reload (`tsx watch`) — recommended for local development |
| `npm run dashboard:once` | Dashboard, single run, no file-watch |
| `npm run dev:cli` | Terminal chat with Alfred (streaming), no dashboard |
| `npm run dev` | Runs `src/index.ts` directly with hot-reload |
| `npm run bot:discord` | Starts the Discord bot (requires `DISCORD_BOT_TOKEN`) |
| `npm run bot:discord:watch` | Same, with hot-reload |
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm start` | Runs the compiled `dist/index.js` (production) |
| `npm run doctor` | Diagnoses your local setup |
| `npm run doctor:fix` | Diagnoses and attempts safe auto-fixes |
| `npm run check:memory` | 10-test diagnostic suite for the memory pipeline |
| `npm run check:claude` | Diagnoses the Claude CLI/API integration |

### Running as a system service (systemd, Linux)

If you want the dashboard to survive reboots and crash-restart automatically, write a unit file pointing `ExecStart` at:

```
<npm-bin-path>/npm run dashboard
```

with `WorkingDirectory` set to the repo root and `Restart=always`. Reload systemd, then `enable` and `start` the unit as usual.

---

## Architecture overview

```
Presentation:    Dashboard (Hono + React) │ Discord Bot │ CLI
                            │
Orchestration:   Alfred (routes) │ Agent Registry │ Spawner (temp agents) │ Model Triage
                            │
                    Tool Registry (src/tools)
   Memory │ Agent comms │ Exec (bash/fs) │ Browser │ Audio │ MCP │ Task board
                            │
Backend:         SQLite (sessions, messages, tasks, memory, audit log)
                 + optional Supabase/pgvector for semantic memory & RAG
```

- **`src/agent/`** — Alfred and the core chat/orchestration loop
- **`src/tools/`** — the shared tool registry every agent draws from
- **`src/dashboard/`** — the Hono server + React dashboard UI
- **`src/integrations/`** — Discord bot and other external surfaces
- **`src/memory/`**, **`src/kb/`** — memory pipeline and Knowledge Base/RAG
- **`src/broker/`** — the NC Broker secrets layer
- **`src/mcp/`** — MCP server/client wiring (NeuroVault + others)
- **`src/doctor/`** — the `npm run doctor` diagnostic suite

For the full architecture write-up, coding standards, and how to add a new agent or tool, see **`CONTRIBUTING.md`**.

---

## Security notes

- `.env` is git-ignored by default — never commit real keys. Only `.env.example` should be tracked.
- `DASHBOARD_TOKEN` gates every dashboard route. Replace the default `change-me` before exposing the dashboard beyond `localhost`.
- The NC Broker (`NC_BROKER_HMAC_KEY`) mediates agent access to credentials — rotate this key if it's ever exposed.
- If you expose the dashboard or Discord bot beyond your own machine, put it behind your own reverse proxy/TLS termination (e.g. `https://your-domain.com`) — this template does not ship a public-facing proxy config.
- Exec tools (`bash_run`, `fs_*`) are opt-in per agent and off by default. Only enable them for agents you trust, and consider setting `EXEC_ROOT` to scope filesystem access.
- Review `EXEC_BASH_DENY` and the built-in denylist before enabling shell exec on any agent that isn't fully trusted.

---

## Contributing

See **`CONTRIBUTING.md`** for the full architecture overview, development setup, project structure, coding standards, and testing guidance.

## License

No license file is currently bundled with this template. Add a `LICENSE` file (e.g. MIT, Apache-2.0) appropriate to your fork before distributing it publicly, and update this section to match.
