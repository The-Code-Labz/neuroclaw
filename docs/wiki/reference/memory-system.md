---
title: Memory system
order: 30
---

# Memory system

NeuroClaw agents have two layers of memory. The first is the **legacy `memories` table**, a simple key-value store that predates v1.4 and still backs the dashboard Memory tab. The second — and primary — layer is the **`memory_index`**, a structured long-term store introduced in v1.4 that every agent reads from and writes to automatically during conversation. This article covers the v1.4+ system.

The memory system exists so agents do not lose relevant context between sessions. Rather than growing a single unbounded conversation history, NeuroClaw extracts durable facts and patterns from each chat exchange, scores them, stores them locally, optionally mirrors them to NeuroVault, and re-injects the most relevant ones into each new agent turn — all without the user having to ask.

## Memory types

The `memory_index` table stores nine distinct types. The type is assigned by the LLM extractor based on the character of the information.

| Type | Meaning |
|---|---|
| `working` | Transient in-session notes; active scratch pad |
| `episodic` | A specific event, decision, or moment that happened |
| `semantic` | A fact or piece of knowledge (how something works) |
| `procedural` | A how-to, repeatable fix, or step-by-step process |
| `preference` | Something the user prefers or wants done a certain way |
| `session_summary` | A compressed summary of a past conversation (written by context compaction) |
| `insight` | A meta-pattern or learned heuristic discovered across multiple sessions |
| `project` | Project-specific context: goals, constraints, current state |
| `agent` | Information specific to an individual agent's behavior or configuration |

During retrieval, `procedural` memories are grouped under **Procedures**, `insight` and `semantic` under **Insights**, `preference` under **Preferences**, and all other types under **Memory** (episodic, working, project, agent, session_summary).

## Memory pipeline

Every time an agent completes a chat turn, `ingestExchangeAsync()` in `memory-pipeline.ts` fires in the background as a fire-and-forget call. It never blocks the main chat response.

The pipeline runs in order:

1. **Extract** — The LLM extractor (`memory-extractor.ts`) reads the (user, assistant) exchange and produces a structured candidate: type, title, 1–2 sentence summary, 2–5 sentence content, tags, and five importance components. It also extracts up to 8 named entities and 6 subject/verb/object relationships for the graph layer. If the exchange is not worth remembering (small talk, trivial one-shot facts, unresolved error chains), the extractor returns `memorable: false` and the pipeline stops.

2. **Score** — `memory-scorer.ts` combines the five importance components into a single 0–1 score using weighted arithmetic:

   | Component | Weight | Meaning |
   |---|---|---|
   | `relevance` | 0.30 | Is this relevant to ongoing work? |
   | `usefulness` | 0.30 | Would future-self benefit from this? |
   | `recurrence` | 0.15 | Does this look like a repeated pattern? |
   | `user_emphasis` | 0.15 | Did the user say "remember" / "important"? |
   | `correction_weight` | 0.10 | Did the assistant correct a prior mistake? |

   If the composite score falls below `MEMORY_IMPORTANCE_THRESHOLD` (default 0.6), the memory is dropped.

3. **Dedupe** — If a memory with the same title, type, and agent already exists within the last 7 days, the pipeline skips the write.

4. **Store** — The memory is written to `memory_index` in SQLite. Embeddings (if enabled) are generated and stored asynchronously via a fire-and-forget call so they never block the write path.

5. **Graph-lite** — When `MEMORY_GRAPH_EXTRACT_ENABLED` is true (the default), extracted entities and relationships are persisted to `memory_entities` and `memory_relationships`, linking back to the memory row by `memory_id`. This powers entity-centric queries like "what memories mention Composio?" and "what depends on this agent?".

6. **Vault mirror** — If `MCP_ENABLED=true` and `NEUROVAULT_MCP_URL` is set, the pipeline mirrors the memory to NeuroVault as a Markdown note under the appropriate folder (`procedures/`, `insights/`, `logs/`, `agents/`, `projects/`). Vault mirroring is subject to rate caps: `MEMORY_PER_SESSION_MAX` (default 50) per session and `MEMORY_PER_HOUR_MAX` (default 200) system-wide per rolling hour. Cap hits are logged to the Hive Mind as `memory_capped` events but never cause the local write to fail — the row is in SQLite regardless.

All pipeline steps are wrapped in try/catch. A failure at any step does not propagate to the chat path.

## Memory retrieval

At the start of every chat turn, `buildMemoryContextBlock()` runs a retrieval pass against the user's incoming message and appends the results to the agent's system prompt as a `## Relevant long-term memory` section. This is called **pre-injection** and is controlled by `MEMORY_PREINJECT_ENABLED` (default `true`) and `MEMORY_PREINJECT_MAX` (default 5 memories).

