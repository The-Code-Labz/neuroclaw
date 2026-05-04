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
- **Claude Integration** — agents with `provider=anthropic` route through your local Claude Code CLI subscription (default) or a direct Anthropic API key (opt-in)
- **NeuroVault Memory (MCP)** — long-term memory mirrored to a NeuroVault MCP server; type-routed into vault folders (`procedures/`, `insights/`, `logs/`, `agents/`, `projects/`), indexed locally in `memory_index` for fast search
- **Memory Intelligence Pipeline (v1.5)** — auto-extractor classifies every assistant turn into structured memory (LLM-backed), 5-component importance scoring with salience decay, dedupe within 7d, per-session/hour vault caps so noise can't fill the vault
- **Memory Pre-Injection** — top-N relevant memories auto-injected into every agent's system prompt every turn, so all backends (OpenAI/VoidAI / Anthropic API / Claude CLI) get baseline memory awareness without requiring a tool call
- **Cross-SDK Tool Surface (v1.5)** — in-process MCP server exposes our memory + agent-comms + spawn tools to the Claude Agent SDK, so Claude CLI agents can call `search_memory` / `write_vault_note` / `message_agent` / `spawn_agent` / `list_temp_agents` / etc. natively. See [Cross-SDK Capability Matrix](#cross-sdk-capability-matrix).
- **Manual Skills Loader (v1.5.1)** — walks `.claude/skills/*/SKILL.md` (project-local + user-global), parses YAML frontmatter, lets each agent declare a fixed list of skills via `agents.skills`. Bodies append to the system prompt. No per-turn LLM routing — predictable, composable, zero extra cost.
- **Skills Dashboard + Slash Commands (v1.8.1)** — full-CRUD `Skills` tab in the v2 dashboard for authoring `SKILL.md` files, attaching scripts, and converting raw scripts into callable skills. In chat, type `/<skill-name> [args]` to invoke any skill on the current turn — autocomplete pops up as you type, and the skill body is expanded inline before send so it works for **every provider** (VoidAI, Anthropic, Claude CLI, Codex), regardless of whether the chosen agent has the skill in its declared list.
- **Dream Cycle (v1.6)** — nightly cognitive loop that runs at `DREAM_RUN_TIME` (default `03:00`). Per-session LLM analysis, memory transformation (episodic → semantic / procedural), semantic dedupe, low-importance pruning, next-day plan generation, daily-log summary. Manual trigger via `POST /api/dream/run`.
- **Memory Diagnostic — `npm run check:memory`** — 10-test PASS/WARN/FAIL/SKIP suite covering SQLite write, retrieval fan-out, pre-injection formatting, vault round-trip, session summary, compaction trigger, with self-cleanup of test artifacts.
- **Auto Context Compaction** — when a session crosses token/turn thresholds, prior turns are summarized via LLM, persisted as a `session_summary` memory, and replaced in-place with `summary + relevant memories`. Long sessions stop blowing up the prompt without losing what mattered.
- **Model Triage (v1.5)** — agents have a `model_tier` strategy (`pinned` / `auto` / `low` / `mid` / `high`); the heuristic classifier picks the right model from the live VoidAI catalog per task, with borderline-zone LLM escalation, decision cache, cascade-depth penalty (deep sub-agents forced cheaper), and per-session/hour token budget guards
- **Live Model Catalog + Pricing** — `/v1/models` polled hourly from VoidAI; ~105 models auto-classified into tiers with seeded `$/1k` input/output prices; spend log joins against catalog for real-$ analytics
- **Exec Tools** — opt-in per-agent (`exec_enabled`) shell + filesystem tools (`bash_run`, `fs_read`, `fs_write`, `fs_list`, `fs_search`); on `claude-cli` agents this also unlocks Claude Code's bundled `Bash`/`Read`/`Write`/`Edit`/`Grep`/`Glob`
- **Dashboard v2 (preview)** — neon command-center UI at `/dashboard-v2` with 16 pages, ⌘K palette, live model picker, real-token spend cards, file-tree NeuroVault browser, real `memory_index` viewer, full SSE chat streaming. Lives alongside v1 until cutover.
- **Live Dashboard** — dark-mode web UI with SSE chat streaming, routing/spawn/comms indicators, config hot-reload
- **Hot-Reload Development** — `tsx --watch` auto-restarts on file changes
- **SQLite Persistence** — sessions, messages, tasks, memories, agent comms, audit logs, analytics, hive events
- **Hot-reload Config** — edit `.env` while running; detected and applied within 2 seconds
- **Voice (TTS + STT) (v1.8)** — per-agent TTS via VoidAI or ElevenLabs; mic input + speaker playback in the dashboard chat; Discord voice notes auto-transcribed; Discord replies attach a synthesized `.mp3` when both bot and agent have voice enabled; agents can configure all of this in chat through the `audio_*` self-setup tools

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
| `CLAUDE_BACKEND` | No | `claude-cli` | `claude-cli` (subscription auth via local Claude CLI) or `anthropic-api` (direct Anthropic API key). No silent fallback. |
| `CLAUDE_CLI_COMMAND` | No | `claude` | Binary name/path for the Claude CLI. Used by both the chat provider and the `/api/skills/install` panel's binary resolver. |
| `CLAUDE_CLI_PATH` | No | — | Absolute path to the Claude CLI binary. Highest-priority candidate in the install panel's binary resolver — set this when `claude` lives somewhere unusual that isn't on the dashboard process's `PATH` (e.g. tsx watch strips the user's login `PATH`). |
| `CLAUDE_MAX_TURNS` | No | `20` | Max agent-loop turns per CLI call |
| `CLAUDE_TIMEOUT_MS` | No | `900000` | Hard timeout per CLI call (default 15min) |
| `CLAUDE_CONCURRENCY_LIMIT` | No | `1` | Max concurrent claude-cli requests; extras queue |
| `CLAUDE_RETRY_MAX` | No | `2` | Max retries on 429 |
| `CLAUDE_RETRY_BASE_MS` | No | `3000` | Exponential-backoff base for 429 retries |
| `ANTHROPIC_API_KEY` | Conditional | — | Required only when `CLAUDE_BACKEND=anthropic-api` |
| `MCP_ENABLED` | No | `false` | Master switch for MCP integrations (NeuroVault / ResearchLM / InsightsLM) |
| `NEUROVAULT_MCP_URL` | When MCP_ENABLED | — | Streamable-HTTP MCP endpoint for NeuroVault |
| `NEUROVAULT_DEFAULT_VAULT` | No | `neuroclaw` | Vault NAME (resolved to UUID at runtime via `list_vaults`) |
| `RESEARCHLM_MCP_URL` | No | — | Optional ResearchLM MCP endpoint |
| `INSIGHTSLM_MCP_URL` | No | — | Optional InsightsLM MCP endpoint |
| `DREAM_ENABLED` | No | `false` | Nightly memory consolidation cycle (P3) |
| `DREAM_RUN_TIME` | No | `03:00` | Local-clock HH:MM to run the dream cycle |
| `DREAM_LOOKBACK_HOURS` | No | `24` | Hours of session history to consolidate |
| `DREAM_MODEL` | No | *(agent default)* | Override model for the consolidator LLM |
| `EXEC_TIMEOUT_MS` | No | `60000` | Per-call hard timeout for `bash_run` |
| `EXEC_OUTPUT_MAX_BYTES` | No | `200000` | Max stdout+stderr captured per call |
| `EXEC_BASH_DENY` | No | — | Comma-separated extra patterns to hard-deny (built-ins always include `rm -rf /`, `sudo rm`, fork bombs, `mkfs`, `dd to /dev`, `shutdown`, `reboot`, `curl|sh`) |
| `EXEC_ROOT` | No | — | Optional filesystem boundary; empty = no boundary |
| `EXEC_DEFAULT_CWD` | No | *(process cwd)* | Default working directory for `bash_run` |
| `VOIDAI_TTS_MODEL` | No | `tts-1` | TTS model for VoidAI `/audio/speech` |
| `VOIDAI_TTS_VOICE` | No | `alloy` | Default voice for VoidAI TTS (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`) |
| `VOIDAI_TRANSCRIBE_MODEL` | No | `whisper-1` | STT model for VoidAI `/audio/transcriptions` |
| `ELEVENLABS_API_KEY` | No | — | Enables ElevenLabs as a per-agent TTS provider |
| `ELEVENLABS_BASE_URL` | No | `https://api.elevenlabs.io/v1` | ElevenLabs API base |
| `ELEVENLABS_DEFAULT_VOICE_ID` | No | — | Fallback ElevenLabs voice id when an agent picks ElevenLabs but has no `tts_voice` set |
| `ELEVENLABS_MODEL` | No | `eleven_turbo_v2_5` | ElevenLabs model id |
| `AUDIO_MAX_MB` | No | `25` | Hard cap on uploaded audio for transcription |
| `AUDIO_MAX_TTS_CHARS` | No | `4000` | Hard cap on text length per TTS request |

> **VoidAI quirk:** invalid API keys return HTTP 500, not 401.

### Audio (TTS + transcription)

Voice runs on two surfaces:

- **Dashboard chat** — mic button captures audio via `MediaRecorder`, posts to `POST /api/audio/transcribe`, and fills the input. Each assistant message gets a 🔊 button that hits `POST /api/audio/speak` and plays the result inline.
- **Discord** — voice notes (audio attachments) are auto-transcribed and routed to the agent like a normal message. Replies attach a synthesized `.mp3` when both `discord_bots.voice_enabled = 1` and the responding agent's `agents.tts_enabled = 1`. Toggle voice per bot from the **Channels** page; toggle TTS + pick a voice per agent from the **Agents** editor.

TTS providers:
- **VoidAI** (default) — OpenAI-compatible `/audio/speech` with the standard six voices.
- **ElevenLabs** — picked per-agent, requires `ELEVENLABS_API_KEY`. The voice picker is populated from `GET /v1/voices`.

Transcription is always VoidAI Whisper.

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
| MCP Tools | Registered MCP servers, status, cached tool list per server |
| Skills | List, create, edit, delete skills · attach/remove scripts · "Script → Skill" form to wrap a raw script as a callable skill |
| Logs | Recent audit log entries |

### Chat Features

- **Session Dropdown** — switch between existing sessions or start a new chat
- **Session Persistence** — conversations restored from database on page load
- **Rename/Delete** — manage sessions directly from the chat toolbar
- **Agent Selector** — pick any active agent to chat with
- **`@mention`** — prefix message with `@Researcher`, `@Coder`, or `@Planner` to force-route
- **`/slash` commands for skills** — type `/<skill-name> [args]` to invoke any skill on the current turn. Autocomplete pops up after `/` with name + description; Tab/Enter inserts. The skill body is expanded inline into the prompt before send, so it works on every backend (VoidAI, Anthropic API, Claude CLI, Codex) regardless of whether the chosen agent has the skill in its declared list. The user bubble shows a `/skill-name` chip so the activation is visible in the thread.
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

## Claude Integration

Agents whose `provider` is `anthropic` route Claude calls through one of two backends, selected globally via `CLAUDE_BACKEND`. There is no silent fallback between them — if the configured backend fails, the request fails.

### Backends

| Backend | Auth | Billing | Tools |
|---|---|---|---|
| `claude-cli` (default) | Local `claude` CLI's stored OAuth credentials (`~/.claude/.credentials.json`) | Counted against your Claude Pro/Max subscription | **Disabled** on this path — the Agent SDK owns its own tool loop |
| `anthropic-api` | `ANTHROPIC_API_KEY` from `https://console.anthropic.com` | Per-token, billed to the Anthropic console account | Full tool calling via `@anthropic-ai/sdk` |

VoidAI agents (`provider=voidai`) are unaffected by this setting and continue to use the OpenAI-compatible VoidAI API regardless of `CLAUDE_BACKEND`.

> **Heads up — subscription quota is *not* the same as Anthropic API quota.** The `claude-cli` backend consumes your Claude Code subscription window. Anthropic does not formally permit subscription auth in shipped products; this path is intended for local personal use.

### Quick start

```bash
# Default: use your local Claude subscription
unset ANTHROPIC_API_KEY
echo 'CLAUDE_BACKEND=claude-cli' >> .env
npm run check:claude   # diagnostics
npm run dashboard
```

Switch to API-key billing:

```bash
echo 'CLAUDE_BACKEND=anthropic-api' >> .env
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
npm run check:claude
```

### Diagnostics — `npm run check:claude`

Prints the active backend, resolved binary path, version, auth source, and warns when:

- `CLAUDE_BACKEND=claude-cli` but the binary isn't runnable
- `CLAUDE_BACKEND=anthropic-api` but `ANTHROPIC_API_KEY` is unset
- `CLAUDE_CONCURRENCY_LIMIT > 2` (subscription auth has tight per-window limits)
- Spawning is enabled with `claude-cli` (each spawned agent burns subscription quota)

Exits non-zero when the active backend is unusable.

### 429 handling

When the `claude-cli` backend returns 429 (rate limit), it retries up to `CLAUDE_RETRY_MAX` times with exponential backoff (`CLAUDE_RETRY_BASE_MS` × 2^attempt) and logs each event to Hive Mind as `claude_cli_throttled`. Persistent 429s after retries propagate as `ClaudeCliRateLimitError` to the caller.

The dashboard Overview shows the active backend, the current request-queue length, and the count of 429s in the last hour.

---

## NeuroVault Memory (MCP)

Long-term memory lives in a NeuroVault MCP server (Obsidian-style file-tree vault). NeuroClaw mirrors its in-process memory writes to the configured vault and indexes them locally in `memory_index` for cheap retrieval.

### Configure

```bash
MCP_ENABLED=true
NEUROVAULT_MCP_URL=https://n8n.neurolearninglabs.com/mcp/vaultmind-mcp
NEUROVAULT_DEFAULT_VAULT=neuroclaw   # name; resolved to UUID via list_vaults
```

If `MCP_ENABLED=false`, all memory tools fall back to the local SQLite-only path.

### Vault routing (memory type → folder)

The `vault` parameter on `vaultCreateNote` becomes a folder prefix inside one vault, not a separate vault.

| Memory type | Folder |
|---|---|
| `procedural` / `procedure` | `procedures/` |
| `project` | `projects/` |
| `agent` / `agent_memory` / `preference` | `agents/` |
| `log` / `daily_log` / `episodic` / `session_summary` / `working` | `logs/` |
| `insight` / `semantic` | `insights/` |
| *(other / unknown)* | `default/` |

File names follow `<folder>/<YYYY-MM-DD>--<slugified-title>.md`. Notes use a standardized header (`Type:`, `Agent:`, `Importance:`, `Tags:`) followed by `## Summary` / `## Details` / `## Source` / `## Related Memories`.

### Tools exposed (live mapping)

The spec's tool names are translated to the live API. All calls go through `src/mcp/mcp-client.ts` — no direct HTTP from anywhere else.

| Spec name | Real tool | Notes |
|---|---|---|
| `vault_search` | `search_vault({vault_id, q, limit})` | |
| `vault_read_note` | `read_file({vault_id, path})` | `note_id` = file path |
| `vault_create_note` | `create_file({vault_id, path, content})` | path auto-generated from type+title |
| `vault_update_note` | `upsert_file` / `append_file` / `prepend_file` | depending on `updates.{content,append,prepend}` |
| `vault_list_collections` | `list_folders({vault_id})` | |
| `vault_get_related_notes` | `search_vault(path)` | live MCP has no native related-notes endpoint |

Bonus tools also exposed: `get_context_pack`, `log_handoff`, `create_checkpoint`, `list_files`, `get_tree`.

> ⚠ `note_id` in this codebase is the **file path** within the vault, not a database row ID.

### Local index

Every memory mirrored to NeuroVault also gets a row in `memory_index` (additive table — the legacy `memories` table is preserved for the dashboard memory tab). Schema:

```
memory_index(id, type, title, summary, tags, importance, salience,
             agent_id, session_id, vault_note_id, vault_path,
             created_at, last_accessed)
```

Helpers: `indexMemory()`, `searchMemoryIndex()`, `listMemoryIndex()`, `touchMemoryAccess()`, `attachVaultNote()` in `src/memory/memory-service.ts`. The retriever (`src/memory/memory-retriever.ts`) currently runs SQLite-only; vault and ResearchLM/InsightsLM fan-out are scheduled for P2.

### Status

- **P1 (shipped):** MCP HTTP client, NeuroVault adapter with vault-name→UUID resolution, type→folder routing, `memory_index` schema + helpers. End-to-end smoke confirmed against the live n8n MCP.
- **P2 (next):** memory extractor (auto-classify chat events into memories), retriever fan-out, agent-facing tools (`search_memory`, `write_vault_note`, `compact_context`, etc.).
- **P3 (later):** dream cycle (nightly consolidation), pattern detection, next-day plans.

---

## Exec Tools

Per-agent shell + filesystem access. Off by default.


### Enable for an agent

Toggle the **Exec enabled** checkbox on an agent's edit form, or `PATCH /api/agents/:id { "exec_enabled": true }`. Agents with `exec_enabled=1` show an orange `EXEC` badge on their card.

### Tools

Available to any `exec_enabled` agent regardless of provider:

| Tool | What it does |
|---|---|
| `bash_run({command, cwd?, timeout_ms?})` | Run a shell command via `bash -lc`. Streams stdout+stderr; output byte-capped; timeout enforced. |
| `fs_read({path})` | Read a file (capped to `EXEC_OUTPUT_MAX_BYTES`). |
| `fs_write({path, content, mode?})` | Write a file. `mode` = `overwrite` (default), `append`, `create` (fails if exists). Creates parent dirs. |
| `fs_list({path})` | Directory listing with type + size. |
| `fs_search({pattern, path?, max_results?})` | Recursive search. Uses `rg` if installed, falls back to `grep -rn`. |

For agents with `provider=anthropic` on the `claude-cli` backend, `exec_enabled` *also* unlocks the bundled Claude Code tools: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`. Those follow your local `~/.claude/settings.json` permission rules — same UX as interactive `claude`.

### Safety model

- **Default-allow shell**, hard-deny denylist for catastrophic commands. Built-in denies: `rm -rf /`, `rm -rf /*`, `rm -rf ~`, fork bombs, `mkfs`, `dd to /dev/...`, `shutdown`, `reboot`, `sudo rm`, `curl|sh`/`curl|bash`, `wget|sh`/`wget|bash`. Add your own via `EXEC_BASH_DENY=…`.
- **Env scrubbing.** `ANTHROPIC_API_KEY`, `VOIDAI_API_KEY`, `LANGFUSE_*`, `OPENAI_API_KEY`, `DASHBOARD_TOKEN` are stripped from every child process so commands cannot exfiltrate secrets.
- **Output cap.** Hard limit `EXEC_OUTPUT_MAX_BYTES` (200KB by default). Truncation is flagged.
- **Timeout.** Hard limit `EXEC_TIMEOUT_MS` (60s by default). Tool callers may pass `timeout_ms` but the server caps to 2× the env value.
- **Filesystem boundary.** Optional `EXEC_ROOT`. Empty (default) = no boundary; agents can read/write anywhere your user can. Set it to `/home/neuroclaw-v1` (or wherever) to confine.
- **Audit log.** Every call writes one row to `audit_logs` (`exec_run` or `exec_denied`) with tool, args, exit code, duration, agent ID. Inspect with `SELECT * FROM audit_logs WHERE action LIKE 'exec_%' ORDER BY created_at DESC`.

> ⚠ Once enabled, an agent can do anything your shell user can do. Do not enable on temp/spawned agents you don't trust.

---

## Memory Intelligence Pipeline (v1.5)

Memory is a four-stage pipeline. Each stage logs to `hive_mind` so you can audit what got remembered, what got skipped, and why.

```
chat turn
  ↓
EXTRACTOR (LLM)        →  classifies into episodic | semantic | procedural | preference | insight
  ↓                       scores 5 importance components, drops if score < threshold
WRITE PIPELINE         →  dedupe (title+type+agent within 7d) → indexMemory() → vault mirror
  ↓                       per-session and per-hour vault caps; over cap stays local-only
RETRIEVER (fan-out)    →  SQLite memory_index ∪ Vault MCP ∪ ResearchLM ∪ InsightsLM, ranked
  ↓                       categorized → { memory, procedures, insights, preferences }
PRE-INJECTION          →  top-N relevant memories grouped + cited into every system prompt
                          → reaches all SDKs (OpenAI / Anthropic API / Claude CLI)
```

### Tunables

| Env | Default | What it does |
|---|---|---|
| `MEMORY_EXTRACT_MIN_CHARS` | `200` | Skip extraction for short assistant turns |
| `MEMORY_EXTRACT_MODEL` | *VOIDAI_MODEL* | Override the extractor model (use a cheap one — every assistant turn pays for it) |
| `MEMORY_IMPORTANCE_THRESHOLD` | `0.6` | Drop extracted memories below this composite score (0–1) |
| `MEMORY_PER_SESSION_MAX` | `50` | Vault writes capped per session (overflow stays in SQLite) |
| `MEMORY_PER_HOUR_MAX` | `200` | Rolling-hour cap; same fall-back-to-local behavior |
| `MEMORY_PREINJECT_ENABLED` | `true` | Auto-inject top memories into every system prompt |
| `MEMORY_PREINJECT_MAX` | `5` | Number of memories injected per turn |
| `COMPACT_ENABLED` | `true` | Auto-compact when sessions cross thresholds |
| `COMPACT_TOKEN_THRESHOLD` | `8000` | OR trigger |
| `COMPACT_TURN_THRESHOLD` | `30` | OR trigger |
| `COMPACT_KEEP_RECENT` | `6` | Last K turns kept verbatim |
| `COMPACT_REINJECT_MEMORIES` | `3` | Top-N memories pulled in alongside the summary |

### Hive Mind actions emitted by the pipeline

`memory_extracted`, `memory_skipped`, `memory_capped`, `claude_cli_throttled`, `triage_llm_used`, `triage_depth_penalty`, `triage_budget_downgrade`, `agent_area_set`.

---

## Model Triage (v1.5)

Per-agent model strategy. Each agent has a `model_tier` that decides what model gets called per task.

| `model_tier` | Behavior |
|---|---|
| `pinned` (default) | Use `agent.model` literally |
| `auto` | Heuristic classifier picks a tier per task; cheap heuristic free, optional borderline LLM escalation |
| `low` / `mid` / `high` | Always use the cheapest available model in that tier |

### What protects the system at scale

| Mechanism | Where | What it does |
|---|---|---|
| **Heuristic** | `src/system/model-triage.ts` | Pattern-matches task complexity (length, code blocks, multi-step verbs, reasoning signals, tool-use signals) → `low`/`mid`/`high`. Free, deterministic. |
| **Decision cache** | LRU(500) + 5min TTL | Repeating task descriptions reuse the prior decision. Saves the LLM-escalation cost on retried/cron-style spawns. |
| **Borderline LLM** | `model-triage-llm.ts` | Only fires for scores in `[0.40, 0.55]`. One cheap haiku-tier call. ~10× cheaper than LLM-on-every-spawn at scale. |
| **Cascade-depth penalty** | `applyDepthPenalty()` | Sub-agents at depth ≥ 2 capped at `mid`; depth ≥ 3 forced to `low`. Kills runaway spawn pyramids burning Opus. |
| **Budget guard** | `checkBudget()` | When session/hour token spend exceeds `BUDGET_SESSION_TOKENS` (200k) / `BUDGET_HOUR_TOKENS` (1M), `high` downgrades to `mid`, then to `low`. Logged. |
| **Real token usage** | OpenAI `stream_options: { include_usage }`, Anthropic `message_delta.usage`, Claude CLI `SDKResultMessage.usage` + `total_cost_usd` | Spend log uses real counts, not 4-char approximations |

### Live model catalog

`/v1/models` polled from VoidAI hourly into the `model_catalog` table. ~105 models auto-classified into `low`/`mid`/`high` by name pattern and seeded with `$/1k` prices from a known-prices regex table. Manual overrides:

```bash
POST /api/models/voidai/<model_id>/tier   { "tier": "high" | "mid" | "low" | null }
POST /api/models/voidai/<model_id>/price  { "input": 1.50, "output": 4.00 }   # null/null to reset
```

`POST /api/models/refresh?provider=voidai` forces a re-fetch.

---

## Cross-SDK Capability Matrix

The same custom tool surface (memory, agent comms, exec) is exposed across all backends. Filesystem + shell parity uses our own `bash_run`/`fs_*` for non-Claude-Code paths, and Claude Code's bundled `Bash`/`Read`/`Write`/`Edit`/`Grep`/`Glob` for the CLI path.

| Capability | OpenAI / VoidAI | Anthropic API | Claude CLI |
|---|---|---|---|
| `search_memory`, `search_vault` | ✅ via OpenAI tool defs | ✅ via Anthropic tool defs | ✅ via in-process MCP (`mcp__neuroclaw__search_memory`) |
| `write_vault_note`, `save_session_summary`, `compact_context` | ✅ | ✅ | ✅ via in-process MCP |
| `message_agent`, `assign_task_to_agent`, `list_agents` | ✅ | ✅ | ✅ via in-process MCP |
| `log_handoff`, `create_checkpoint`, `get_context_pack` | (use direct vault helpers) | (same) | ✅ via in-process MCP |
| `spawn_agent` (temp sub-agents) | ✅ when `SPAWN_AGENTS_ENABLED` | ✅ | ✅ via in-process MCP (`mcp__neuroclaw__spawn_agent`, `mcp__neuroclaw__list_temp_agents`) |
| Memory pre-injection in system prompt | ✅ all backends | ✅ all backends | ✅ all backends |
| Filesystem + shell | ✅ `bash_run` / `fs_*` (when `exec_enabled`) | ✅ same | ✅ Claude SDK's `Bash` / `Read` / `Write` / `Edit` / `Grep` / `Glob` (when `exec_enabled`) |
| Claude Code Skills (`.claude/skills/*/SKILL.md`) | ✅ via manual loader (agent declares skill names via `agents.skills`; bodies appended to system prompt — no per-turn routing) | ✅ same | ✅ auto-loads via Agent SDK |
| Real token + cost capture | ✅ `stream_options.include_usage` | ✅ `message_delta.usage` | ✅ `SDKResultMessage.usage` + `total_cost_usd` |

### How the cross-SDK plumbing works

The bridge is `src/mcp/neuroclaw-mcp-server.ts` — an **in-process MCP server** built with `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk`. It wraps our existing helpers as MCP tools:

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
// → tool('search_memory', '...', zodSchema, async (args) => searchMemoryTool(args))
// → returned as a JS-object MCP server, no subprocess
```

The Claude CLI provider (`src/providers/claude-cli.ts`) passes this server to the Agent SDK's `query()` via `mcpServers: { neuroclaw: <server> }` and pre-approves all 11 tools via `allowedTools` so they don't trigger a permission prompt. Tool calls run in-process — same memory space, no IPC, no extra latency.

For OpenAI/Anthropic-API agents, the same tools are registered as `ChatCompletionTool[]` / `Anthropic.Messages.Tool[]` via `buildTools()` in `src/agent/alfred.ts`, dispatched in `executeTool()`. Different tool-defs, identical handlers.

---

## Dream Cycle (v1.6)

The Dream Cycle is a nightly **cognitive loop** that takes raw experience (chats, tasks, agent comms) and consolidates it into durable memory. It's the difference between an agent that *stores* and an agent that *learns*.

```
Perceive → Remember → Reflect → Refine → Evolve
            (extractor)  (dream cycle)
```

### When it runs

- Scheduled at `DREAM_RUN_TIME` (default `03:00`, local clock) when `DREAM_ENABLED=true`. Computed via `setTimeout` chain — survives clock drift, no external cron needed.
- Manual trigger any time via `POST /api/dream/run`. Useful for testing, on-demand catchup, or running on demand after a heavy day.
- Re-entrant guard: only one cycle runs at a time.

### The 8-step pipeline

| Step | What it does | Module |
|---|---|---|
| **1. Gather** | Pull last `DREAM_LOOKBACK_HOURS` of sessions / messages / `memory_index` rows / tasks / agent_messages | `gather()` |
| **2. Session Analysis** | Per-session LLM call (JSON-mode) returns `{ decisions, patterns, procedures, insights }`. Drops noise; empty arrays for chitchat. | `analyzeSession()` |
| **3. Transform** | Episodic memories that recurred 2× → semantic; recurred 3+ → procedural. Salience bumped on recurring concepts. | `transform()` |
| **4. Semantic Dedupe** | Token Jaccard similarity (≥ 0.65) on title + summary; merge instead of discard, salience bumped on the survivor. Vault-anchored memories never touched. | `dedupe()` |
| **5. Prune** | Drop local-only rows that are low-importance + low-salience + stale (> 7d, not accessed). Vault-mirrored rows always preserved. | `prune()` |
| **6. Next-Day Plan** | LLM call over aggregated outputs → `{ title, summary, priorities, tasks, unresolved, optimizations }`. | `generatePlan()` |
| **7. Vault Writes** | Procedures → `procedures/`, insights → `insights/`, plan → `logs/`, daily log summary → `logs/`. Subject to per-session and per-hour vault caps; over-cap rows stay in SQLite. | `writeVaultNoteTool` |
| **8. Hive Logs** | `dream_cycle_start` / `_complete` / `_failed`, `memories_created` / `_promoted` / `_merged` / `_pruned`, `procedures_created`, `plan_created`. | `logHive()` |

### Configure

```bash
DREAM_ENABLED=true
DREAM_RUN_TIME=03:00
DREAM_LOOKBACK_HOURS=24
DREAM_MODEL=               # falls back to MEMORY_EXTRACT_MODEL → VOIDAI_MODEL
```

### Trigger manually

```bash
curl -X POST "http://localhost:3141/api/dream/run?token=$DASHBOARD_TOKEN"
```

Returns the full `DreamCycleResult` — durations, scope counts, output counts, vault paths, and any non-fatal errors.

### Status / history

```bash
curl "http://localhost:3141/api/dream/status?token=$DASHBOARD_TOKEN"
```

Shows the configured schedule + the last 20 dream-cycle hive events (start / complete / failed).

### Safety guarantees

- **Vault-anchored memory is never deleted** by the cycle. Pruning only touches local-only rows.
- **Vault writes respect existing per-session and per-hour caps** (`MEMORY_PER_SESSION_MAX`, `MEMORY_PER_HOUR_MAX`). Over-cap content stays in SQLite — no cap breach.
- **Idempotent on empty data** — if the lookback window is empty, the cycle does nothing destructive and exits clean.
- **MCP-optional** — runs cleanly with `MCP_ENABLED=false`. Vault mirror is skipped; SQLite consolidation still happens.
- **Re-entrant guard** — concurrent calls are rejected with `errors: ["dream cycle is already running"]`.
- **Errors are partial-failure tolerant** — per-session analysis errors are logged in `result.errors[]`; the cycle continues with remaining sessions.

---

## Skills (v1.5.1)

Skills are reusable Markdown instructions an agent loads alongside its system prompt. NeuroClaw's loader is **manual selection only** (no per-turn LLM routing) — predictable, composable, no extra cost per turn.

### Layout

The loader walks **four** roots, in priority order. **First writer wins on name collision** — so a project-local copy automatically shadows an upstream plugin or marketplace skill of the same name.

```
.claude/skills/<name>/SKILL.md                                                ← project-local (cyan tag, fully editable)
~/.claude/skills/<name>/SKILL.md                                              ← user-global (violet tag, read-only)
~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
   (only those listed in ~/.claude/plugins/installed_plugins.json)            ← installed plugin (amber tag, read-only)
~/.claude/plugins/marketplaces/<m>/{plugins,external_plugins}/<p>/skills/<n>/SKILL.md
                                                                              ← marketplace (green tag, read-only)
```

This means every plugin and marketplace skill that Claude Code can natively see — `superpowers:test-driven-development`, `mcp-server-dev:build-mcp-server`, `discord:configure`, etc. — is also reachable from VoidAI / OpenAI / Codex agents through NeuroClaw's identical `buildSkillsBlock(...)` plumbing. See *Plugin + marketplace skill discovery* in v1.8.1 below for the full implementation.

### SKILL.md format

```markdown
---
name: deploy-checklist
description: Step-by-step pre-flight checks before any production deploy
triggers: [deploy, ship, release]
tools: [bash_run, fs_read]
---

# Deploy checklist

1. Run the test suite
2. Bump version
3. Tag the commit
…
```

The loader reads the YAML frontmatter (minimal parser — handles `key: value`, inline `[a, b, c]` lists, and quoted strings) plus the entire body after the second `---`. `triggers` and `tools` are stored on the record but **not enforced or auto-routed** in v1.5.1; they're informational and shown on the dashboard tooltip.

### Attach a skill to an agent

Open the agent in the v2 dashboard editor → toggle the skill chips. Behind the scenes:

```bash
PATCH /api/agents/:id
{ "skills": ["deploy-checklist", "code-review-rules"] }
```

`agents.skills` is a JSON array column. At chat time, every backend's chat path runs:

```
buildSkillsBlock(resolveEffectiveSkillNames(parseAgentSkills(agent.skills)))
  ↓ (returns markdown block)
appended to system prompt before memory pre-injection
```

Any skill flagged with `always_on: true` in its frontmatter (see [Always-on skills](#always-on-skills)) is automatically merged into the resolved list — de-duplicated, with the agent's declared order preserved — so house-style guides, common idioms, etc. land in every agent's prompt without having to be added to each `agents.skills` column.

This works on OpenAI/VoidAI, Anthropic API, and Claude CLI agents identically.

### Cache + refresh

The loader caches the catalog for 30 seconds in-process. To force a refresh:

```bash
GET /api/skills?refresh=1
```

### Compatibility note

Existing Claude CLI Skills (auto-loaded by the Agent SDK from `~/.claude/skills/`) are untouched — our loader is additive, on a separate column. A Claude-CLI agent with a non-empty `agents.skills` will see those skills' bodies in its system prompt **and** also get its CLI-managed Skills auto-loaded.

### Dashboard `Skills` tab (v1.8.1)

Open `Skills` in the v2 sidebar (under SYSTEM). The tab is wired live to the file-backed loader.

- **+ New Skill** — author a `SKILL.md` directly: name, description, body (markdown), optional triggers + tools (CSV).
- **Script → Skill** — paste a raw shell / python / node script, give it a name + description and a filename. The dashboard creates `.claude/skills/<name>/scripts/<filename>` (chmod +x) and auto-generates a wrapper `SKILL.md` whose body tells the LLM to call `run_skill_script(skill_name, script, args=[...])`. The script becomes universally callable from any agent runtime.
- **Per-skill expand** — view full body, list scripts, add new scripts (filename + content textarea), remove scripts.
- **Edit / Delete** — only project-local skills (`.claude/skills/`) are editable from the UI; user-global skills (`~/.claude/skills/`) are read-only and source-tagged.
- **Path-traversal protected** — script filenames are validated by `skill-loader.ts` (single segment, no `..`, sane extension), and `getSkillScriptPath()` double-checks the resolved path stays inside the skill folder.

### Slash commands in chat

Type `/` in the chat input to open an autocomplete popup of every loaded skill. As you type, matches narrow by prefix. **Tab** or **Enter** (when no exact match yet) inserts `/<name> ` and re-focuses the input.

When the message is sent, the chat client expands the slash form into the full prompt **client-side** before posting:

```
/<name> [args]   →   [Skill activated: /<name>]
                     <skill body>

                     ---

                     <args>
```

This means slash commands work for **every provider** without backend changes — the skill body lives in the user message itself, so VoidAI, Anthropic API, Claude CLI, and Codex CLI agents all see it. The visible chat bubble keeps the literal `/foo bar` text the user typed, plus a `/skill-name` chip in the header so the activation is auditable in the thread.

If the slash refers to a skill that isn't loaded (typo, not yet refreshed), no expansion happens and the literal text is sent — the agent will simply treat it as ordinary input.

### Skills API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/skills` | List loaded skills (project + user-global). `?refresh=1` busts the 30s cache. `?full=1` includes the body field |
| `GET` | `/api/skills/:name` | Full record incl. body and scripts |
| `POST` | `/api/skills` | Create skill (`{name, description, body, triggers[], tools[], scripts[]?}`) — project-local only |
| `POST` | `/api/skills/from-script` | Wrap a raw script as a skill (`{name, description, filename, content}`) — body is auto-generated to instruct LLM to use `run_skill_script` |
| `PATCH` | `/api/skills/:name` | Update description / body / triggers / tools / always_on |
| `POST` | `/api/skills/:name/always-on` | Flip the always-on flag (`{enabled: boolean}`) — project-local skills only |
| `DELETE` | `/api/skills/:name` | Remove the entire skill folder (project-local only) |
| `GET` | `/api/skills/:name/scripts/:filename` | Read a script's content |
| `POST` | `/api/skills/:name/scripts` | Add or overwrite a script (`{filename, content}`); makes it executable |
| `DELETE` | `/api/skills/:name/scripts/:filename` | Remove a script and update the SKILL.md frontmatter allowlist |

---

## Diagnostics

Self-contained checks that exercise live integrations end-to-end.

### `npm run check:claude`

Reports the active Claude backend, binary path/version, OAuth/API-key auth source, and warns when configuration is inconsistent (CLI selected with no binary, API selected with no key, high concurrency on subscription auth, etc.). Exits non-zero when the active backend is unusable.

### `npm run check:memory`

10-test pipeline diagnostic. PASS / WARN / FAIL / SKIP per check; exits non-zero on any FAIL.

| Check | What it verifies |
|---|---|
| `memory_index INSERT` | SQLite write helper |
| `searchMemoryIndex direct hit` | Direct SQLite LIKE search |
| `retrieve() fan-out` | Merged ranking across SQLite + Vault MCP + (optional) ResearchLM/InsightsLM |
| `buildMemoryContextBlock` | Pre-injection block format & length |
| `vault write (MCP)` | NeuroVault `create_file` round-trip |
| `vault search` | NeuroVault `search_vault` returns the just-written note |
| `vault read-back` | NeuroVault `read_file` returns the expected content |
| `saveSessionSummaryTool` | `session_summary` write end-to-end |
| `maybeCompactHistory` | 40-turn synthetic history triggers compaction at threshold |
| `vault cleanup` | All test files written to vault are deleted via `vault_delete_file` |

The diagnostic cleans up after itself: SQLite test rows are dropped at the end, and any vault notes it created are deleted via `vaultDeleteFile`. Re-runnable any time without polluting the vault.

---

## API Reference

All endpoints require `?token=` or `x-dashboard-token`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/status` | Active agents, temp agents, session/message counts |
| `GET` | `/api/claude/status` | Active Claude backend, CLI binary path/version, auth source, queue length, 429s in last hour |
| `GET` | `/api/agents` | All agents (including temp) |
| `POST` | `/api/agents` | Create agent (`name` required) |
| `PATCH` | `/api/agents/:id` | Update agent fields |
| `DELETE` | `/api/agents/:id` | Soft-deactivate; Alfred protected |
| `POST` | `/api/agents/:id/activate` | Re-activate |
| `POST` | `/api/agents/spawn` | Manually spawn a temp agent |
| `POST` | `/api/agents/:id/area` | Set / clear an agent's PARA area (body: `{ area_id: string \| null }`) |
| `POST` | `/api/dream/run` | Manually run the Dream Cycle now. Returns `DreamCycleResult` with scope, output counts, vault paths, errors |
| `GET` | `/api/dream/status` | Schedule config + last 20 dream-cycle hive events |
| `GET` | `/api/skills` | List loaded skills (project + user-global). `?refresh=1` busts the 30s cache; `?full=1` includes the markdown body |
| `GET` | `/api/skills/:name` | Full skill record incl. body + scripts |
| `POST` | `/api/skills` | Create a project-local skill |
| `POST` | `/api/skills/upload` | Upload an existing `SKILL.md` (frontmatter optional) plus optional bundled scripts; lands at `.claude/skills/<name>/`. 409 on duplicate |
| `POST` | `/api/skills/install` | Install a skill via Claude Code CLI or `npx` (`{kind: 'plugin'\|'marketplace'\|'npx', spec}`). Strict regex on `spec`, no shell, 90s timeout, output capped at 64KB |
| `POST` | `/api/skills/from-script` | Wrap a raw script as a callable skill (auto-generates the SKILL.md wrapper) |
| `PATCH` | `/api/skills/:name` | Update description / body / triggers / tools / always_on |
| `POST` | `/api/skills/:name/always-on` | Flip the always-on flag (`{enabled: boolean}`) — injects the skill into every agent's prompt regardless of `agents.skills` |
| `DELETE` | `/api/skills/:name` | Delete the skill folder |
| `GET` | `/api/skills/:name/scripts/:filename` | Read a script's content |
| `POST` | `/api/skills/:name/scripts` | Add or overwrite a script; updates the frontmatter allowlist |
| `DELETE` | `/api/skills/:name/scripts/:filename` | Remove a script |
| `GET` | `/api/areas` | List PARA areas |
| `POST` | `/api/areas` | Create area (`name` required; `icon_glyph`, `color_token`, `sort_order` optional) |
| `PATCH` | `/api/areas/:id` | Update area fields |
| `DELETE` | `/api/areas/:id` | Delete area (agents in it have their `area_id` cleared) |
| `GET` | `/api/vault/tree` | NeuroVault file tree |
| `GET` | `/api/vault/file?path=…` | Read a vault note's content |
| `GET` | `/api/vault/collections` | List vault folders |
| `GET` | `/api/vault/files` | Flat list of all vault files |
| `GET` | `/api/memory/index` | `memory_index` rows; `?type=`, `?sessionId=`, `?limit=` |
| `GET` | `/api/memory/index/stats` | Counts by type, last-hour, last-day, capped, compactions |
| `GET` | `/api/memory/hive` | Memory pipeline events (`memory_extracted`, `memory_skipped`, `memory_capped`) |
| `DELETE` | `/api/memory/index/:id` | Delete a memory_index row (vault note left intact) |
| `GET` | `/api/models` | Live model catalog; `?provider=`, `?tier=`, `?includeUnavailable=1` |
| `POST` | `/api/models/refresh` | Force a `/v1/models` refresh from the provider; `?provider=` |
| `POST` | `/api/models/:provider/:modelId/tier` | Override the auto-classified tier (body: `{ tier: 'low'\|'mid'\|'high'\|null }`) |
| `POST` | `/api/models/:provider/:modelId/price` | Override `$/1k` prices (body: `{ input, output }`; null/null to reset) |
| `GET` | `/api/models/spend` | Last-hour totals + by-tier + by-model breakdowns with estimated $ |
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

### v1.8.1 (Current — Skills dashboard + universal slash commands + always-on skills + skill upload + plugin/npx install + plugin + marketplace skill discovery + per-user Discord voice opt-out + Discord auto-reply audio default-off + Discord text-file intake)

**Every skill Claude Code can natively see — including plugin and marketplace skills — is now usable from VoidAI / OpenAI / Codex agents through NeuroClaw, with the same `/<skill-name>` slash command surface across all providers. Skills are first-class in the dashboard (author / wrap-a-script / upload `SKILL.md` / install via `/plugin` or `npx`), can be flagged **always-on** to inject into every agent's prompt regardless of `agents.skills`, and any skill is one keystroke away in chat. Discord users can finally tell an agent "stop sending audio" and have it stick; auto-reply turns no longer ship `.mp3` attachments unless the user has explicitly opted in; Discord agents can now read plain-text files dropped into chat.**

#### Per-user Discord voice opt-out (bug fix)

Previously the Discord audio gate was purely `bot.voice_enabled AND agent.tts_enabled` — telling the agent in chat to stop sending audio had **zero effect**, because there was no plumbing for the agent to honor it. Fixed in three layers:

- **New table `discord_voice_prefs(bot_id, user_id, voice_enabled, reason, updated_at)`** — primary key on `(bot_id, user_id)`, FK + cascade to `discord_bots(id)`. Resolution order on every reply:
  ```
  bot.voice_enabled = 0           → no audio
  agent.tts_enabled = 0           → no audio
  discord_voice_prefs row exists  → that row's voice_enabled wins
  else                            → audio attached
  ```
  The pref is consulted both **before** the chat call (so the system prompt's `voice_reply_enabled` flag matches reality) and **immediately before** the `.mp3` attach (so a tool call mid-turn takes effect on the same reply).
- **Lightweight NL detector in `discord-bot.ts`** — `detectVoicePrefIntent()` runs against every inbound user message. Conservative regex layer: matches clear toggle phrases (`stop sending audio`, `you don't have to send voice`, `audio off`, `text only`, `mute the audio`, `enable the audio`, `voice on`, `i want voice replies`, etc.) but ignores incidental mentions ("the audio file you sent earlier was great"). On match, it flips the per-user pref **before** routing to the LLM, so the very turn the user objects on is also text-only — no LLM cooperation required. 17/17 hand-curated cases pass.
- **New tool `discord_set_user_voice(bot_id, user_id, enabled, reason?)`** in the unified tool registry — exposed across all four runtimes (OpenAI / VoidAI / Anthropic / Claude SDK / Codex). Lets the agent flip the pref deliberately, e.g. when the user phrases the request in a way the regex misses, or to re-enable audio later. Bot-wide and agent-wide toggles are untouched; only this `(bot, user)` pair is affected.
- **Voice-aware system prompt updated** — when voice is currently enabled for the turn, the agent is told: *"If the user asks you to stop sending audio (or to start again), call `discord_set_user_voice(...)` so the preference sticks. Don't argue — honor the request immediately."* When voice is disabled, the agent is told how to flip it back on.

End result: a single message of "stop sending audio" silences mp3 attachments for that user on that bot from that turn forward, until they ask for it back. Other users are unaffected; the bot's global voice toggle and the agent's TTS config are untouched.

#### Discord auto-reply audio default-off (bug fix)

Discord bots running in **auto-reply mode** (a guild is opted into `auto_reply_guilds`, so the bot answers channel messages without an `@mention`) used to ship `.mp3` attachments on every reply — even when a user hadn't asked for voice and was just chatting with other people in the channel. Result: agents like Oracle would voice-reply unsolicited and there was no obvious way to make it stop.

The audio gate now distinguishes between three trigger types:

| Trigger | Audio attaches when |
|---|---|
| **DM** | bot voice on **AND** agent TTS on **AND** user not opted out |
| **`@mention`** | same as DM |
| **Auto-reply** (channel reply with no `@`) | bot voice on **AND** agent TTS on **AND** user has *explicitly* opted in (`voice_enabled=1` in `discord_voice_prefs`) |

In other words, auto-reply turns now **default to text-only** unless the user has affirmatively asked for voice. The same `voiceReplyEnabled` flag is recomputed pre-turn (so the system prompt's voice guidance matches reality) and post-turn (so a tool call that flips the pref mid-stream takes effect on the same reply). Existing NL detector phrases (`send the audio`, `voice on`, `i want voice replies`) flip the per-user pref to `voice_enabled=1` and re-enable both `@mention` and auto-reply audio for that user.

Combined with the per-user opt-out above, the four-way matrix is: `(no pref · @mention) → audio`, `(no pref · auto-reply) → text-only`, `(opt-out · either) → text-only`, `(opt-in · either) → audio`. Other users in the same channel are unaffected — the pref is keyed by `(bot_id, user_id)`.

#### Discord plain-text file intake

Drop a `.md`, `.txt`, `.json`, `.yaml`, source file (`.ts`, `.py`, `.go`, …), config (`.env`, `.toml`, `.ini`), log, diff, or other plain-text attachment into a Discord channel where a NeuroClaw bot is listening, and the agent now actually **reads** it.

- **Accepted types** (`src/integrations/discord-bot.ts → TEXT_EXTENSIONS` + `text/*` mime prefix): markdown / text / data formats (`md`, `mdx`, `txt`, `rst`, `json`, `jsonc`, `yaml`, `toml`, `xml`, `csv`, `tsv`, `log`, `ini`, `env`, `conf`), source files across most common languages (`ts`, `tsx`, `js`, `py`, `rb`, `go`, `rs`, `java`, `kt`, `swift`, `c`, `cpp`, `cs`, `php`, `sh`, `sql`, `graphql`, `proto`, etc.), HTML/CSS/templating (`html`, `css`, `scss`, `vue`, `svelte`), and miscellaneous text (`patch`, `diff`, `srt`, `vtt`, `ipynb`). Anything advertised as `text/*` MIME also passes; obvious binary (`audio/*`, `image/*`, `video/*`, `application/pdf`, `application/zip`) is rejected even when the extension would otherwise match. A NUL-byte sniff catches binary payloads that lied about their extension.
- **Caps**: `TEXT_FILE_PER_FILE_MAX_BYTES = 200 KB` per file, `TEXT_FILE_TOTAL_MAX_BYTES = 800 KB` per turn. Files over the per-file cap are inlined truncated with a `…[truncated, N more bytes]` marker and a `· truncated` note in the header. Once the total budget is exhausted, remaining files are skipped (a warning lands in the bot logs; users aren't pestered with skip notices).
- **PDFs / OCR / images are out of scope here** — images already flow through the existing vision path; PDF + OCR ingestion is deferred and tracked separately.
- **Delivery to the LLM**: each file becomes a fenced markdown block appended to the user's message, separated by blank lines:
  ```
  [File: notes.md · 1234 bytes]
  ```markdown
  …file contents…
  ```
  ```
  The fence language is mapped from extension via `fenceLanguageFor()` (e.g. `.ts` → `typescript`, `.json` → `json`, `.yaml` → `yaml`). When a file's body itself contains triple backticks, the fence is upgraded to four backticks so embedded code samples can't prematurely close the block. Because the contents are inlined into the user message, this works for **every** provider (VoidAI, Anthropic, Claude CLI, Codex) — no provider-specific file-attachment API needed. A text-file-only message (no typed text, no images) is now a valid turn: the appended fenced block populates `text` and the existing empty-message guard naturally lets it through.

End result: paste a config file, a stack trace, a log excerpt, or a markdown spec into Discord and ask the agent about it directly — no copy-paste of file contents into the message body required.

#### Skills upload + plugin install

Two new top-bar actions on the `Skills` tab let you bring in skills you didn't author from scratch:

- **Upload SKILL.md** (`POST /api/skills/upload`) — pick a `.md`/`.markdown` file (or paste the contents), and the dashboard lands it at `.claude/skills/<name>/SKILL.md`. Frontmatter is optional: when present, a tiny inline parser pulls `name`, `description`, `triggers`, `tools` (same minimal `key: value` / inline `[a, b, c]` grammar that `skill-loader.ts` uses) and the body is rebuilt by `createSkill()` so you never get a double-frontmatter file. Final name resolves in this order: explicit `name` arg → frontmatter `name:` → `filename` stripped of `.md`/`.markdown` → 400. Optional `scripts: [{filename, content}]` lands bundled scripts under `<skill>/scripts/`. Duplicate name → **409 Conflict** (delete the existing one first or rename the upload). The modal sniffs the frontmatter `name:` client-side so you can preview the eventual skill name before submitting.
- **Install Skill** (`POST /api/skills/install`) — three install kinds, each gated by a strict regex on `spec` and shelled out via `child_process.spawn` with `shell: false` (no command injection surface), a 90-second timeout (`SIGKILL` on overrun), and stdout/stderr capped at 64KB each:
  - `kind: 'plugin'` → spawns `claude plugin install <spec>` where `spec` matches `^[a-z0-9][a-z0-9._-]{0,80}(@[a-z0-9][a-z0-9._-]{0,80})?$` (e.g. `skill-creator@claude-plugins-official`, `claude-mem`, `frontend-design@claude-plugins-official`).
  - `kind: 'marketplace'` → spawns `claude plugin marketplace add <owner/repo>` where `spec` matches `^[a-z0-9][a-z0-9._-]{0,80}\/[a-z0-9][a-z0-9._-]{0,100}$` (e.g. `mksglu/context-mode`, `thedotmack/claude-mem`).
  - `kind: 'npx'` → splits on whitespace and spawns `npx <pkg> [--flags]` where `spec` matches `^[@a-z0-9][@a-z0-9._/-]{0,120}(\s+--[a-z0-9][a-z0-9-]{0,40})*$` — only `--flag`-style args (no values, no shell metacharacters) are allowed (e.g. `get-shit-done-cc --claude --global`).
  - On exit the response is `{ok, exit_code, stdout, stderr, duration_ms, command}`. ENOENT on the `claude` binary returns a clear "binary not found" error listing every directory checked, rather than a cryptic spawn failure. `clearSkillCache()` runs after every invocation (success or fail) so the dashboard's next live-data tick picks up any new skills automatically.
- **Binary resolver (bug fix)** — `tsx watch` strips the user's login `PATH` and only puts `node_modules/.bin` on it, so `spawn('claude', …)` would return `ENOENT` even when the binary existed at `~/.local/bin/claude`. The install handler now resolves the binary via a candidate walk: `$CLAUDE_CLI_PATH` (if set in `.env`) → `~/.local/bin/<name>` → `~/.npm-global/bin/<name>` → `/usr/local/bin/<name>` → `/usr/bin/<name>` → `/opt/homebrew/bin/<name>`, falling back to the bare name so the original `PATH` lookup still happens for unusual setups. First match wins. The same resolver covers `npx` for `kind: 'npx'` invocations. Set `CLAUDE_CLI_PATH=/path/to/claude` in `.env` for non-standard install locations.
- **Audit trail** — every install is logged via `logAudit('skill_install_command', 'skill', undefined, { kind, spec, exit_code, duration_ms })` so installs are auditable from `audit_logs`.
- **UI** — the install modal has a kind dropdown, a spec input, per-kind regex hints, and a one-click cheat-sheet of common installs (`/plugin install skill-creator@claude-plugins-official`, `npx get-shit-done-cc --claude --global`, etc.) that pre-fill kind + spec but don't auto-submit so you can review before running. Streams the assembled stdout/stderr back into a `<pre>` block; on success calls `window.NC_LIVE.refresh()` so the new skill appears in the catalog without a manual refresh.

#### Skills

- **`Skills` tab in the v2 dashboard** (`src/dashboard/v2/src/page-skills.jsx`) — full CRUD for project-local skills (`.claude/skills/<name>/`):
  - **+ New Skill** form: name (lowercase-dash), description, markdown body, triggers (CSV), allowed-tools (CSV).
  - **Script → Skill** form: paste a raw shell / python / node script, give it a name + a filename — the dashboard writes the script to `<skill>/scripts/<filename>` (chmod +x), and auto-generates a wrapper `SKILL.md` that tells the LLM to invoke it via `run_skill_script(skill_name, script, args=[...])`. Lets you take any existing utility script and make it universally callable.
  - **Per-skill expand**: view the full markdown body, list attached scripts, add new scripts (filename + content textarea), or remove scripts. The `SKILL.md` frontmatter allowlist is kept in sync.
  - **Source-tagged**: skills under `~/.claude/skills/` are shown read-only with a violet `user` tag; project skills get a cyan `project` tag and the edit/delete controls.
  - Live-wired to `window.NC_DATA.SKILLS` via the existing `live-data.jsx` refresh loop, so newly created skills appear automatically without a manual reload.
- **Slash commands in chat** (`src/dashboard/v2/src/page-chat.jsx`) — type `/` to open an autocomplete popup of every loaded skill, narrowed by prefix as you type. **Tab** or **Enter** (before an exact match) inserts `/<name> `. On send, `expandSlashCommand()` rewrites the message **client-side** into the full prompt:
  ```
  /<name> [args]   →   [Skill activated: /<name>]
                       <skill body>

                       ---

                       <args>
  ```
  Because the expansion is in the user message itself, slash commands work universally — every backend (VoidAI / Anthropic / Claude CLI / Codex CLI) receives the skill body in the same place, regardless of whether the chosen agent has the skill in its declared list. The visible chat bubble keeps the literal `/foo bar` the user typed, plus a `/skill-name` chip in the header so it's clear which skill was activated.
- **9 new REST endpoints** under `/api/skills/*` (full table above): one-shot create, update, delete, per-script read/write/delete, and the `from-script` wrapper. All pass through `skill-loader.ts`'s existing guardrails — only `.claude/skills/` is writable, names are sanitized to `[a-z0-9-]{1,64}`, script filenames are validated against path-traversal, and `getSkillScriptPath()` double-checks the resolved path stays inside the skill folder.
- **`GET /api/skills?full=1`** — opt-in body inclusion so the new dashboard slash-command client can do the inline expansion without an extra fetch per skill.
- **No agent or runtime changes** — the existing manual-selection skills loader and `buildSkillsBlock()` flow from v1.5.1 stays exactly as-is. Slash commands are a pure-client overlay; declared `agents.skills` still get auto-injected on every turn for that agent.
- **Sidebar wiring**: new `skills` icon in `icons.jsx`, new entry under SYSTEM in `data.jsx`, page registration in `app.jsx`, script tag in `NeuroClaw.html`. The route registration order in `routes.ts` puts the literal `/api/skills/from-script` ahead of `:name` patterns to avoid Hono router shadowing.

#### Always-on skills

Some skills are useful to **every** agent — a "house style" guide, a "common bash idioms" cheat-sheet, a memory-tool primer. Rather than adding them to every agent's `agents.skills` JSON column, mark the skill itself as always-on and the loader injects it into every agent's system prompt at chat time.

- **Frontmatter field**: add `always_on: true` to a `SKILL.md`. The minimal frontmatter parser accepts `true`, `'true'`, `1`, or `'1'`. Default is `false`. When `false`, the line is omitted from `buildFrontmatter()` output to keep simple skills clean.
- **Effective skill resolution**: `resolveEffectiveSkillNames(declared)` (in `src/skills/skill-loader.ts`) unions an agent's declared list with `getAlwaysOnSkillNames()`, de-duplicated, with the agent's declared order preserved and always-on names appended. Every `chatStream*` path in `src/agent/alfred.ts` (OpenAI/VoidAI, Anthropic API, Claude CLI, Codex CLI) now calls `buildSkillsBlock(resolveEffectiveSkillNames(parseAgentSkills(agentRecord?.skills)))` so the always-on bodies show up in **every** agent's system prompt regardless of `agents.skills`.
- **Toggle endpoint**: `POST /api/skills/:name/always-on` with body `{enabled: boolean}` flips the flag without re-sending the entire skill. Returns the updated `SkillSummary` (now includes `always_on`). 404 when the skill doesn't exist; 400 (with the underlying error message) when the skill is user-global — `updateSkill()` rejects writes outside `.claude/skills/`.
- **Dashboard UI**: each skill card on the Skills tab now shows an `ALWAYS ON` green chip when active, plus an `Always on` / `Always off` button (disabled with a tooltip for user-global skills). The `+ New Skill` and `Edit` modals have an `Always on` checkbox so the flag round-trips through every authoring path. Above the catalog, a small `always-on: /skill-a, /skill-b` status pill lists the currently-active set.
- **Limitation**: only project-local skills (`.claude/skills/`) can be flipped. User-global skills (`~/.claude/skills/`) are read-only by design — copy them under `.claude/skills/` if you need them always-on.

#### Plugin + marketplace skill discovery — universal across all providers

The skills loader used to scan only `.claude/skills/` (project-local) and `~/.claude/skills/` (user-global), which meant skills installed via Claude Code's plugin system were invisible to NeuroClaw's non-Claude agents. A user could `/plugin install superpowers@claude-plugins-official` and Claude CLI agents would see all 14 superpowers skills natively, but a VoidAI gpt-4.1 or Codex agent running through NeuroClaw saw nothing — so a `/test-driven-development` slash command would fall back to the literal text instead of expanding into the skill body.

The loader now walks **four roots** in priority order, with first-writer-wins on name collision so user overrides always shadow upstream skills:

| # | Source | Path | Read-only? | Tag color |
|---|---|---|---|---|
| 1 | `project` | `.claude/skills/<name>/SKILL.md` | no — fully editable | cyan |
| 2 | `user` | `~/.claude/skills/<name>/SKILL.md` | yes | violet |
| 3 | `plugin` | `<installPath>/skills/<name>/SKILL.md` from `~/.claude/plugins/installed_plugins.json` | yes | amber |
| 4 | `marketplace` | `~/.claude/plugins/marketplaces/<m>/{plugins,external_plugins}/<p>/skills/<n>/SKILL.md` | yes | green |

- **`'plugin'` source** (`walkInstalledPlugins`) reads `~/.claude/plugins/installed_plugins.json`, iterates each entry's `installPath`, and walks `<installPath>/skills/`. Only plugins explicitly listed in the manifest are loaded — cached-but-not-installed plugins are correctly excluded. Each loaded skill is tagged with the `<plugin>@<marketplace>` id (e.g. `superpowers@claude-plugins-official`) and exposed on `SkillRecord.plugin` and `SkillSummary.plugin`.
- **`'marketplace'` source** (`walkMarketplaceSkills`) walks every marketplace's `plugins/` and `external_plugins/` subfolders for any `skills/<n>/SKILL.md`. This picks up plugins that ship as part of a marketplace bundle even when the user hasn't run `/plugin install` for that specific one — e.g. `discord:access`, `mcp-server-dev:build-mcp-server`, `frontend-design`, `skill-creator`, `math-olympiad`, etc. Same `<plugin>@<marketplace>` tagging.
- **Universal across providers** — every chat path in `src/agent/alfred.ts` (OpenAI/VoidAI, Anthropic API, Claude CLI, Codex CLI) calls the same `buildSkillsBlock(resolveEffectiveSkillNames(parseAgentSkills(agent.skills)))` flow. The skill body lands in the system prompt for declared / always-on skills, and `/<skill-name>` slash commands inline the body into the user message client-side before the API call. So a Codex agent on `gpt-5.5` and a VoidAI agent on `gpt-4.1` see exactly the same skill catalog as a Claude CLI agent — including plugin + marketplace skills.
- **Dashboard** — plugin and marketplace skills appear in the Skills tab tagged with their source color and the `<plugin>@<marketplace>` id next to the skill name. They're read-only (no Edit/Delete/Always-on toggle) — to customize one, copy its `SKILL.md` to `.claude/skills/<name>/` and the project copy automatically shadows the upstream original.
- **Live counts on this machine** as of v1.8.1 ship: 6 project + 65 user + 14 plugin + 20 marketplace = **105 skills** universally available, up from 2 at session start.

### v1.8 (Voice: TTS + STT across dashboard and Discord)

**Audio in two directions, two providers, three surfaces.**

- **Two TTS providers behind one entry point** (`src/audio/tts.ts → synthesize()`) — VoidAI's OpenAI-compatible `/audio/speech` (voices: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`) and ElevenLabs (any voice from the user's library, including cloned voices) via `POST /v1/text-to-speech/{voice_id}` with `xi-api-key`. Provider is per-agent, so one specialist can be VoidAI/`alloy` and another can be ElevenLabs with a cloned voice — picked from the dashboard or by the agent itself via the new tools.
- **Whisper transcription** (`src/audio/transcribe.ts`) — VoidAI's OpenAI-compatible `/audio/transcriptions` over multipart form data. Native `fetch` + `FormData` + `Blob`, no `form-data` dep. Hard caps via `AUDIO_MAX_MB` (default 25) and `AUDIO_MAX_TTS_CHARS` (default 4000).
- **Auto-transcoding for unfriendly formats** (`src/audio/transcode.ts`) — VoidAI's Whisper rejects `.ogg` even though OpenAI's reference Whisper accepts it, and Discord's voice notes ship as Ogg-Opus. The pipeline detects unsupported containers and remuxes Ogg-Opus → WebM-Opus with `ffmpeg -c:a copy` (zero re-encode, lossless), or re-encodes to mp3 as a universal fallback. `ffmpeg-static` bundles the binary so installs work without system ffmpeg.
- **Per-agent voice columns** (`agents.tts_enabled`, `agents.tts_provider`, `agents.tts_voice`) and **per-bot voice toggle** (`discord_bots.voice_enabled`). Both gates must be `1` for Discord to attach an `.mp3` to a reply. Migrations are additive — existing agents/bots default to off.
- **Dashboard chat voice surfaces** (`page-chat.jsx`):
  - **🎤 Mic button** uses `MediaRecorder` (Opus-in-WebM by default), POSTs the blob to `/api/audio/transcribe`, fills the chat input with the transcript so you can edit before sending.
  - **🔊 Speaker button** on every assistant message hits `POST /api/audio/speak` with `{text, agentId}`, plays the returned audio inline, toggles to ■ to stop.
- **Dashboard agents page** (`page-agents.jsx`) — voice section in the agent editor: enable toggle, provider dropdown (ElevenLabs disabled if `ELEVENLABS_API_KEY` is unset), voice dropdown populated from `/api/audio/voices` (VoidAI static + ElevenLabs cached for 5 min).
- **Dashboard channels page** (`page-channels.jsx`) — `🔊 Voice on/off` button per Discord bot, gating outbound audio attachment.
- **Discord audio in/out** (`src/integrations/discord-bot.ts`):
  - **Inbound:** any `audio/*` attachment is downloaded, transcoded if needed, transcribed, and prepended to the user's text message before routing to the agent. Multiple voice notes are concatenated in attachment order.
  - **Outbound:** when `bot.voice_enabled=1 AND agent.tts_enabled=1`, the bot synthesizes the agent's text reply and posts it as a `.mp3` attachment in a follow-up message. Text reply still goes first so users in noisy environments aren't blocked on synthesis.
- **Voice-aware system prompt** — `DiscordTurnContext.voice_reply_enabled` is computed at the call site and threaded through the chat API into the system prompt. When voice is enabled, the agent is told *"your text reply WILL be auto-synthesized to speech and attached as an .mp3 — write naturally, avoid long code blocks, ASCII tables, or markdown that doesn't translate to audio."* This prevents the *"I'm a text-only LLM, I can't speak"* hallucination when users ask the agent if it can do voice.
- **API endpoints** (token-protected like all `/api/*`):
  - `GET /api/audio/voices?provider=voidai|elevenlabs` — picker payload, both providers when omitted.
  - `POST /api/audio/transcribe` — multipart `file` field, returns `{text, model}`. Hard size cap.
  - `POST /api/audio/speak` — `{text, agentId?, provider?, voice?, format?}` → audio stream with `X-Tts-Provider` and `X-Voice-Id` response headers. Falls back to env defaults when no agent is passed.
- **Four new agent-callable tools** (registry, all four runtimes):
  - `audio_list_voices(provider?)` — VoidAI static + ElevenLabs library (when keyed).
  - `audio_status(agent?)` — current voice config for one agent or for every agent + bot.
  - `audio_configure_agent(agent, enabled, provider?, voice?)` — flip the agent's TTS in one call.
  - `audio_configure_discord_bot(bot, enabled)` — flip the bot's voice toggle (reload manager triggered).

  Lets a user say *"set up voice for Oracle on Discord"* and have Alfred walk them through it: list voices, pick one, configure both gates, confirm. No dashboard click-through required.
- **Env vars added:** `VOIDAI_TTS_MODEL` (`tts-1`), `VOIDAI_TTS_VOICE` (`alloy`), `VOIDAI_TRANSCRIBE_MODEL` (`whisper-1`), `ELEVENLABS_API_KEY`, `ELEVENLABS_BASE_URL`, `ELEVENLABS_DEFAULT_VOICE_ID`, `ELEVENLABS_MODEL` (`eleven_turbo_v2_5`), `AUDIO_MAX_MB` (`25`), `AUDIO_MAX_TTS_CHARS` (`4000`).
- **No new core deps** — `ffmpeg-static` is the only addition; native `fetch`/`FormData`/`Blob` cover the rest. discord.js attaches buffers natively.

### v1.7 (Codex + Unified Tool Registry + Composio + Memory upgrades + Discord bot)

**Discord-as-frontend bot (chat with NeuroClaw via Discord)** — multi-bot, dashboard-managed, agent-self-provisioned

- **Multi-bot manager** (`src/integrations/discord-bot.ts`, ~350 LOC). Each row in the new `discord_bots` table is its own gateway connection — its own bot token, its own identity (avatar/name/status from the Discord Developer Portal), its own channel routes. Manager polls every 30s for adds/removes/edits and starts/stops gateway clients accordingly. Auto-starts in the dashboard process; each bot's gateway errors are caught and logged without crashing the dashboard.
- **DB-backed config** — two new tables:
  - `discord_bots` — `id, name, token, application_id, default_agent_id, enabled, status, status_detail, bot_user_id, bot_user_tag, created_by_agent_id, …`. Status (`idle | connecting | ready | error | disabled`) is written back live so the dashboard shows real connection state.
  - `discord_channel_routes` — `bot_id × channel_id → agent_id`. UNIQUE per `(bot_id, channel_id)`. Cascade-delete with the bot.
- **Three ways to set up a bot:**
  1. **Dashboard `Channels` page** — add bot button, paste token, pick default agent, expand to add per-channel routes, see live status. ~150 LOC of JSX (`page-channels.jsx`).
  2. **REST API** — `GET/POST/PATCH/DELETE /api/discord/bots`, `POST /api/discord/bots/:id/routes`, `DELETE /api/discord/routes/:id`. Tokens masked in list responses.
  3. **Agent self-setup** (OpenClaw-inspired) — four new tools in the unified registry: `discord_register_bot`, `discord_add_channel_route`, `discord_list_bots`, `discord_remove_bot`. Just tell Alfred *"Create a Discord bot called 'Coder Bot' with token MTk... and default to the Coder agent, then route channel 1234567890 to Researcher"* — Alfred calls the tools, the manager picks them up within 30s, the bot connects. All four runtimes (OpenAI / Anthropic / Claude SDK / Codex CLI) get these tools automatically through the registry.
- **Backwards-compatible env migration** — if `DISCORD_BOT_TOKEN` is set in `.env` but no `discord_bots` rows exist, the manager seeds one from env on first boot. After that the DB is the source of truth; env is ignored.
- **Per-`(bot, channel, user)` sticky sessions** so the agent keeps context across @mentions, even with multiple bots active in the same channel.
- **`src/integrations/discord-bot.ts`** — standalone `discord.js` bot, ~350 LOC. Listens for `@bot` mentions in any guild channel + all DMs, strips the mention prefix, calls `/api/chat` over SSE, posts the assembled response back. Long replies split paragraph-aware to fit Discord's 2000-char per-message cap.
- **Distinct from the Composio Discord toolkit.** Composio = agents POST to Discord (action surface, shipped earlier in v1.7). This bot = users CHAT with NeuroClaw via Discord (frontend). They're complementary — when a user pings the bot, the agent's reply can still call Composio tools to take actions.
- **Per-channel agent routing** — `DISCORD_CHANNEL_ROUTES='{"123":"Coder","456":"Researcher"}'` maps channel id → agent name (or id). Falls back to `DISCORD_DEFAULT_AGENT` (default `Alfred`).
- **User allowlist** — `DISCORD_ALLOWED_USERS=id1,id2` for private bots; empty = open to everyone in the channel.
- **Sticky per-channel sessions** — same NeuroClaw session reused for all `@mention` turns in a `(channel, user)` pair so the agent keeps context across messages.
- **Run standalone:** `npm run bot:discord` (or `bot:discord:watch` for hot-reload). Decoupled from the dashboard process so it can be restarted independently.
- **Inspired by OpenClaw's Discord channel plugin (49k LOC) — distilled to ~350 LOC.** We dropped voice channels, slash-command catalogs, security audit contracts, thread monitors, and the multi-account SecretRef system, but kept the parts that matter: per-bot identity isolation, agent-self-provisioning, dashboard-managed channel routes, live status feedback. What's left is the inbound chat bridge — exactly the part that solves "I want to talk to NeuroClaw from Discord with multiple bots, each routed to different agents."

**Composio (1000+ external app toolkits via hosted MCP)**

- **`@composio/core`** + `src/composio/client.ts` (session cache + toolkit catalog + connected-account list). Per-user identity (`composio.create(userId)`) returns a hosted MCP URL + headers we plug into every runtime.
- **Per-agent identity + toolkit gating** — three new `agents` columns: `composio_enabled`, `composio_user_id`, `composio_toolkits` (JSON array; null = all). One agent posts to YOUR Discord, another to a team Discord; Coder gets GitHub+Linear, Alfred gets Gmail+Discord — without dumping 1000+ tools into every agent.
- **All four runtimes wired:** OpenAI/VoidAI/Anthropic-API via `tools/adapters/composio.ts` (lists tools via `mcp-client.ts`, dispatches with session bearer headers); Claude Agent SDK via `mcpServers: { composio: { type: 'http', url, headers } }`; Codex CLI via `syncComposioInCodexConfig()` writing a `[mcp_servers.composio]` block with `http_headers` per chat turn.
- **Dashboard:** v2 agent edit modal gets a Composio section (enabled toggle, `composio_user_id` input, multi-select toolkit chips). Toggle disabled when `COMPOSIO_API_KEY` is unset; status surfaced via `/api/composio/status`. Endpoints: `/api/composio/{status,toolkits,connected/:userId}`.
- **Graceful degradation:** when `COMPOSIO_API_KEY` is unset everywhere fails closed — no agents see Composio tools, no errors leak into the chat path.

**Codex CLI provider — full parity with Claude CLI**

- **`src/providers/codex-cli.ts`** — spawns `codex exec --json --skip-git-repo-check -m <model>`, streams `item.completed` JSONL events as text chunks, captures `turn.completed.usage` for token + cost reporting. Concurrency-gated (default 1) so subscription auth doesn't trip per-window limits. `OPENAI_API_KEY` is scrubbed from the child env so subscription OAuth from `~/.codex/auth.json` is the only auth path.
- **ChatGPT-subscription model allowlist** — empirically verified: only `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2` work via subscription auth. Everything else (`gpt-5`, `gpt-5-codex`, `o3`, `gpt-4o`, `gpt-4.1`, etc.) returns *"The 'X' model is not supported when using Codex with a ChatGPT account"* — those are paid-API only. `refreshCodex()` in `src/system/model-catalog.ts` seeds only the four working models.
- **Nested error extraction** — Codex emits errors as `turn.failed` events on stdout (not stderr) with deeply nested string-encoded JSON. `extractMessage()` walks the structure recursively so users see the actual provider error instead of `[object Object]`.
- **Codex agents skipped from heartbeat** — subscription quota would burn on every interval; matches the existing claude-cli skip rule.

**Unified Tool Registry**

- **`src/tools/registry.ts`** — single source of truth for all 18 NeuroClaw tools (memory, vault, agent comms, spawning, exec). Each entry is `{ name, description, schema (zod), shape, gate?, handler }`. Gates filter listings *and* short-circuit dispatch with a clear error.
- **Three thin adapters** — `tools/adapters/openai.ts` (function-calling JSON Schema), `tools/adapters/claude-sdk.ts` (`createSdkMcpServer` wrapping), `tools/adapters/http-mcp.ts` (Streamable-HTTP MCP for external clients). Adding a new tool means editing the registry only — all four runtimes pick it up automatically.
- **`src/agent/alfred.ts` lost ~600 lines** — the old in-line `buildTools()` and `executeTool()` (with their three duplicated tool definitions and dispatch switches) are gone. Replaced by `buildOpenAiTools(ctx)` and `dispatchOpenAiTool(name, argsStr, ctx)`.
- **`src/mcp/neuroclaw-mcp-server.ts` is a 6-line re-export** — kept at the original path so import sites don't need to change.

**HTTP MCP endpoint (Codex bridge)**

- **`POST /mcp` on the dashboard server** — Streamable-HTTP MCP transport (`StreamableHTTPServerTransport`). Stateless mode (`sessionIdGenerator: undefined`) — no init handshake required. Bearer-auth via `DASHBOARD_TOKEN`.
- **`src/system/codex-config-writer.ts`** — idempotently injects `[mcp_servers.neuroclaw]` into `~/.codex/config.toml` on dashboard boot, with `default_tools_approval_mode = "approve"` so non-interactive `codex exec` works end-to-end.
- **Verified:** `codex exec -m gpt-5.5` calls `list_agents` and gets live SQLite data back without bypass flags.

**Memory: hybrid retrieval = vector cosine + FTS5 lexical**

- **`memory_index_fts`** — SQLite FTS5 virtual table mirroring `memory_index.{title, summary, tags}` with `tokenize = 'porter unicode61'`. Triggers (`AFTER INSERT/UPDATE/DELETE`) keep it in sync; backfill on first run picks up pre-existing rows.
- **Replaced the old `LIKE %query%` lexical pass with BM25-ranked FTS5 search.** "configures" matches "Configure", multi-token queries get TF-IDF scoring. The retriever's existing two-pass design (vector cosine + lexical, merged + dedup) becomes proper hybrid retrieval — the production pattern that beats vector-only across most real-world tasks.
- **Ranking blend:** `(-bm25 × 1.0) + salience × 0.5 + importance × 0.3` so semantically-strong-but-stale memories don't always beat fresher ones.
- **Graceful fallback** to LIKE path when FTS5 is unavailable. Query sanitizer strips FTS5 operators (so `"hold("` doesn't blow up the parser); trailing `*` for prefix matching ("compos" → "Composio").

**Memory: real embeddings + graph-lite**

- **Vector embeddings on `memory_index`** (Mem0-inspired) — every memory write generates a `text-embedding-3-small` vector (1536-dim Float32, packed as 6 KB BLOB on the row). Two-pass merge: cosine-rank rows that have embeddings (≥0.30 threshold), then FTS5 lexical for legacy/short rows. Gated by `MEMORY_EMBEDDINGS_ENABLED`.
- **Why no vector DB?** SQLite handles BLOBs natively; cosine in JS over a candidate set is 0.5–2s per query for sub-10k memories. Zero new infra. `sqlite-vec` is the documented escape hatch when traversal queries get expensive.
- **Graph-lite — entities + relationships per memory** (Graphiti-inspired, no Neo4j). Extractor's JSON schema also returns `entities[]` (canonical names) and `relationships[]` (subject/verb/object triples). One LLM call. Persisted to two new SQLite tables (`memory_entities`, `memory_relationships`) with `valid_from`/`valid_to` for bitemporal validity.
- **Graph queries via SQL JOINs** — `findMemoriesByEntity('Composio')`, `findRelationshipsForEntity('NeuroClaw')`, `topEntities()`. Milliseconds at our scale.

**Heartbeat improvements**

- **Fixed cheap model** (`HEARTBEAT_MODEL`, default `gpt-4.1`) overrides per-agent pinned models so heavyweight models don't generate 30+ second heartbeats. `PREFERRED_VOIDAI` cascade as fallback.
- **Consecutive-fail dampening** — `FAIL_THRESHOLD = 3` so single transient timeouts stay quiet. Eliminates FAIL→recovered flapping.
- **30s timeout** so a hung VoidAI cold-route doesn't keep the scheduler open. Codex agents and Claude CLI agents skipped (subscription quota awareness).

**Other**

- **`deleteAgentHard()`** — drop an agent permanently (vs `deactivateAgent()` which just sets `status='inactive'`). Used by the dashboard's `×` button.
- **Dashboard `live-data.jsx`** — per-fetch `AbortController` 10s timeout + `Promise.allSettled` so a single slow endpoint can't stall the v2 sidebar.

#### Design philosophy — *absorb, don't depend*

> **Tools are organs. Architecture is the body. Principles are the DNA.**
>
> Absorb what is useful. Reject what is brittle. Adapt what fits. Build your own expression.

NeuroClaw is built to *absorb* memory / agent / RAG / channel patterns from whatever ships next, not to depend on any one tool. Mem0, OpenClaw, Graphiti, Codex CLI, Claude Agent SDK, the OpenAI Agents SDK, Composio, discord.js, Langfuse — none of them are foundations. They're sources to mine for principles, then re-express through our own interfaces (the unified tool registry, the memory pipeline, the four-runtime adapter pattern, the per-channel routing model). When a better extractor / reranker / graph engine / channel SDK ships next year, the *interface* stays; the *implementation* swaps without touching the rest.

| Pattern | Inspired by | NeuroClaw expression |
|---|---|---|
| Triage → Recall → Dream | Mem0 | `memory-pipeline.ts` extractor + `buildMemoryContextBlock()` + `dream-cycle.ts` |
| Auto entity / relationship extraction with temporal validity | Graphiti | Extractor's JSON schema + `memory_entities` / `memory_relationships` tables |
| Hybrid retrieval (BM25 + vector) | RAG production patterns | FTS5 + cosine merge in `memory-retriever.ts` |
| Single tool registry, many runtimes | OpenClaw plugin slots, MCP protocol | `src/tools/registry.ts` + three thin adapters |
| HTTP MCP for external clients | Codex CLI's `mcp_servers` config | `src/dashboard/mcp-route.ts` + `codex-config-writer.ts` |
| Discord channel plugin model | OpenClaw's `extensions/discord/` | `src/integrations/discord-bot.ts` (49k LOC → 250 LOC) |
| Per-user identity for tool integrations | Mem0 `userId`, Composio `composio.create(userId)` | `agents.composio_user_id` (and the v2 `agents.memory_user_id` plan) |
| Subscription-auth model allowlists | OpenClaw's `isModernCodexModel()` | `refreshCodex()` seed in `model-catalog.ts` |

**Dependencies we've *avoided* (so far) and the trigger that would change our mind:**

| Avoided | Trigger to revisit |
|---|---|
| Hosted Mem0 | Multi-tenant SaaS need with managed ACLs / encryption / cross-region |
| Postgres + PGVector migration | SQLite cosine becomes the bottleneck (~100k+ memories per user) OR multi-process concurrent writers OR cross-region replication |
| Neo4j | `memory_relationships` traversals need 3+ recursive CTEs OR the graph crosses ~50k edges OR Cypher's pattern-matching power is genuinely required |
| Graphiti the tool | Naive single-pass extractor produces duplicate entities or wrong-but-newer relationships at a rate the dream cycle can't fix |
| OpenAI Agents SDK | Probably never — adopting it means rewriting our agent runtime; we'd lose hive-mind hooks, langfuse spans, spawn evaluation, model triage |
| n8n inside the agent loop | Probably never — n8n is for cron / webhook / sync jobs, not for the reasoning loop |
| Document Q&A surface (PyMuPDF / Docling / chunked vault embeddings) | Chat agents need detail-level recall from long documents that summary-level memory can't carry. Currently a separate product layer (ResearchLM) |

### v1.6 (Dream Cycle)

- **`runDreamCycle()`** — full 8-step nightly consolidation: gather → per-session LLM analysis (JSON-mode) → episodic→semantic/procedural transform → semantic dedupe (token Jaccard) → conservative prune → next-day plan LLM → vault writes inline → hive logs throughout. ~8s for 2 sessions / 20 messages on a warm cache.
- **Scheduler** — `setTimeout`-chain fires at `DREAM_RUN_TIME`, then re-schedules 24h later. No external cron. Survives clock drift; gracefully degrades when `DREAM_ENABLED=false`.
- **`POST /api/dream/run`** — manual trigger, returns the full result object. **`GET /api/dream/status`** — schedule + recent events.
- **8 new hive actions** — `dream_cycle_start` / `_complete` / `_failed`, `memories_created` / `_promoted` / `_merged` / `_pruned`, `procedures_created`, `plan_created`.
- **`plan` type added to vault folder routing** — plans now land in `logs/` not `default/`.

### v1.5.1 (stabilization)

- **Skills loader** — manual selection only (no auto-routing). `agents.skills` JSON column. `src/skills/skill-loader.ts` walks `.claude/skills/*/SKILL.md` (project-local + user-global, project wins on collision). 30s cache. Dashboard agent editor has a chip-style toggle picker.
- **Cross-SDK spawn parity** — `spawn_agent` and `list_temp_agents` added to the in-process MCP server; Claude CLI agents can now spawn temp sub-agents (depth penalty + budget guard + soft/hard limits all apply uniformly).
- **`npm run check:memory`** — 10-test diagnostic covering SQLite write, retrieval, pre-injection, vault round-trip, session summary, compaction. Self-cleans local rows AND vault files via new `vaultDeleteFile`.
- **`vaultDeleteFile`** — wraps the live MCP `delete_file` tool; usable from anywhere we already wrap vault ops.
- **Dashboard skill picker** — `GET /api/skills` and a multi-select chip UI on the agent edit modal in v2.

### v1.5

**Memory Intelligence**
- **Auto-extractor** — every assistant turn ≥200 chars runs an LLM-backed classifier into `episodic` / `semantic` / `procedural` / `preference` / `insight`, with a 5-component importance score. Drops below `MEMORY_IMPORTANCE_THRESHOLD` or when not "memorable."
- **Write pipeline** — dedupe (title+type+agent within 7d) → `memory_index` → vault mirror; per-session and per-hour caps with no data loss (over-cap stays in SQLite).
- **Retriever fan-out** — SQLite + Vault MCP + optional ResearchLM/InsightsLM merged, dedup'd, ranked by `salience × decay × 0.6 + importance × 0.4` (14d half-life decay).
- **Memory pre-injection** — every chat turn gets the top-N relevant memories pasted into the system prompt before the model sees the user message. Works on every backend including Claude CLI.
- **Auto context compaction** — at 30 turns / 8k tokens, prior turns are summarized via LLM, persisted as a `session_summary` memory, and replaced in-place with summary + relevant memories.
- **Memory tab on dashboard v1** — full `memory_index` viewer with importance/salience badges, vault path, type filter, recent extraction events feed.

**Cross-SDK Tool Surface**
- **In-process MCP server** (`src/mcp/neuroclaw-mcp-server.ts`) exposes 11 NeuroClaw tools to the Claude Agent SDK. Claude CLI agents now natively call `search_memory`, `write_vault_note`, `message_agent`, `assign_task_to_agent`, `compact_context`, etc. — no subprocess, no IPC.
- **Auto-approved tools** — `allowedTools` pre-approves all `mcp__neuroclaw__*` so the user-permission prompt never fires for our own surface.

**Model Triage**
- **Heuristic classifier + decision cache + cascade-depth penalty + budget guard + borderline LLM escalation** in `src/system/model-triage.ts` — sub-agents auto-pick a tier from the live VoidAI catalog per task. Real token + cost usage captured from all three SDK paths.
- **Live VoidAI catalog** — 105 models auto-tiered, $/1k prices seeded from regex table, `/api/models/spend` joins for real-$ analytics.

**Exec & Provider**
- **Exec tools per-agent** — `bash_run`, `fs_read`, `fs_write`, `fs_list`, `fs_search`, gated by `agent.exec_enabled` (off by default). Default-allow shell with hard-deny denylist for catastrophic commands. Env-key scrubbing on every child process.
- **Claude CLI subscription auth** — `CLAUDE_BACKEND=claude-cli` routes Claude calls through the local `claude` binary using your Pro/Max subscription. No silent fallback to API. Concurrency gate, 429 backoff, hive-logged throttling.

**Dashboard**
- **v2 dashboard preview** at `/dashboard-v2` — 16-page neon command center (Overview, Chat with SSE, Agents, PARA Map, Tasks, Sessions, Memory, NeuroVault, Dream Cycle, Hive Mind, Comms, MCP Tools, Providers, Analytics, Logs, Settings). Live-wired to all `/api/*` endpoints; lives alongside v1 until full cutover.
- **Live model picker in agent edit form** — populated from `/api/models?provider=voidai`, grouped by tier, with `$/1k` prices.

### v1.4

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

## OpenClaw Integration Roadmap (v2 candidates)

A docs audit of [docs.openclaw.ai](https://docs.openclaw.ai) — what they do that we don't, ranked by leverage for a system that already has agents/spawning/memory/Discord/voice/Composio. **None of this is implemented yet** — the table below is a v2 planning surface, not a status report. Items in roughly priority order:

| OpenClaw feature | What it is | Why it matters for NeuroClaw | Where it would land |
|---|---|---|---|
| **Layered file-based prompts** | Per-workspace `SOUL.md` (personality), `AGENTS.md` (procedures), `USER.md` (user facts), `IDENTITY.md`, `BOOTSTRAP.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`. Sub-agents get only `AGENTS.md + TOOLS.md` (clean context isolation). | Replaces our single `system_prompt` column with a composable, version-controllable, per-role layer stack. SOUL/USER stays consistent across edits; per-agent overrides cleanly. Better separation of "who am I" vs "how do I work" vs "what do I know about this user". | New `prompt_layers` table (or filesystem fallback) + extension to `alfred.ts`'s dynamic prompt builder. Sub-agents skip SOUL/USER. Heartbeat picks up `HEARTBEAT.md`. |
| **Tool profiles + tool groups** | Named bundles like `coding`, `messaging` that compose groups (`group:sessions`, `group:ui`, `group:automation`, `group:nodes`). Per-agent allowlists. | Cleaner than our current capability arrays. *"Give Coder the `coding` profile"* is more readable than picking 12 individual tool names, and groups can evolve without touching every agent row. | New `tool_profiles` + `tool_groups` config in `config_items` or a small table; `buildTools()` expands a profile into the live tool list. |
| **Plugin hook bus (28 typed lifecycle hooks)** | First-class `before_tool_call`, `before_agent_reply`, `model_resolve`, `agent_lifecycle`, `gateway_lifecycle`, etc. Plugins register interceptors typed per phase. | Skills today only append text to the system prompt. A typed hook bus would let skills/plugins also intercept tool calls, mutate the prompt, audit, gate spawns — without forking the orchestrator. The cleanest extension surface in OpenClaw. | New `src/system/hooks.ts` event bus; emit at the existing seams in `alfred.ts` and `tools/registry.ts`. Skills upgrade from text-only to full lifecycle participation. |
| **Global `tools.allow` / `tools.deny`** | Single deny-wins gate from `~/.openclaw/openclaw.json`. | One place to kill a misbehaving tool across every agent and runtime, no DB migration, no code change. Powerful operational lever we don't have. | A `config_items` row read in `buildTools()`. Deny wins; allowlist optional. Same gate applies in all four runtime adapters. |
| **`sessions_send` (cross-session messaging tool)** | An LLM tool that sends a message to a sibling session and optionally waits for a reply with `timeoutSeconds`. Backed by their non-blocking spawn. | Promotes our existing background-task pattern to a first-class agent-controllable primitive. Lets agents fire-and-forget OR fire-and-wait against another agent's session, not just spawn one-shot temps. | Wrap our `messageQueue` + `agent_messages` table behind a new `sessions_send` tool with `wait_for_reply` + `timeout_seconds` args. |
| **A2UI / Live Canvas** | Sandboxed component renderer (default `:18793`) lets agents emit interactive UI (HTML/CSS/JS + A2UI components), not just text/JSON. | Biggest UX leap. Our chat is text-only; agents could render forms, graphs, diff viewers, decision UIs in-line. Long-tail value, but bigger build. | New `/api/canvas` SSE route + a `<Canvas>` panel in the chat page. Probably v2.5 — port the A2UI schema first, then the renderer. |
| **`HEARTBEAT.md` prompt slot** | User-editable file that's injected into periodic autonomous agent turns. | We already have `src/system/heartbeat.ts` but nothing tells the agent *what* to think about. A loaded-from-file prompt slot makes this useful — *"check unanswered tasks, summarize the last hour, surface anything blocked > 24h."* | One-line addition to `runHeartbeats()`: load `HEARTBEAT.md` from `.claude/` and prepend before the heartbeat ping. |
| **Voice Wake / Talk Mode** | Wake-word activation on macOS/iOS, continuous listen-think-speak loop on Android. ElevenLabs + system-TTS fallback. | We just shipped TTS + STT. Wake-word + continuous-loop is the natural next step for a "real assistant" feel. Native-app territory though — much heavier than current Discord/dashboard surfaces. | Out of scope for v2 unless we pick up a native shell. Track separately as v3 candidate. |
| **Nodes (paired physical devices)** | Mac/iOS/Android paired to the agent for camera snap, screen record, location, push notifications, `system.run`/`system.notify`. | Powerful but overlaps heavily with what Composio + a native client would provide. Lower priority — partial replacement via Composio's `Push Notifications` + macOS automation toolkits. | Skip unless we do a native client. |

**Things NeuroClaw already has that OpenClaw appears to lack** (so don't port):
- Hive Mind structured event ledger with action taxonomy
- Langfuse tracing
- LLM-based spawn evaluator (`evaluateSpawn`) gating spawn requests
- LLM router with confidence threshold (`AUTO_DELEGATION_MIN_CONFIDENCE`)
- NeuroVault MCP-backed long-term memory (OpenClaw uses dated markdown files)
- Per-agent vision/voice/exec mode toggles
- React SPA dashboard with SSE config-watch
- Composio integration

**Suggested v2 sequence** (in implementation order):
1. **Layered prompts + `HEARTBEAT.md`** — high leverage, low risk, unblocks the rest
2. **Plugin hook bus** — needed before tool profiles/skills become really useful
3. **Tool profiles + global allow/deny** — operational quality-of-life, depends on hook bus
4. **`sessions_send` tool** — cheap port of existing infrastructure
5. **A2UI / Live Canvas** — biggest UX win, biggest build; tackle when the foundation above is solid

---

## The-Code-Labz Stack Integration Plan (v2)

Audits of the three sister repos: [Archon](https://github.com/The-Code-Labz/Archon), [Paperclip](https://github.com/The-Code-Labz/paperclip), [Symphony](https://github.com/The-Code-Labz/symphony). Each is treated as a pattern source, not a runtime dependency — NeuroClaw absorbs the parts worth owning and skips what we already cover.

### Archon — Tasks tab rework (own the data, drop the MCP)

Today NeuroClaw runs Archon as an MCP and uses its task tools heavily. Goal: **stop running Archon as an MCP, port its data model + tool surface + Kanban UI into NeuroClaw**, keep tool names drop-in compatible so existing prompts (including this repo's `CLAUDE.md`) keep working.

**Schema gap to close** (additive migration):
- New `projects` table — `id, title, description, docs JSON, features JSON, data JSON, github_repo, pinned, timestamps`. Seed one default project `"NeuroClaw"`.
- `tasks` adds: `project_id` (FK), `parent_task_id` (self-FK for subtasks), `assignee TEXT DEFAULT 'User'` (free-text — accepts agents, humans, `"User"`, `"AI IDE Agent"`), `task_order INT` (drag-reorder, scoped per status column), `feature TEXT` (free-text label, cuts across projects), `sources JSON`, `code_examples JSON`, `archived INT`, `archived_at`, `archived_by`. Backfill `project_id` to default. Map existing 0-100 priority → enum buckets in a new `priority_level` column; keep old col one release.

**Tool consolidation** (single biggest payoff): replace granular CRUD tools with two patterns —
- `find_*` (list + search + get in one tool, optimized payloads when listing) — `find_projects`, `find_tasks`, `find_documents`, `find_versions`.
- `manage_*` (action-discriminated CRUD) — `manage_project`, `manage_task`, `manage_document`, `manage_version`. `action: "create" | "update" | "delete"`.

Cuts the tool surface ~60% and matches Archon's MCP signatures byte-for-byte, so any agent prompt that already says *"call `find_tasks` with filter_by=status, filter_value=todo"* works without a rewrite.

**Killer feature:** `tasks.sources` + `tasks.code_examples` JSON arrays — hooks NeuroVault retrievals directly onto a task. *"This task references these 3 vault notes + these 2 code snippets"*. The TaskEditModal gets an "Attach sources" picker that calls our existing NeuroVault retrieval. The RAG tools get drop-in compatible names (`rag_search_knowledge_base`, `rag_search_code_examples`, `rag_list_pages_for_source`, `rag_read_full_page`) but route to NeuroVault instead of Archon's pgvector.

**UI port:** `react-dnd` (HTML5Backend) Kanban with `KanbanColumn` per status, `task_order` for within-column ordering, drag = PATCH `{status, task_order}`. View toggle Board ↔ Table. Project switcher as the top-level shell. ETag polling on the project task list (or piggyback our existing SSE).

**6-PR migration plan** (smallest first, preserves data):
1. Schema additive (`src/db.ts`) — projects table + task column adds + backfill. Each `ALTER` in its own try/catch (SQLite has no `IF NOT EXISTS`).
2. Projects API + tools (`src/dashboard/routes.ts`, `src/tools/`) — `GET/POST/PATCH/DELETE /api/projects`, `find_projects`/`manage_project` in registry. **Delete external Archon MCP entry from `.env` here.**
3. Task tool consolidation — replace granular tools with `find_tasks`/`manage_task`. Soft-delete (archived flag) replaces hard delete.
4. Kanban UI (`src/dashboard/v2/src/page-tasks.jsx`) — `react-dnd` with cards, modal, project switcher, free-text assignee combobox.
5. **RAG-on-tasks** — sources/code_examples picker in TaskEditModal; expose Archon-compatible RAG tool names that wrap NeuroVault.
6. Subtasks + per-field versioning (`task_versions` table, `find_versions`/`manage_version` tools). Optional, ship later.

**After PR 5: remove `ARCHON-FIRST RULE` from `CLAUDE.md`** — the data is ours, the tools have the same names, no MCP round-trip.

### Paperclip — Borrow three primitives, run the rest as sidecar

Paperclip is a multi-tenant orchestration "control plane" (server + ui + cli + plugins, monorepo, Postgres+Drizzle). Most of it overlaps with what NeuroClaw already has — multi-runtime adapter dispatch, MCP client, agent registry, audit log, cleanup, routing. Embedding the whole thing means importing Postgres + Drizzle + the multi-tenant "company" layer that we don't need.

**Three primitives worth porting natively** (the unique leverage):

1. **Per-agent budgets with auto-stop.**
   New table `agent_budgets(agent_id, monthly_limit_usd, current_spend_usd, period_start, auto_stop_enabled)`. Pre-call hook in `src/agent/alfred.ts:chatStream()` aborts when over budget. Period rollover at month boundary. Spend already tracked in `model_spend`; this just adds a per-agent cap on top.
2. **Atomic ticket checkout.** The `UPDATE tasks SET claimed_by=?, claim_expires_at=? WHERE id=? AND claimed_by IS NULL` pattern — guarantees a task can't be picked up by two agents. New columns on `tasks`: `claimed_by`, `claim_expires_at`. Pair with a sweeper in `src/system/cleanup.ts` to reset expired claims. Critical when multiple background agents poll for work.
3. **Board-approval governance.** New `task_approvals(task_id, required_role, approved_by, approved_at)` row when a task is flagged `requires_approval=1`. Agents can create the task but can't transition to `doing` until approved. Useful for high-blast-radius tools (deploys, sends, deletes) — the approval workflow uses NeuroClaw's existing dashboard, not a new UI.

**Sidecar option** (parallel): if you want Paperclip's UI for budget visualization or cross-company ops, run it standalone on `:8787` and register its MCP server in `src/mcp/mcp-client.ts`. This gives Alfred its `tickets.checkout` / `budgets.check` tools without porting Postgres.

### Symphony — Port the pattern, skip the runtime

Symphony is Elixir/Phoenix — porting the runtime means embedding BEAM, which we won't. But the **pattern** is small and valuable: poll an issue tracker, spawn a Codex subprocess per issue, drive a turn-loop until the issue exits an active state, retry with exponential backoff, surface live progress.

We already have most of the components: `codex-cli.ts` provider, `background-tasks.ts` runner, `cleanup.ts` interval scheduler, `spawner.ts` concurrency caps, `hive_mind` event log. The gap is **the issue-tracker poll loop + per-issue workspace lifecycle**.

**Implementation** (only build if Linear is actually used):
- `src/integrations/linear-client.ts` — GraphQL client for Linear (mirror Symphony's Tracker module)
- `src/system/symphony-orchestrator.ts` — polling loop + retry queue on top of `background-tasks.ts`. Concurrency caps via `SYMPHONY_MAX_CONCURRENT`. Exponential backoff `10s × 2^n`.
- `src/system/workspace-manager.ts` — per-issue tmpdir + lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- `src/tools/registry.ts` — `linear_graphql` tool so any agent can hit Linear directly
- `src/dashboard/v2/src/page-symphony.jsx` — running sessions, retry queue, token totals (mirrors Symphony's `/api/v1/state`)
- `.env.example` — `LINEAR_API_KEY`, `SYMPHONY_POLL_INTERVAL`, `SYMPHONY_MAX_CONCURRENT`, `SYMPHONY_WORKSPACE_ROOT`
- `hive_mind` actions: `issue_claimed`, `issue_dispatched`, `issue_retried`, `issue_released`

If you don't use Linear, skip this entirely — the orchestration value is already in `alfred.ts:orchestrateMultiAgent()`.

### Combined sequence (recommended)

| Step | Source | Why first |
|---|---|---|
| 1 | **Archon** PRs 1-3 | Kills the double-bookkeeping with the external Archon MCP today. Foundational for everything else. |
| 2 | **Archon** PR 4 (Kanban UI) | Visible UX win once the schema lands. Unblocks projects/subtasks. |
| 3 | **Archon** PR 5 (RAG-on-tasks) | The unique value Archon adds over a generic task system. |
| 4 | **Paperclip** atomic checkout + budgets | Becomes useful once the new tasks system is live; budgets get accurate when `model_spend` already tracks per-agent. |
| 5 | **OpenClaw** layered prompts + hook bus | From the prior roadmap section. Independent of tasks work. |
| 6 | **Paperclip** approval governance | Layered onto Step 4. Needed before exposing higher-blast-radius tools. |
| 7 | **Symphony** Linear loop | Only if Linear is in active use. |
| 8 | **Archon** PR 6 (subtasks + versions) | Polish phase. |

Steps 1-3 are the v2.0 milestone. 4-6 are v2.1. 7-8 are opportunistic.

---

## What's Next

Both of the previously-flagged uneven spots are now done in v1.5.1. ✅

### ✅ Done in v1.5.1 — `spawn_agent` for Claude CLI agents

Added `spawn_agent` and `list_temp_agents` to the in-process MCP server. Claude CLI agents now have full multi-agent orchestration parity with OpenAI/Anthropic-API agents. The cascade-depth penalty + budget guard + soft/hard temp-agent limits apply uniformly across all backends. `mcp__neuroclaw__spawn_agent` and `mcp__neuroclaw__list_temp_agents` are pre-approved in `allowedTools` so they don't trigger permission prompts.

### ✅ Done in v1.5.1 — Skills for OpenAI / VoidAI agents (option B — manual selection)

Shipped the manual-selection variant: agents declare a fixed `skills` list, bodies are appended to the system prompt every turn. No per-turn LLM router (option C deferred). See [Skills](#skills-v151) for the format and the dashboard flow.

**If Skills become central to daily use,** the path to option C (auto-routing) is:
- Tiny LLM call (haiku-tier) at chat-turn start over the user message → returns a list of skill names that apply.
- Cache decisions by user-message hash (re-run the same query → reuse).
- Optional `triggers:` regex match as a free pre-filter to short-circuit before the LLM call.
- Estimated: ~3 hours of work + a per-turn cost roughly equal to the memory-extractor.

Right now option B is enough — you can attach `deploy-checklist` to your DevOps agent permanently, attach `code-review-rules` to Coder permanently, and the right skill is always loaded for the right agent without any classifier.

---

### Now-relevant open work

| Workstream | Status | Notes |
|---|---|---|
| Real Dream Cycle backend | ✅ shipped in v1.6 — see [Dream Cycle](#dream-cycle-v16) | |
| Memory evolution | Mostly stubbed (`memory-consolidator.ts`) | Salience decay scheduler, semantic dedupe (currently title+type+agent within 7d), promotion of repeating episodic→procedural after 3+ recurrences |
| PARA Map page (real wiring) | Backend ready; v2 page still mock | `areas` table + `agent.area_id` + CRUD endpoints all live. The 412-line `page-para.jsx` was never rewritten to consume `NC_DATA.AREAS` — ~2 hour rewrite |
| Settings tab → real config edit | Read-only via "Live .env" tab | Tabs 1-8 still display mock toggles. Wiring each setting through to a write endpoint is per-tab work, ~30 min each |
| ResearchLM/InsightsLM tool wiring | URL set in `.env` but tool name mismatch | Live `/api/memory/hive` shows the warn; need to either remove the URL or update the retriever's tool name to match what the server exposes |
| v1 → v2 dashboard cutover | Both alive | Once you've used v2 for a few sessions and feel good about it: rename routes (D7) and delete v1 |

### Already-planned expansions

| Version | Feature | Notes |
|---|---|---|
| v1.6 | Dream cycle (real impl) | Currently stubbed. Backend is ~1 day of work — LLM-driven nightly consolidation that scans 24h sessions, extracts decisions/procedures/insights, generates a next-day plan, archives noise. |
| v1.6 | Memory evolution | Salience decay scheduler, semantic dedupe (currently title-based), promotion of repeating episodic→procedural after 3+ recurrences. |
| v1.7 | PARA Map (real wiring) | Backend exists (`areas` table, `agent.area_id`, `/api/areas` CRUD); v2 dashboard page still renders the design's mock rooms. ~2 hour rewrite to consume `NC_DATA.AREAS`. |
| ~~v1.7 Discord integration~~ ✅ shipped | `src/integrations/discord-bot.ts` is live. Run `npm run bot:discord`. |
| v1.8 | Memory: credential guard | Mem0-inspired multi-layer regex filter (`sk-*`, `ghp_*`, `AKIA*`, `Bearer *`, `password=*`, `xox[baprs]-*`, `eyJ*`, etc.) in the extractor + a sweep step in `dream-cycle.ts` prune. Belt-and-braces. ~30 min. |
| v1.8 | Memory: hybrid retrieval reranker | Small LLM (haiku-tier) second-pass over top-15 merged hits, re-scores by task relevance, trims to top-K. Catches "semantically close but not what was asked" misses. Mem0 does this. ~2-3 hours. |
| v1.8 | Memory: citation tracking + retrieval logs | New `memory_retrieval_log` table. Powers v2 retriever-tuning loop AND lets agents emit citations. ~1-2 hours. |
| v1.8 | Memory: dashboard graph view | Force-directed render of `memory_entities` ↔ `memory_relationships` (D3 / `react-force-graph`). Nodes = entities, edges = relationships, click an entity to see all memories that mention it. ~3-4 hours. |
| v1.8 | Memory: promotion rules | Auto-promote `episodic` → `procedural` after 3+ recurrences of the same canonical relationship. Use `memory_relationships` collisions as the recurrence signal. ~2 hours. |
| v1.8 | Memory: temporal validity tracking | Schema columns (`valid_from`, `valid_to`) shipped in v1.7. Add the dream-cycle step that detects contradictions and sets `valid_to` instead of deleting. ~2 hours. |
| v1.8 | Skills exposed as MCP prompts | Tools are unified; skills are still server-injected. Expose each `.claude/skills/*/SKILL.md` body as a named MCP `prompts` entry so external runtimes (Codex, etc.) can `prompts/list` then `prompts/get` at runtime. ~1-2 hours. |
| v1.8 | PARA Map (real wiring) | Backend exists (`areas` table, `agent.area_id`, `/api/areas` CRUD); v2 page still renders mocks. ~2 hour rewrite to consume `NC_DATA.AREAS`. |
| v1.9 | LiveKit + ElevenLabs voice agents | Voice-first agent UX. |
| v1.9 | Memory evolution (deeper) | Embedding-based semantic dedupe (current Jaccard is conservative), salience-decay-driven archive cycle. |
| v2 | Memory: multi-user namespaces | `agents.memory_user_id` + scoped retrieval. Worth it if NeuroClaw goes multi-tenant. ~1 hour. |
| v2 | Memory: feedback loop on retrieval quality | Once v1.8's `memory_retrieval_log` is collecting, periodically re-fit cosine threshold + blend ratios + topK from observed retrieval-success signals. Mem0 doesn't expose this loop; we can. |
| v2 | Memory: Neo4j escape hatch | When traversal queries justify it (3+ recursive CTEs, ~50k+ edges, or Cypher's pattern-matching power genuinely needed). Until then: SQL JOINs handle it in ms. |
| v2 | Memory: Graphiti as the auto-extractor | If our naive single-pass starts producing duplicate entities or wrong-but-newer relationships. Graphiti's multi-pass pipeline (entities → relationships → episodic facts with coreference) writes into our same SQLite tables. |
| v2 | Memory: vault-side embeddings + chunk-level search | For detail-level recall ("what was the exact error message we hit on day 5?"). New `vault_chunks` table mirroring memory_index's embedding pattern. |
| v2 | Memory: Obsidian-shaped graph view (humans) | Emit `[[wiki-link]]` syntax in vault notes (sourced from `memory_relationships`) so Obsidian renders the graph natively. Zero viewer code on our side. |
| v2 | Retrieval Router | Heuristic (or small LLM) classifier pre-filters which sources to query per turn. Defer until fan-out is a real pain point. |
| v2 | Web tool (Brave / Perplexity / Tavily) | As a Composio toolkit, not a custom tool. Already half-handled by v1.7 Composio. |
| v2 | Document Q&A (ResearchLM-style) | **Separate product surface**, not part of NeuroClaw. Uses our primitives (embedding, FTS5, SQLite); has its own schemas (`document_chunks`) and citation requirements. |
| v2 | Ragas-style retrieval evaluation | Offline nightly scoring with standard Ragas metrics (faithfulness, answer-relevance, context-precision, context-recall). |
| v2 | Deeper Mem0 cloning | Domain overlays, custom categories per deployment, importance-gate prompts, `memory_event_list` introspection. Walk their repo, lift the patterns that translate, document the rest. |
| v2 | Discord bot polish | Slash commands, threads, rich embeds, voice-channel join. (OpenClaw's plugin has all of these — we lifted only the inbound chat bridge.) |
| v2 | Full NeuroClaw OS | Cutover from v1 dashboard to v2, Skills loader option C (per-turn LLM auto-routing) if warranted. |