Pre-injection means every agent — regardless of provider or backend — gets baseline memory awareness without needing to call any tool explicitly.

### How retrieval works

`retrieve()` in `memory-retriever.ts` fans out across up to four sources in parallel, then merges and deduplicates by vault path and title (keeping the highest score):

- **SQLite (always)** — A two-pass hybrid search:
  - Pass 1 (vector): If embeddings are enabled, the query is embedded and cosine similarity is computed against all stored embeddings. Rows scoring below 0.30 are dropped. The final score blends cosine (60%) with the stored salience/importance/recency rank (40%).
  - Pass 2 (lexical): FTS5 full-text search with BM25 ranking blended with salience and importance signals. Falls back to a `LIKE %query%` scan when FTS5 is unavailable or returns nothing.
  - Hits from both passes are merged; lexical-only rows are appended after vector hits.
- **NeuroVault** — Full-text search via the `search_vault` MCP tool, when `MCP_ENABLED=true` and `NEUROVAULT_MCP_URL` is set.

Salience decays over time with a ~14-day half-life (`timeDecayMultiplier()` in the scorer). Every retrieval hit bumps `last_accessed` on the SQLite row, which resets the decay clock.

## Context compaction

When a conversation grows beyond the token or turn budget, `maybeCompactHistory()` in `context-compactor.ts` automatically replaces the oldest conversation turns with a compact summary.

Compaction fires when both thresholds are checked on each turn. It triggers when the history exceeds **either**:
- `COMPACT_TOKEN_THRESHOLD` estimated tokens (default 8,000)
- `COMPACT_TURN_THRESHOLD` turns (default 30)

When triggered:

1. The system prompt (history index 0) and the most recent `COMPACT_KEEP_RECENT` turns (default 6) are preserved untouched.
2. The remaining "cold" range is passed to an LLM summarizer (200–400 words, bulleted Markdown) that preserves open questions, decisions, preferences, TODOs, and stated constraints. Greetings and resolved chitchat are dropped.
3. The summary is saved to `memory_index` as a `session_summary` type and optionally mirrored to NeuroVault.
4. `COMPACT_REINJECT_MEMORIES` (default 3) relevant long-term memories are retrieved based on the next user message and appended to the summary under a `[Relevant memories]` header.
5. The cold range in the history array is replaced with a single synthetic system message containing the summary and memory block.

The compactor is logged to the Hive Mind as a `memory_extracted` event with `source: "auto_compact"`. Failures in any step are non-fatal — if the summarizer returns too little content, compaction is skipped for that turn.

## Vector embeddings

By default, vector embeddings are **disabled** (`MEMORY_EMBEDDINGS_ENABLED=false`). When enabled, every memory written to `memory_index` is asynchronously embedded using the configured model and stored as a `Float32Array` BLOB in the `embedding` column.

Embeddings enable semantic (meaning-based) retrieval instead of keyword matching. A query like "how do I handle rate limiting?" can surface a procedural memory titled "Composio API backoff strategy" even if none of those exact words appear in the title or summary.

At retrieval time, the query is also embedded and cosine similarity is computed in JavaScript over the candidate set. For typical deployments (under 10,000 memories) this adds 0.5–2 seconds per query. The implementation notes that `sqlite-vec` can replace this if the collection grows past 50,000 rows.

Rows without embeddings (pre-dating the feature or below `MEMORY_EMBEDDING_MIN_CHARS`) remain searchable via the lexical path. The two paths are merged.

| Variable | Default | Notes |
|---|---|---|
| `MEMORY_EMBEDDINGS_ENABLED` | `false` | Enable vector embeddings |
| `MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model passed to the OpenAI-compatible endpoint |
| `MEMORY_EMBEDDING_MIN_CHARS` | `30` | Text shorter than this is not embedded |

## NeuroVault

NeuroVault is an Obsidian-style file-tree vault exposed via an MCP server. NeuroClaw uses it as a persistent external mirror for the local `memory_index`. Every indexed memory that passes the vault rate cap is written as a Markdown note under a folder that corresponds to its type:

| Memory type | Vault folder |
|---|---|
| `procedural` | `procedures/` |
| `project` | `projects/` |
| `agent`, `preference` | `agents/` |
| `episodic`, `session_summary`, `working` | `logs/` |
| `insight`, `semantic` | `insights/` |

Notes follow the naming pattern `<folder>/<YYYY-MM-DD>--<agent>--<session4>--<title-slug>.md`.

To connect NeuroVault, set `MCP_ENABLED=true`, point `NEUROVAULT_MCP_URL` at the running MCP server, and optionally set `NEUROVAULT_DEFAULT_VAULT` (default `neuroclaw`) to the vault name. The vault name is resolved to a UUID on first use and cached in memory for the lifetime of the process.

When NeuroVault is connected, retrieval also searches the vault so memories written by one session are recoverable even if the local SQLite database is reset.

## Agent tools

Agents have access to a set of memory tools they can call explicitly during a chat turn. These are registered in the tool registry alongside other agent tools.

| Tool | Description |
|---|---|
| `search_memory` | Hybrid search (vector + lexical + vault) against the query string. Returns hits grouped by type: memory, procedures, insights, preferences. |
| `search_vault` | Search NeuroVault directly, bypassing the local index. |
| `write_vault_note` | Manually write a memory to the local index and optionally mirror to NeuroVault. Requires `title`, `type`, and `summary`. |
| `save_session_summary` | Convenience wrapper around `write_vault_note` for `session_summary` type memories. |
| `compact_context` | Manually compact a serialized conversation excerpt into a session summary memory. |
| `retrieve_relevant_memory` | Alias for `search_memory`; used when an agent wants to make the intent explicit. |

Beyond these explicit tools, pre-injection (`buildMemoryContextBlock`) makes memory available passively — agents do not have to call a tool to benefit from previously stored context.

## API endpoints

All endpoints require the `?token=` query parameter or `x-dashboard-token` header.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/memory` | Returns up to 100 rows from the legacy `memories` table, ordered by importance then recency. |
| `POST` | `/api/memory` | Writes a row to the legacy table. Body: `{ content, type?, sessionId?, importance? }`. |
| `DELETE` | `/api/memory/:id` | Deletes a row from the legacy table. |
| `GET` | `/api/memory/index` | Returns `memory_index` rows. Query params: `limit` (max 500, default 100), `type`, `sessionId`. Ordered by most recently accessed. |
| `GET` | `/api/memory/index/stats` | Summary statistics: total rows, breakdown by type with average importance/salience, counts for last hour and last day, vault-cap hits in the last hour, auto-compact runs in the last day. |
| `GET` | `/api/memory/hive` | Hive Mind events for memory actions (`memory_extracted`, `memory_skipped`, `memory_capped`). Query param: `limit` (max 500). |
| `DELETE` | `/api/memory/index/:id` | Deletes a row from `memory_index`. |

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `MEMORY_EXTRACT_MIN_CHARS` | `200` | Assistant response must be at least this many characters before extraction runs. |
| `MEMORY_EXTRACT_MODEL` | *(VOIDAI_MODEL)* | Override the LLM used for extraction and graph parsing. |
| `MEMORY_IMPORTANCE_THRESHOLD` | `0.6` | Minimum composite importance score to store a memory. |
| `MEMORY_PER_SESSION_MAX` | `50` | Maximum vault-mirrored memories per session. Local writes are not capped. |
| `MEMORY_PER_HOUR_MAX` | `200` | Maximum vault-mirrored memories per rolling hour across all sessions. |
| `MEMORY_PREINJECT_ENABLED` | `true` | Pre-inject relevant memories into every agent's system prompt. |
| `MEMORY_PREINJECT_MAX` | `5` | Number of memories to include in pre-injection. |
| `MEMORY_EMBEDDINGS_ENABLED` | `false` | Enable vector embeddings for semantic retrieval. |
| `MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model identifier. |
| `MEMORY_EMBEDDING_MIN_CHARS` | `30` | Minimum text length to embed. |
| `MEMORY_GRAPH_EXTRACT_ENABLED` | `true` | Extract entities and relationships alongside each memory. |
| `MCP_ENABLED` | `false` | Enables NeuroVault and other MCP integrations. |
| `NEUROVAULT_MCP_URL` | — | URL of the NeuroVault MCP server. |
| `NEUROVAULT_DEFAULT_VAULT` | `neuroclaw` | Vault name to write to when no vault is specified. |
| `COMPACT_ENABLED` | `true` | Enable automatic context compaction. |
| `COMPACT_TOKEN_THRESHOLD` | `8000` | Estimated token count that triggers compaction. |
| `COMPACT_TURN_THRESHOLD` | `30` | Turn count that triggers compaction (either threshold fires compaction). |
| `COMPACT_KEEP_RECENT` | `6` | Number of most recent turns to preserve unchanged during compaction. |
| `COMPACT_REINJECT_MEMORIES` | `3` | Long-term memories to append to the compacted summary. |
| `COMPACT_MODEL` | *(VOIDAI_MODEL)* | Override the LLM used for the compaction summarizer. |
