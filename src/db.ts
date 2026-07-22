import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'crypto';
import { config } from './config';
import { logger } from './utils/logger';
import { notificationEvents, type DashboardNotificationEvent } from './system/notification-events';
import { runEvents, agentBus, type RunTerminalEvent } from './system/event-bus';
import { defaultAnthropicModel } from './system/model-defaults';
import { JOB_TYPE_TO_EVENT } from './system/inngest-functions';
import { stripNegationTags } from './system/agent-caps-format';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    runMigrations(db);
    migrateDeprecatedProviders(db);
    seedDefaultData(db);
    // Mark any runs that were left mid-flight from a previous process as dropped.
    // 'running' and 'detached' both indicate the agent loop was still active when
    // the process exited — no in-memory state survives a restart, so any partial
    // output already persisted is all the user gets.
    db.prepare(
      "UPDATE runs SET status='dropped', error_text='interrupted: server restarted', ended_at=datetime('now') WHERE status IN ('running','detached','paused')"
    ).run();
  }
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT,
      system_prompt       TEXT,
      model               TEXT,
      role                TEXT DEFAULT 'agent',
      capabilities        TEXT DEFAULT '[]',
      status              TEXT DEFAULT 'active',
      temporary           INTEGER DEFAULT 0,
      spawn_depth         INTEGER DEFAULT 0,
      parent_agent_id     TEXT REFERENCES agents(id),
      created_by_agent_id TEXT REFERENCES agents(id),
      expires_at          TEXT,
      created_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      title         TEXT,
      status        TEXT DEFAULT 'active',
      agent_id      TEXT REFERENCES agents(id),
      message_count INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content     TEXT NOT NULL,
      agent_id    TEXT REFERENCES agents(id),
      tokens_used INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      description         TEXT,
      status              TEXT DEFAULT 'todo'
                          CHECK(status IN ('todo','doing','review','done','failed','blocked','cancelled')),
      priority            INTEGER DEFAULT 50,
      session_id          TEXT REFERENCES sessions(id),
      agent_id            TEXT REFERENCES agents(id),
      created_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      -- sub-agent outcome fields (spec: sub-agent-blocked-outcome, task-status-extension)
      terminal_outcome    TEXT CHECK(terminal_outcome IS NULL OR terminal_outcome = 'blocked'),
      block_reason        TEXT,
      output              TEXT,
      failure_count       INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT,
      -- notification policy (spec: task-notify-policy)
      notify_policy       TEXT NOT NULL DEFAULT 'done_only',
      -- sweep / stale-detection metadata (spec: task-sweep-grace-periods)
      child_session_key   TEXT,
      last_heartbeat_at   INTEGER,
      recovery_started_at INTEGER,
      provider            TEXT
    );

    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      content    TEXT NOT NULL,
      type       TEXT DEFAULT 'general',
      importance INTEGER DEFAULT 5,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          TEXT PRIMARY KEY,
      action      TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      details     TEXT,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS analytics_events (
      id         TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      data       TEXT,
      session_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS config_items (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      description TEXT,
      is_secret   INTEGER DEFAULT 0,
      updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS hive_mind (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT REFERENCES agents(id),
      action     TEXT NOT NULL,
      summary    TEXT NOT NULL,
      metadata   TEXT,
      run_id     TEXT REFERENCES runs(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    -- v2.0: Run grouping. One row per outermost user-message turn — ties together
    -- the routing decision, every spawn / multi-agent step / tool call, and the
    -- final merged output. Existing hive_mind events stay as the per-event log;
    -- this table is the index. parent_run_id is reserved for nested runs (cron-
    -- spawned chats, agent-to-agent invocations) but not used in the v2.0 wiring.
    CREATE TABLE IF NOT EXISTS runs (
      id                  TEXT PRIMARY KEY,
      session_id          TEXT REFERENCES sessions(id),
      parent_run_id       TEXT REFERENCES runs(id),
      origin              TEXT NOT NULL,
      initiating_agent_id TEXT REFERENCES agents(id),
      user_message        TEXT NOT NULL,
      final_output        TEXT,
      status              TEXT NOT NULL DEFAULT 'running'
                          CHECK(status IN ('running','done','error')),
      is_multi_agent      INTEGER NOT NULL DEFAULT 0,
      step_count          INTEGER NOT NULL DEFAULT 0,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms         INTEGER,
      error_text          TEXT,
      started_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      ended_at            TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      id            TEXT PRIMARY KEY,
      from_agent_id TEXT REFERENCES agents(id),
      from_name     TEXT NOT NULL,
      to_agent_id   TEXT REFERENCES agents(id),
      to_name       TEXT NOT NULL,
      content       TEXT NOT NULL,
      response      TEXT,
      status        TEXT DEFAULT 'pending' CHECK(status IN ('pending','delivered','responded','failed')),
      session_id    TEXT,
      task_id       TEXT,
      created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    -- v2.x: comms_notes — user-authored notes shown in the Comms page.
    --   visibility = 'private' → never shown to agents (UI annotations only).
    --   visibility = 'shared'  → injected into agent system prompts (all agents
    --                            unless agent_id is set, then only that agent).
    -- ref_message_id optionally pins the note to a specific agent_messages row
    -- so the UI can render it inline next to that exchange.
    CREATE TABLE IF NOT EXISTS comms_notes (
      id              TEXT PRIMARY KEY,
      author          TEXT NOT NULL DEFAULT 'User',
      body            TEXT NOT NULL,
      visibility      TEXT NOT NULL DEFAULT 'private'
                      CHECK(visibility IN ('private','shared')),
      agent_id        TEXT REFERENCES agents(id),
      session_id      TEXT,
      ref_message_id  TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
      pinned          INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_comms_notes_recent     ON comms_notes(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comms_notes_visibility ON comms_notes(visibility);
    CREATE INDEX IF NOT EXISTS idx_comms_notes_agent      ON comms_notes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_comms_notes_ref        ON comms_notes(ref_message_id);

    -- v2.x: agent_notes — the shared Notepad. Long-form MARKDOWN documents any
    -- agent can create and append to at any time, read/copied by the human in the
    -- Notes tab. Purpose: escape Discord's message-length limit — an agent keeps
    -- appending to one note to build a single continuous document. Distinct from
    -- comms_notes (short, comms-channel scoped): these are durable notepads.
    CREATE TABLE IF NOT EXISTS agent_notes (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'Untitled note',
      content     TEXT NOT NULL DEFAULT '',
      author      TEXT NOT NULL DEFAULT 'agent',
      agent_id    TEXT REFERENCES agents(id),
      pinned      INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_notes_recent   ON agent_notes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_notes_pinned   ON agent_notes(pinned);
    CREATE INDEX IF NOT EXISTS idx_agent_notes_archived ON agent_notes(archived);

    -- v2.x: agent_user_messages — messages from agents to the human user.
    --   kind = 'info' | 'question' | 'alert' | 'update' controls display styling.
    --   read_at and dismissed_at track user interaction state.
    CREATE TABLE IF NOT EXISTS agent_user_messages (
      id            TEXT PRIMARY KEY,
      from_agent_id TEXT REFERENCES agents(id),
      from_name     TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'info'
                    CHECK(kind IN ('info','question','alert','update')),
      body          TEXT NOT NULL,
      metadata      TEXT,
      session_id    TEXT,
      created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      read_at       TEXT,
      dismissed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_user_messages_recent   ON agent_user_messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_user_messages_unread   ON agent_user_messages(read_at) WHERE read_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_user_messages_agent    ON agent_user_messages(from_agent_id);

    -- v2.x: agent_media — the Media gallery (Studio › Media). One row per piece
    -- of generated media (image/video/audio) that lives in S3-compatible object
    -- storage (Cloudflare R2). The bytes live in R2 under object_key; this row is
    -- provenance + index. The dashboard streams playback via short-lived presigned
    -- URLs derived from object_key, so nothing here is a public link. Any agent can
    -- register media (register_media tool) or generation tools auto-register.
    CREATE TABLE IF NOT EXISTS agent_media (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'image'
                  CHECK(kind IN ('image','video','audio')),
      title       TEXT NOT NULL DEFAULT '',
      prompt      TEXT NOT NULL DEFAULT '',
      object_key  TEXT NOT NULL,              -- key within the R2 bucket
      mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
      size        INTEGER NOT NULL DEFAULT 0, -- bytes
      source_tool TEXT NOT NULL DEFAULT '',   -- which tool/model produced it
      author      TEXT NOT NULL DEFAULT 'agent',
      agent_id    TEXT REFERENCES agents(id),
      session_id  TEXT,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_media_recent   ON agent_media(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_media_kind     ON agent_media(kind);
    CREATE INDEX IF NOT EXISTS idx_agent_media_archived ON agent_media(archived);

    -- v3.x: archive_items — NeuroArchive long-term reusable asset store (MinIO).
    -- Distinct from agent_media (ephemeral R2 Media gallery). Objects are kept
    -- indefinitely; bucket versioning provides overwrite/delete protection.
    CREATE TABLE IF NOT EXISTS archive_items (
      id              TEXT PRIMARY KEY,
      category        TEXT NOT NULL DEFAULT 'other'
                      CHECK(category IN ('video','image','audio','broll','code','document','other')),
      title           TEXT NOT NULL DEFAULT '',
      description     TEXT NOT NULL DEFAULT '',
      tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array, e.g. ["b-roll","city","night"]
      object_key      TEXT NOT NULL,                -- key within the MinIO archive bucket
      mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
      size            INTEGER NOT NULL DEFAULT 0,   -- bytes
      checksum_sha256 TEXT NOT NULL DEFAULT '',     -- integrity check on ingest + re-verify
      source_tool     TEXT NOT NULL DEFAULT '',
      author          TEXT NOT NULL DEFAULT 'agent',
      agent_id        TEXT REFERENCES agents(id),
      session_id      TEXT,
      pinned          INTEGER NOT NULL DEFAULT 0,   -- pin frequently reused items
      archived        INTEGER NOT NULL DEFAULT 0,   -- soft-delete flag
      created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      last_used_at    TEXT                          -- bump on every fetch/download
    );

    CREATE INDEX IF NOT EXISTS idx_archive_recent   ON archive_items(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_archive_category ON archive_items(category);
    CREATE INDEX IF NOT EXISTS idx_archive_archived ON archive_items(archived);

    -- v2.x: subagent_providers — per-family dashboard override for which sub-agent
    -- provider families (kimi/minimax/…) are usable for routing. One row per
    -- family that has been explicitly toggled in the UI. Absence of a row means
    -- "no override" → fall back to the env/key-presence default in config.subAgent.
    -- This exists so an operator can enable/disable a family live from Settings ›
    -- Sub-Agents WITHOUT editing .env or restarting — the runner reads this on
    -- every task. A family with no API key can never be enabled regardless.
    CREATE TABLE IF NOT EXISTS subagent_providers (
      family      TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    -- Self-healing loop failure-memory (Hermes learn stage). One row per distinct
    -- failure SIGNATURE (error-class + normalized message + phase + module ident).
    -- This is the SOURCE OF TRUTH for learned fixes; a human-readable copy is
    -- mirrored into the vault on each newly-verified learn (audit only).
    --
    -- Invariants enforced by failure-memory.ts, NOT the schema:
    --   • 'recoverable'-class + 'vcs'-phase failures are NEVER inserted (noise).
    --   • verified_fix is only set once Verify re-confirms the original symptom
    --     is gone (Verify GATES Learn). observations accrue before that.
    --   • confidence = a stored fix is only blind-trusted at hit_count>=2 with
    --     100% prior verify success; below that it is a PRIOR, not an auto-inject.
    CREATE TABLE IF NOT EXISTS self_heal_memory (
      signature       TEXT PRIMARY KEY,
      phase           TEXT NOT NULL,            -- review | tool | exec | task | infra
      error_class     TEXT NOT NULL,
      module_ident    TEXT,                     -- coarse module/fn identity (collision guard)
      sample_msg      TEXT,                      -- scrubbed representative message
      observations    INTEGER NOT NULL DEFAULT 1,
      verify_pass     INTEGER NOT NULL DEFAULT 0,
      verify_fail     INTEGER NOT NULL DEFAULT 0,
      verify_sessions TEXT NOT NULL DEFAULT '[]', -- capped JSON array of distinct session/run ids
      verified_fix    TEXT,                      -- the guidance that made Verify pass
      status          TEXT NOT NULL DEFAULT 'observing', -- observing | learned | demoted
      first_seen      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      last_seen       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      last_verified   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_self_heal_phase  ON self_heal_memory(phase);
    CREATE INDEX IF NOT EXISTS idx_self_heal_status ON self_heal_memory(status);

    -- v1.4: long-term memory index. Mirrors notes that live in NeuroVault MCP.
    -- One row per memory; vault_note_id/vault_path point at the canonical copy.
    CREATE TABLE IF NOT EXISTS memory_index (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      title         TEXT NOT NULL,
      summary       TEXT,
      tags          TEXT,
      importance    REAL DEFAULT 0.5,
      salience      REAL DEFAULT 0.5,
      agent_id      TEXT REFERENCES agents(id),
      session_id    TEXT REFERENCES sessions(id),
      vault_note_id TEXT,
      vault_path    TEXT,
      created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      last_accessed TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_index_session ON memory_index(session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_index_agent   ON memory_index(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_index_type    ON memory_index(type);
    CREATE INDEX IF NOT EXISTS idx_memory_index_recent  ON memory_index(created_at DESC);

    -- v1.7: FTS5 full-text index over memory_index. Replaces the old LIKE %q%
    -- lexical pass with proper BM25 ranking + porter stemming + unicode-aware
    -- tokenization, so "configures" matches "configured", "discord" matches
    -- "Discord", multi-word queries get scored by term-frequency / inverse-
    -- document-frequency, etc. This is the *keyword half* of hybrid search;
    -- the vector cosine half remains on memory_index.embedding.
    --
    -- Schema notes:
    --   - We use a non-external-content FTS5 table because memory_index keys
    --     on TEXT id, not the integer rowid that external-content requires.
    --     The marginal storage cost (duplicated title/summary/tags) is fine.
    --   - memory_id stays UNINDEXED — it's the join key back to memory_index,
    --     not part of the searchable corpus.
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_index_fts USING fts5(
      memory_id UNINDEXED,
      title,
      summary,
      tags,
      tokenize = 'porter unicode61'
    );

    -- Triggers keep the FTS5 mirror in sync with memory_index. Using DELETE+
    -- INSERT for updates is simpler than the FTS5 'delete' command and works
    -- the same in better-sqlite3.
    CREATE TRIGGER IF NOT EXISTS memory_index_fts_ai AFTER INSERT ON memory_index BEGIN
      INSERT INTO memory_index_fts (memory_id, title, summary, tags)
      VALUES (new.id, new.title, COALESCE(new.summary, ''), COALESCE(new.tags, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_fts_ad AFTER DELETE ON memory_index BEGIN
      DELETE FROM memory_index_fts WHERE memory_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_fts_au AFTER UPDATE OF title, summary, tags ON memory_index BEGIN
      DELETE FROM memory_index_fts WHERE memory_id = old.id;
      INSERT INTO memory_index_fts (memory_id, title, summary, tags)
      VALUES (new.id, new.title, COALESCE(new.summary, ''), COALESCE(new.tags, ''));
    END;

    -- v1.5: live model catalog. Refreshed hourly from each provider's /v1/models
    -- (or hardcoded list, for providers with no API). tier_overridden=1 means
    -- the user has manually pinned the tier; auto-classify will not change it.
    CREATE TABLE IF NOT EXISTS model_catalog (
      id              TEXT PRIMARY KEY,    -- 'provider:model_id'
      provider        TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      tier            TEXT NOT NULL DEFAULT 'mid',
      tier_overridden INTEGER NOT NULL DEFAULT 0,
      context_window  INTEGER,
      is_available    INTEGER NOT NULL DEFAULT 1,
      last_seen_at    TEXT,
      media_type      TEXT,                -- 'image'|'video'|'audio'|NULL(chat); set from provider metadata
      created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_model_catalog_provider ON model_catalog(provider);
    CREATE INDEX IF NOT EXISTS idx_model_catalog_tier     ON model_catalog(tier);

    -- v1.5: model spend log. One row per LLM call. Used by the budget guard
    -- and the future spend dashboard.
    CREATE TABLE IF NOT EXISTS model_spend (
      id            TEXT PRIMARY KEY,
      provider      TEXT NOT NULL,
      model_id      TEXT NOT NULL,
      tier          TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      agent_id      TEXT,
      session_id    TEXT,
      created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_model_spend_session ON model_spend(session_id);
    CREATE INDEX IF NOT EXISTS idx_model_spend_recent  ON model_spend(created_at DESC);
    -- Wave-3 Item F: per-agent rolling-window spend guard (spendForAgentWindow).
    -- MANDATORY: without this the WHERE agent_id=? AND created_at>? query
    -- range-scans the created_at index and residual-filters agent_id across
    -- every agent's rows — a real per-claim cost the moment AGENT_BUDGET_ENABLED
    -- flips. Ships regardless of budget value; "default OFF" doesn't cover it.
    CREATE INDEX IF NOT EXISTS idx_model_spend_agent_window ON model_spend(agent_id, created_at);

    -- v1.5: PARA areas. Used by the dashboard's PARA Map page to organize
    -- agents into themed rooms (Lifestyle, Finance, Health, Work, Learning).
    CREATE TABLE IF NOT EXISTS areas (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      icon_glyph  TEXT NOT NULL DEFAULT '◈',
      color_token TEXT NOT NULL DEFAULT 'neon',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    -- v2.2: remote approval queue. Pending tool-call approvals are created
    -- here so the user can approve/deny them from the dashboard instead of
    -- needing an interactive terminal. agent_id/agent_name/session_id are
    -- nullable so the table is usable even before a full agent context is
    -- available. tool_input is a JSON string of the call arguments.
    -- status flow: pending → approved | denied
    CREATE TABLE IF NOT EXISTS approvals (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT,
      agent_name  TEXT,
      session_id  TEXT,
      tool_name   TEXT NOT NULL,
      tool_input  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      reason      TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_created_at ON approvals(created_at DESC);

    CREATE TABLE IF NOT EXISTS sentinel_task_state (
      id                     TEXT PRIMARY KEY,
      task_id                TEXT NOT NULL UNIQUE,
      escalation_level       INTEGER NOT NULL DEFAULT 0,
      reminders_sent         INTEGER NOT NULL DEFAULT 0,
      last_check_in_at       TEXT,
      original_agent_id      TEXT,
      reassigned_to_agent_id TEXT,
      agent_response         TEXT,
      blocked_reason         TEXT,
      created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sentinel_task_state_task ON sentinel_task_state(task_id);
    CREATE INDEX IF NOT EXISTS idx_sentinel_task_state_level ON sentinel_task_state(escalation_level);

    CREATE TABLE IF NOT EXISTS job_queue (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL CHECK(type IN ('background_agent', 'cron_run', 'agent_task', 'tts_synthesize', 'memory_extract', 'embedding_generate', 'workflow_run', 'dream_cycle', 'maintenance')),
      payload       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'claimed', 'done', 'failed')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3,
      priority      INTEGER NOT NULL DEFAULT 5,
      run_after     TEXT,                        -- ISO timestamp; NULL = run immediately
      created_at    TEXT NOT NULL,
      claimed_at    TEXT,
      first_claimed_at TEXT,                  -- immutable first-claim time; NOT refreshed by the heartbeat
      completed_at  TEXT,
      result        TEXT,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_job_queue_poll
      ON job_queue(status, priority DESC, created_at ASC);

    -- Audio cache for Kokoro / repeated TTS phrases.
    -- Key: voice + text + speed + model hash.
    CREATE TABLE IF NOT EXISTS audio_cache (
      id         TEXT PRIMARY KEY,
      cache_key  TEXT NOT NULL UNIQUE,
      provider   TEXT NOT NULL,
      voice_id   TEXT NOT NULL,
      model      TEXT NOT NULL,
      text_hash  TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      audio_blob BLOB NOT NULL,
      hit_count  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audio_cache_key ON audio_cache(cache_key);

    -- WS1 prompt-cache stability: the frozen "stable prefix" system prompt per
    -- session::agent pair, replayed byte-identical every turn (and across
    -- restarts) so provider-side prompt caches stay warm. One row per pair,
    -- UPSERT-replaced only when the prompt content hash actually changes.
    CREATE TABLE IF NOT EXISTS session_prompts (
      session_id  TEXT NOT NULL,
      agent_id    TEXT NOT NULL DEFAULT '',
      prompt      TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      PRIMARY KEY (session_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS nclaw_workflow_runs (
      id              TEXT PRIMARY KEY,
      workflow_name   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      started_at      INTEGER,
      ended_at        INTEGER,
      worktree_path   TEXT,
      branch_name     TEXT,
      input           TEXT NOT NULL DEFAULT '',
      error           TEXT,
      outputs         TEXT NOT NULL DEFAULT '{}',
      completed_nodes TEXT NOT NULL DEFAULT '[]',
      paused_at_node  TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nclaw_workflow_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    TEXT NOT NULL,
      node_id   TEXT,
      type      TEXT NOT NULL,
      data      TEXT,
      ts        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wf_events_run ON nclaw_workflow_events(run_id);

    CREATE TABLE IF NOT EXISTS import_sessions (
      id           TEXT PRIMARY KEY,
      source       TEXT NOT NULL,
      filename     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      total        INTEGER NOT NULL DEFAULT 0,
      processed    INTEGER NOT NULL DEFAULT 0,
      created      INTEGER NOT NULL DEFAULT 0,
      skipped      INTEGER NOT NULL DEFAULT 0,
      error        TEXT,
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_import_sessions_started
      ON import_sessions(started_at DESC);

    CREATE TABLE IF NOT EXISTS cli_tools (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      slug            TEXT NOT NULL UNIQUE,
      description     TEXT,
      status          TEXT NOT NULL DEFAULT 'planned',
      install_command TEXT,
      features        TEXT DEFAULT '[]',
      tool_order      INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    -- Agent-generated image archive. The image BYTES live in the Supabase
    -- 'agent-images' private bucket (durable, off-box); this table is the
    -- queryable metadata index that powers the gallery. One row per image an
    -- agent's generation tool produced, with the ORIGINAL prompt. created_at
    -- is epoch ms. storage_path is the object key within the bucket.
    CREATE TABLE IF NOT EXISTS agent_images (
      id           TEXT PRIMARY KEY,
      bucket       TEXT NOT NULL DEFAULT 'agent-images',
      storage_path TEXT NOT NULL,
      prompt       TEXT NOT NULL DEFAULT '',
      alt          TEXT NOT NULL DEFAULT '',
      caption      TEXT,
      source_tool  TEXT NOT NULL DEFAULT '',
      agent_id     TEXT,
      agent_name   TEXT NOT NULL DEFAULT '',
      session_id   TEXT,
      run_id       TEXT,
      mime         TEXT NOT NULL DEFAULT 'image/png',
      bytes        INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      model        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_images_created ON agent_images(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_images_agent   ON agent_images(agent_id);

    -- Codex app-server persistent thread registry.
    -- Non-ephemeral Codex threads survive a \`codex app-server\` child-process
    -- restart on disk under ~/.codex/sessions/, but we need a durable map from
    -- our (session_id, agent_id) pair back to the thread_id. The tool_fingerprint
    -- gates rebuilds: only an actual add/remove of a tool name forces a fresh
    -- thread/start; prompt/model changes ride the per-turn thread/resume override.
    CREATE TABLE IF NOT EXISTS codex_threads (
      session_id       TEXT NOT NULL,
      agent_id         TEXT NOT NULL DEFAULT '',
      thread_id        TEXT NOT NULL,
      tool_fingerprint TEXT NOT NULL,
      last_used_at     TEXT NOT NULL,
      created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_codex_threads_last_used ON codex_threads(last_used_at);
  `);
  // Durable chat-document attachments (PDF/DOCX/EPUB/HTML uploaded via dashboard
  // or Discord). The attachment-registry keeps a hot in-memory cache, but this
  // table is the source of truth so uploads — and their server-side parse —
  // survive a process restart mid-conversation (e.g. Discord follow-up turns).
  // Bytes are stored as a BLOB; the parsed markdown is cached so re-feeding the
  // same document on a later turn never re-parses. created_at is epoch ms.
  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      name            TEXT NOT NULL,
      mime            TEXT NOT NULL,
      size            INTEGER NOT NULL,
      bytes           BLOB,
      disk_path       TEXT,
      parsed_title    TEXT,
      parsed_markdown TEXT,
      parsed_stats    TEXT,
      parsed_at       INTEGER,
      parse_error     TEXT,
      -- spec: uploaded-document-handling-overhaul — decouple RAW-file lifecycle
      -- from PARSED-content lifecycle. storage_* point at the Supabase 'chat-docs'
      -- bucket object; raw_expires_at drives the raw-only prune. parsed_markdown +
      -- doc_chunks (pgvector) persist INDEPENDENTLY and are never dropped by the
      -- raw-file sweep. parse_status/parse_attempts drive the background re-parse.
      storage_bucket  TEXT,
      storage_path    TEXT,
      raw_expires_at  INTEGER,
      parse_status    TEXT,
      parse_attempts  INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_session ON chat_attachments(session_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_attachments_session_hash ON chat_attachments(session_id, content_hash);
  `);

  // Universal inbound-upload manifest — one row per persisted upload (any type)
  // from Discord or the web GUI. The bytes live as a file in the per-session
  // workspace (rel_path); this table is the queryable index. See session-uploads.ts.
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_uploads (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      agent_id      TEXT,
      source        TEXT NOT NULL,
      name          TEXT NOT NULL,
      mime          TEXT,
      size          INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      rel_path      TEXT,
      content_hash  TEXT,
      processed     TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_uploads_session ON session_uploads(session_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_uploads_hash ON session_uploads(session_id, content_hash);
  `);

  // v4.1: durable synchronous agent hand-off recovery (message_agent / execute_now).
  // Write-ahead recovery record so a restart can harvest a peer turn's output from
  // its child session instead of re-running it. Terminal rows are pruned by the
  // handoff-archivist after HANDOFF_RECOVERY_TTL_DAYS.
  database.exec(`
    CREATE TABLE IF NOT EXISTS handoff_recovery (
      id                  TEXT PRIMARY KEY,
      caller_session_id   TEXT,
      caller_agent_id     TEXT,
      caller_run_id       TEXT,
      target_agent_id     TEXT NOT NULL,
      target_session_id   TEXT NOT NULL,
      message             TEXT NOT NULL,
      source              TEXT NOT NULL CHECK(source IN ('message_agent', 'execute_now')),
      agent_message_id    TEXT,
      task_id             TEXT,
      parent_handoff_id   TEXT REFERENCES handoff_recovery(id),
      depth               INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'running'
                          CHECK(status IN ('running', 'done', 'failed', 'orphaned')),
      response            TEXT,
      error               TEXT,
      created_at          TEXT NOT NULL,
      heartbeat_at        INTEGER NOT NULL,
      completed_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_handoff_recovery_poll    ON handoff_recovery(status, heartbeat_at);
    CREATE INDEX IF NOT EXISTS idx_handoff_recovery_target  ON handoff_recovery(target_session_id);
    CREATE INDEX IF NOT EXISTS idx_handoff_recovery_parent  ON handoff_recovery(parent_handoff_id);
  `);

  logger.info('Database schema initialized');
}

function runMigrations(database: Database.Database): void {
  const alters = [
    "ALTER TABLE agents ADD COLUMN role TEXT DEFAULT 'agent'",
    "ALTER TABLE agents ADD COLUMN capabilities TEXT DEFAULT '[]'",
    "ALTER TABLE agents ADD COLUMN temporary INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN spawn_depth INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN parent_agent_id TEXT",
    "ALTER TABLE agents ADD COLUMN created_by_agent_id TEXT",
    "ALTER TABLE agents ADD COLUMN expires_at TEXT",
    'ALTER TABLE messages ADD COLUMN agent_id TEXT',
    "ALTER TABLE agents ADD COLUMN provider TEXT DEFAULT 'openai'",
    'ALTER TABLE agents ADD COLUMN exec_enabled INTEGER DEFAULT 0',
    'ALTER TABLE agents ADD COLUMN chat_mode INTEGER DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN chat_mode INTEGER',
    "ALTER TABLE agents ADD COLUMN model_tier TEXT DEFAULT 'pinned'",
    'ALTER TABLE model_catalog ADD COLUMN cost_per_1k_input REAL',
    'ALTER TABLE model_catalog ADD COLUMN cost_per_1k_output REAL',
    // WS1: provider-reported prompt-cache hits per call. Lets the usage page
    // show whether the stable-prefix work is actually producing cache reads.
    'ALTER TABLE model_spend ADD COLUMN cached_input_tokens INTEGER DEFAULT 0',
    // Studio Phase 1: per-call USD cost for image generation and other non-token spend.
    'ALTER TABLE model_spend ADD COLUMN cost_usd REAL DEFAULT 0',
    // Abacus compute-point metering: Abacus has no usage API, so we record its
    // per-call reported compute points (resp.usage.compute_points_used) into the
    // durable spend ledger and sum them over the billing cycle. See abacus-usage.ts.
    'ALTER TABLE model_spend ADD COLUMN compute_points INTEGER DEFAULT 0',
    'ALTER TABLE model_catalog ADD COLUMN price_overridden INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE agents ADD COLUMN area_id TEXT',
    "ALTER TABLE agents ADD COLUMN skills TEXT DEFAULT '[]'",
    'ALTER TABLE agents ADD COLUMN last_heartbeat_at TEXT',
    "ALTER TABLE agents ADD COLUMN heartbeat_status TEXT DEFAULT 'never'",
    'ALTER TABLE agents ADD COLUMN heartbeat_latency_ms INTEGER',
    // Composio (v1.7) — per-agent identity + toolkit gating. composio_toolkits
    // is a JSON array; null means "all available toolkits" (Composio default).
    'ALTER TABLE agents ADD COLUMN composio_enabled INTEGER DEFAULT 0',
    'ALTER TABLE agents ADD COLUMN composio_user_id TEXT',
    'ALTER TABLE agents ADD COLUMN composio_toolkits TEXT',
    // v1.7: real embeddings on the memory index. Vector lives as a packed
    // Float32 BLOB; embedding_model lets us re-embed when the model changes.
    'ALTER TABLE memory_index ADD COLUMN embedding BLOB',
    'ALTER TABLE memory_index ADD COLUMN embedding_model TEXT',
    // v1.7: graph-lite — entities + relationships extracted alongside each memory.
    // Lifts Graphiti's auto-extraction principle without taking on Neo4j. The
    // extractor folds entity/relationship discovery into its existing JSON
    // response so there's no extra LLM call. Two-table schema is enough for
    // the queries we'd want a graph for at this scale; sqlite-vec or Neo4j
    // is the documented escape hatch when traversal queries get expensive.
    `CREATE TABLE IF NOT EXISTS memory_entities (
      id           TEXT PRIMARY KEY,
      memory_id    TEXT NOT NULL REFERENCES memory_index(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      entity_type  TEXT,
      created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_memory_entities_memory ON memory_entities(memory_id)',
    'CREATE INDEX IF NOT EXISTS idx_memory_entities_name   ON memory_entities(name COLLATE NOCASE)',
    `CREATE TABLE IF NOT EXISTS memory_relationships (
      id           TEXT PRIMARY KEY,
      memory_id    TEXT NOT NULL REFERENCES memory_index(id) ON DELETE CASCADE,
      subject      TEXT NOT NULL,
      verb         TEXT NOT NULL,
      object       TEXT NOT NULL,
      confidence   REAL DEFAULT 0.7,
      valid_from   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      valid_to     TEXT,                       -- nullable; null = still true
      created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_memory_rel_memory  ON memory_relationships(memory_id)',
    'CREATE INDEX IF NOT EXISTS idx_memory_rel_subject ON memory_relationships(subject COLLATE NOCASE)',
    'CREATE INDEX IF NOT EXISTS idx_memory_rel_object  ON memory_relationships(object  COLLATE NOCASE)',

    // v1.7: per-bot list of guild ids where the bot replies WITHOUT requiring
    // an @mention. Useful for private "agent servers" where it's just you and
    // the bot. JSON array; empty/null means "mention required everywhere".
    'ALTER TABLE discord_bots ADD COLUMN auto_reply_guilds TEXT',
    // v1.7: per-channel "still require an @mention here" flag. Useful when a
    // server has auto-reply on AND multiple bots share the server — opt
    // specific channels back into mention-only behavior so the bots don't
    // talk over each other.
    'ALTER TABLE discord_channel_routes ADD COLUMN require_mention INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE discord_channel_routes ADD COLUMN auto_reply INTEGER NOT NULL DEFAULT 0',

    // v1.7: multi-bot Discord integration. Each row in discord_bots is a
    // separate gateway connection (its own bot token, its own identity).
    // Channel routing lives in discord_channel_routes so an agent — or a
    // user via the dashboard — can change which NeuroClaw agent handles
    // which channel without restarting the bot manager.
    `CREATE TABLE IF NOT EXISTS discord_bots (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      token               TEXT NOT NULL,           -- bot token (sensitive; SQLite is 0600)
      application_id      TEXT,                    -- Discord Developer Portal application id
      default_agent_id    TEXT REFERENCES agents(id),
      enabled             INTEGER NOT NULL DEFAULT 1,
      created_by_agent_id TEXT REFERENCES agents(id),
      created_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      last_started_at     TEXT,
      status              TEXT NOT NULL DEFAULT 'idle',  -- idle | connecting | ready | error | disabled
      status_detail       TEXT,
      bot_user_id         TEXT,                    -- discord user id of the bot once connected
      bot_user_tag        TEXT                     -- "BotName#1234" once connected
    )`,
    'CREATE INDEX IF NOT EXISTS idx_discord_bots_enabled ON discord_bots(enabled)',

    `CREATE TABLE IF NOT EXISTS discord_channel_routes (
      id          TEXT PRIMARY KEY,
      bot_id      TEXT NOT NULL REFERENCES discord_bots(id) ON DELETE CASCADE,
      channel_id  TEXT NOT NULL,                   -- Discord channel id
      agent_id    TEXT NOT NULL REFERENCES agents(id),
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE (bot_id, channel_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_discord_routes_bot ON discord_channel_routes(bot_id)',
    // v1.7: per-agent vision mode. 'auto' lets us decide based on the model's
    // known vision capability + provider. 'native' forces the multi-modal
    // path; 'preprocess' always routes images through VISION_MODEL first
    // (described as text), then sends the description to the agent.
    "ALTER TABLE agents ADD COLUMN vision_mode TEXT DEFAULT 'auto'",
    // dual vision pipeline: per-agent preprocessor provider. NULL = inherit the
    // global VISION_PROVIDER. 'openrouter' = Gemini pipeline, 'hermes' = Grok
    // pipeline, 'voidai' = legacy gpt-4o escape hatch. Idempotent via the
    // try/catch loop below (same pattern as vision_mode).
    'ALTER TABLE agents ADD COLUMN vision_provider TEXT',
    // per-agent tool elevation: JSON array of tool names to surface upfront
    // ("core") for this agent, on top of the global core set. NULL/empty =
    // default behavior. See docs/specs/per-agent-image-tools-spec.md (Fix 3).
    // Idempotent via the try/catch loop below (same pattern as vision_provider).
    'ALTER TABLE agents ADD COLUMN extra_core_tools TEXT',

    // v1.8: per-agent voice (TTS). When tts_enabled=1, the dashboard exposes a
    // speaker button on the agent's messages and the Discord bot can attach a
    // synthesized .mp3 to replies (gated additionally by discord_bots.voice_enabled).
    'ALTER TABLE agents ADD COLUMN tts_enabled INTEGER DEFAULT 0',
    "ALTER TABLE agents ADD COLUMN tts_provider TEXT DEFAULT 'voidai'",
    'ALTER TABLE agents ADD COLUMN tts_voice TEXT',
    // v1.8: per-bot voice toggle. Lets a bot ignore its agents' tts_enabled
    // (e.g. a text-only support channel) without flipping every agent.
    'ALTER TABLE discord_bots ADD COLUMN voice_enabled INTEGER DEFAULT 0',
    // v2.3: spawn gating — exempt agents bypass evaluateSpawn() LLM check
    'ALTER TABLE agents ADD COLUMN spawn_exempt INTEGER DEFAULT 0',

    // v1.8.1: per-(bot, user) voice override. Lets a Discord user say "stop
    // sending audio" and have it stick — without flipping the global bot or
    // agent toggle. Resolution order before attaching .mp3:
    //   bot.voice_enabled = 0           → no audio (bot-wide off)
    //   agent.tts_enabled = 0           → no audio (agent-wide off)
    //   discord_voice_prefs row exists  → that row's voice_enabled wins
    //   else                            → audio attached
    `CREATE TABLE IF NOT EXISTS discord_voice_prefs (
      bot_id        TEXT NOT NULL REFERENCES discord_bots(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL,
      voice_enabled INTEGER NOT NULL DEFAULT 1,
      reason        TEXT,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      PRIMARY KEY (bot_id, user_id)
    )`,

    // v1.9 (Archon port — PR 1): projects + richer task schema. See README
    // "The-Code-Labz Stack Integration Plan" → Archon → Schema gap. Goals:
    //   - own the data Archon's MCP previously held (projects, subtasks,
    //     RAG-on-tasks via sources/code_examples JSON, soft delete, free-text
    //     assignee, task_order for drag-reorder) so the external Archon MCP
    //     can be retired in PR 5.
    //   - keep all existing tasks rows valid: every column is additive with
    //     a sane default, plus a backfill below assigns them to a default
    //     "NeuroClaw" project.
    `CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      description  TEXT,
      docs         TEXT DEFAULT '[]',           -- JSON array
      features     TEXT DEFAULT '[]',           -- JSON array
      data         TEXT DEFAULT '{}',           -- JSON object (free-form metadata)
      github_repo  TEXT,
      pinned       INTEGER NOT NULL DEFAULT 0,
      archived     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_projects_pinned   ON projects(pinned DESC, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived)',

    // tasks: Archon-shape extensions
    'ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)',
    'ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id)',
    "ALTER TABLE tasks ADD COLUMN assignee TEXT NOT NULL DEFAULT 'User'",
    'ALTER TABLE tasks ADD COLUMN task_order INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN feature TEXT',
    "ALTER TABLE tasks ADD COLUMN sources TEXT DEFAULT '[]'",
    "ALTER TABLE tasks ADD COLUMN code_examples TEXT DEFAULT '[]'",
    'ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN archived_at TEXT',
    'ALTER TABLE tasks ADD COLUMN archived_by TEXT',
    // priority_level is the Archon-style enum stored alongside the legacy
    // numeric priority (0-100). Both columns coexist for one release; the
    // new UI reads priority_level, the existing API still accepts numeric.
    "ALTER TABLE tasks ADD COLUMN priority_level TEXT DEFAULT 'medium'",
    'CREATE INDEX IF NOT EXISTS idx_tasks_project   ON tasks(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_parent    ON tasks(parent_task_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_archived  ON tasks(archived)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_status_order ON tasks(status, task_order ASC)',

    // spec: sub-agent-blocked-outcome — terminal_outcome distinguishes
    // blocked (progress-only) from usable done results
    'ALTER TABLE tasks ADD COLUMN terminal_outcome TEXT',
    // spec: task-status-extension — block_reason for blocked/cancelled tasks
    'ALTER TABLE tasks ADD COLUMN block_reason TEXT',
    // spec: task-notify-policy — per-task delivery control
    "ALTER TABLE tasks ADD COLUMN notify_policy TEXT NOT NULL DEFAULT 'done_only'",
    // spec: task-sweep-grace-periods — sweep metadata columns
    'ALTER TABLE tasks ADD COLUMN child_session_key TEXT',
    'ALTER TABLE tasks ADD COLUMN last_heartbeat_at INTEGER',
    'ALTER TABLE tasks ADD COLUMN recovery_started_at INTEGER',
    'ALTER TABLE tasks ADD COLUMN provider TEXT',

    // v1.9 (MCP server registry): user-managed remote MCP servers. Each row is
    // a Streamable-HTTP MCP endpoint we periodically probe; cached tool list
    // is exposed to every agent runtime via mcp__<server>__<tool> naming. Runs
    // alongside the legacy NEUROVAULT_MCP_URL env-driven path — the two do
    // not share state.
    `CREATE TABLE IF NOT EXISTS mcp_servers (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      url            TEXT NOT NULL,
      transport      TEXT NOT NULL DEFAULT 'auto',
      headers        TEXT,
      enabled        INTEGER NOT NULL DEFAULT 1,
      status         TEXT NOT NULL DEFAULT 'unknown',
      status_detail  TEXT,
      tools_cached   TEXT,
      tools_count    INTEGER NOT NULL DEFAULT 0,
      last_probed_at TEXT,
      created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled)',

    // MCP-backed agents: an agent whose provider='mcp' proxies calls to a
    // remote MCP server tool. mcp_server_id points to the mcp_servers table;
    // mcp_tool_name is the tool to invoke; mcp_input_field is the JSON key
    // used to pass the user's message (defaults to 'query').
    'ALTER TABLE agents ADD COLUMN mcp_server_id TEXT REFERENCES mcp_servers(id)',
    'ALTER TABLE agents ADD COLUMN mcp_tool_name TEXT',
    "ALTER TABLE agents ADD COLUMN mcp_input_field TEXT DEFAULT 'query'",
    'ALTER TABLE agents ADD COLUMN avatar_url TEXT',

    // v3.6: dashboard speed-up — indexes for live stream + filter queries
    'CREATE INDEX IF NOT EXISTS idx_hive_created_at ON hive_mind(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_hive_action_created ON hive_mind(action, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at DESC)',
    // NOTE: idx_debug_session_created and idx_debug_agent_created are created
    // AFTER the debug_logs CREATE TABLE below (line ~791) to avoid "no such table"
    // errors on DBs that run these migrations before the table exists.

    // v2.0 (run grouping): give every event in hive_mind a back-pointer to the
    // user-turn it belongs to, so we can replay an entire run in one query.
    // The runs table itself is created in initSchema (idempotent CREATE IF NOT
    // EXISTS); this ALTER handles existing DBs whose hive_mind predates it.
    'ALTER TABLE hive_mind ADD COLUMN run_id TEXT REFERENCES runs(id)',
    'CREATE INDEX IF NOT EXISTS idx_hive_run     ON hive_mind(run_id)',
    'CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_runs_status  ON runs(status)',

    // v2.1: stable external key on sessions so integrations (Discord bot, etc.)
    // can look up their session by a deterministic string (e.g.
    // "discord::botId::channelId::userId") and survive process restarts without
    // losing conversation history. UNIQUE so a mis-fire never creates duplicates.
    'ALTER TABLE sessions ADD COLUMN external_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_external ON sessions(external_id)',

    // v2.4: per-bot voice-channel-join toggle. Defaults to 1 (enabled) so
    // existing bots gain voice channel capability without manual config.
    // Set to 0 to keep a bot text-only even when voice routes are configured.
    'ALTER TABLE discord_bots ADD COLUMN voice_channel_enabled INTEGER DEFAULT 1',

    // v2.5: attribute hive_mind events to their originating session so
    // getCrossSessionContext() can query an agent's parallel session activity.
    'ALTER TABLE hive_mind ADD COLUMN session_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_hive_session ON hive_mind(session_id)',

    // v3.0: automation layer — cron jobs + inbound webhooks + run history.
    `CREATE TABLE IF NOT EXISTS cron_jobs (
      id                      TEXT PRIMARY KEY,
      name                    TEXT NOT NULL,
      description             TEXT,
      schedule                TEXT,
      enabled                 INTEGER NOT NULL DEFAULT 1,
      job_type                TEXT NOT NULL,
      config                  TEXT NOT NULL DEFAULT '{}',
      inbound_slug            TEXT,
      on_complete_webhook_url TEXT,
      created_by              TEXT NOT NULL DEFAULT 'user',
      last_run_at             TEXT,
      next_run_at             TEXT,
      created_at              TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at              TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_jobs_slug ON cron_jobs(inbound_slug) WHERE inbound_slug IS NOT NULL',
    `CREATE TABLE IF NOT EXISTS cron_runs (
      id                       TEXT PRIMARY KEY,
      job_id                   TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
      status                   TEXT NOT NULL DEFAULT 'running',
      triggered_by             TEXT NOT NULL DEFAULT 'schedule',
      output                   TEXT,
      error_text               TEXT,
      duration_ms              INTEGER,
      outbound_webhook_status  INTEGER,
      started_at               TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      ended_at                 TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id)',

    // v3.1: analyst alerts (Stephanie) — persistent health/insight records.
    `CREATE TABLE IF NOT EXISTS analyst_alerts (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL CHECK (type IN ('overload','idle','role_drift','recommend_spawn')),
      agent_id     TEXT,
      severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
      message      TEXT NOT NULL,
      metadata     TEXT,
      created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      dismissed_at TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_analyst_alerts_created   ON analyst_alerts(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_analyst_alerts_dismissed ON analyst_alerts(dismissed_at)',
  `CREATE TABLE IF NOT EXISTS downtime_events (
    id                TEXT PRIMARY KEY,
    type              TEXT NOT NULL,
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    duration_minutes  REAL,
    severity          TEXT DEFAULT 'warning',
    summary           TEXT,
    metadata          TEXT,
    created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_downtime_started ON downtime_events(started_at)',
  `CREATE TABLE IF NOT EXISTS debug_logs (
    id         TEXT PRIMARY KEY,
    session_id TEXT,
    agent_id   TEXT,
    source     TEXT NOT NULL DEFAULT 'system',
    message    TEXT NOT NULL,
    data       TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_debug_logs_created_at ON debug_logs(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_debug_logs_source     ON debug_logs(source)',
  'CREATE INDEX IF NOT EXISTS idx_debug_session_created ON debug_logs(session_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_debug_agent_created   ON debug_logs(agent_id,   created_at DESC)',
  'ALTER TABLE tasks ADD COLUMN reviewer_feedback TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3',
  'ALTER TABLE tasks ADD COLUMN output TEXT',
  // Gemini Live voice provider
  "ALTER TABLE agents ADD COLUMN voice_provider TEXT DEFAULT 'default'",
  "ALTER TABLE agents ADD COLUMN gemini_live_voice TEXT DEFAULT 'Zephyr'",
  'ALTER TABLE agents ADD COLUMN gemini_tools_enabled INTEGER DEFAULT 1',

  // ── v3.2 (dashboard chat reliability overhaul) ─────────────────────────
  // Resumable runs: heartbeats, partial output checkpointing, detach-on-
  // client-disconnect, and per-agent / per-session turn budgets. Status
  // values 'paused' | 'detached' | 'dropped' added via table-recreation
  // migration further down (CHECK constraint change requires it).
  'ALTER TABLE runs ADD COLUMN current_activity TEXT',
  'ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT',
  'ALTER TABLE runs ADD COLUMN partial_output TEXT',
  'ALTER TABLE runs ADD COLUMN turn_number INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN detached_at TEXT',
  // ── Background-generation delivery (run re-delivery to Discord) ────────
  'ALTER TABLE runs ADD COLUMN delivery_target TEXT',
  'ALTER TABLE runs ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0',
  // Per-agent turn budgets (soft = checkpoint+pause; hard = stop).
  // workload_profile picks defaults from WORKLOAD_PRESETS when explicit
  // soft/hard are null. See src/agent/turn-budget.ts.
  'ALTER TABLE agents ADD COLUMN max_turns_soft INTEGER',
  'ALTER TABLE agents ADD COLUMN max_turns_hard INTEGER',
  "ALTER TABLE agents ADD COLUMN workload_profile TEXT DEFAULT 'normal'",
  // Token-optimization directives (spec 2026-07-10, Component A). Opt-in per
  // agent; default OFF so prose/user-facing agents keep their normal voice.
  'ALTER TABLE agents ADD COLUMN optimize_terse INTEGER DEFAULT 0',
  'ALTER TABLE agents ADD COLUMN optimize_lean_code INTEGER DEFAULT 0',
  // Per-session override (rare — used when a single conversation needs a
  // bigger budget than the agent's default).
  'ALTER TABLE sessions ADD COLUMN max_turns_override INTEGER',
  'CREATE INDEX IF NOT EXISTS idx_runs_heartbeat ON runs(status, last_heartbeat_at)',

  // ── nc-broker v3 (secrets broker) ───────────────────────────────────────
  // Canonical agent prefix used by the broker scope resolver. NULL means the
  // agent has not been registered with a broker prefix yet — the agent will
  // only be able to access SHARED_* and NEUROCLAW_* secrets until a prefix
  // is set via /api/broker/admin/agents/:id/prefix.
  'ALTER TABLE agents ADD COLUMN canonical_prefix TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_canonical_prefix ON agents(canonical_prefix) WHERE canonical_prefix IS NOT NULL',
  // v3.3: per-agent Composio tool allowlist + per-agent token budget.
  // composio_tool_allowlist: JSON string[] of glob patterns (e.g. ["GITHUB_*", "SLACK_SEND_MESSAGE"]).
  //   null = no tool-name filter (all tools from the session surface are eligible).
  // composio_token_budget:   max Composio tools to inject for this agent.
  //   null = fall back to COMPOSIO_MAX_TOOLS env var (default 40).
  'ALTER TABLE agents ADD COLUMN composio_tool_allowlist TEXT',
  'ALTER TABLE agents ADD COLUMN composio_token_budget INTEGER',

  // ── Skill telemetry (Pillar 3 of MED skill plan) ──────────────────────────
  // Records every skill-body injection into an agent's system prompt. Passive
  // — no throttling or warnings, just data. Used by the Skills health view to
  // surface fire counts, last-used timestamps, and per-tier usage patterns.
  // Indexed for the common queries (by skill_name, by injected_at).
  `CREATE TABLE IF NOT EXISTS skill_invocations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_name  TEXT NOT NULL,
    agent_id    TEXT,
    session_id  TEXT,
    tier        TEXT,
    source      TEXT,
    injected_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_skill_inv_name ON skill_invocations(skill_name)',
  'CREATE INDEX IF NOT EXISTS idx_skill_inv_when ON skill_invocations(injected_at)',
  'CREATE INDEX IF NOT EXISTS idx_skill_inv_agent ON skill_invocations(agent_id, skill_name)',

  // v3.x: session source classification (immutable origin, set at creation)
  // + memory-archive progress tracking for the Curator / cleanup.
  'ALTER TABLE sessions ADD COLUMN source TEXT',
  'ALTER TABLE sessions ADD COLUMN archived_at TEXT',
  'ALTER TABLE sessions ADD COLUMN archived_message_count INTEGER DEFAULT 0',

  // kimi-api provider: chat_capable flag on model_catalog lets triage skip
  // embedding-only or non-chat models (default 1 = chat-capable so existing
  // rows stay valid without a data migration).
  'ALTER TABLE model_catalog ADD COLUMN chat_capable INTEGER NOT NULL DEFAULT 1',

  // Media-model category (image|video|audio), set from provider /v1/models
  // metadata (e.g. Abacus model_type). NULL = chat/text model. Lets media tools
  // list valid models per category and the dashboard badge them.
  'ALTER TABLE model_catalog ADD COLUMN media_type TEXT',

  // spec: task-management-overhaul — source tracking + archon ID cross-reference
  "ALTER TABLE tasks ADD COLUMN task_source TEXT DEFAULT 'dashboard'",
  'ALTER TABLE tasks ADD COLUMN archon_task_id TEXT DEFAULT NULL',
  'CREATE INDEX IF NOT EXISTS idx_tasks_archon_id ON tasks(archon_task_id) WHERE archon_task_id IS NOT NULL',

  // perf: composite indexes for the two most common hot-path queries —
  //   tasks:     getTasksByAgentId() + status-filter (e.g. active tasks per agent)
  //   hive_mind: session-scoped event replay (dashboard + curator)
  'CREATE INDEX IF NOT EXISTS idx_tasks_agent_status   ON tasks(agent_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_hive_session_action  ON hive_mind(session_id, action)',
  // perf: sessions list + per-session last-message preview (routes.ts /api/sessions)
  'CREATE INDEX IF NOT EXISTS idx_sessions_updated_at        ON sessions(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_session_created   ON messages(session_id, created_at DESC)',
  // spec: session-naming — title provenance (default placeholder | auto-generated | user-set)
  // and pin flag. title_source drives the auto-titler's "never clobber a manual rename" guard.
  "ALTER TABLE sessions ADD COLUMN title_source TEXT DEFAULT 'default'",
  'ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0',

  // spec: uploaded-document-handling-overhaul — raw/parsed lifecycle decouple.
  // storage_* reference the Supabase 'chat-docs' bucket object (raw file, 24h TTL
  // touch-to-extend); parsed_markdown + doc_chunks persist independently. The raw
  // prune clears storage_path/bytes/raw_expires_at only — never the parsed cols.
  'ALTER TABLE chat_attachments ADD COLUMN storage_bucket TEXT',
  'ALTER TABLE chat_attachments ADD COLUMN storage_path TEXT',
  'ALTER TABLE chat_attachments ADD COLUMN raw_expires_at INTEGER',
  'ALTER TABLE chat_attachments ADD COLUMN parse_status TEXT',
  'ALTER TABLE chat_attachments ADD COLUMN parse_attempts INTEGER NOT NULL DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_chat_attachments_raw_expires ON chat_attachments(raw_expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_chat_attachments_parse_status ON chat_attachments(parse_status)',

  // spec: ssh-machine-connections — agent SSH capability + machine registry.
  // Per-agent ssh_enabled mirrors exec_enabled (DB-driven capability gate).
  // ssh_machines holds METADATA ONLY — the private key/password lives in the
  // broker as SHARED_SSH_<name>_KEY / _PASSWORD; secret_name references it and
  // is resolved at call time via broker.withSecrets (never enters agent ctx).
  // host_fingerprint is TOFU-pinned on first connect (refuse + alert on mismatch).
  'ALTER TABLE agents ADD COLUMN ssh_enabled INTEGER DEFAULT 0',
  // Fresh DBs get the full §11.1 schema; existing dormant DBs are brought up via
  // the idempotent ADD COLUMN block below (ALTER, not DROP/recreate — ASAGI).
  `CREATE TABLE IF NOT EXISTS ssh_machines (
     id                     TEXT PRIMARY KEY,
     name                   TEXT NOT NULL,
     host                   TEXT NOT NULL,
     port                   INTEGER NOT NULL DEFAULT 22,
     username               TEXT NOT NULL,
     auth_method            TEXT NOT NULL DEFAULT 'key',
     secret_name            TEXT NOT NULL,
     passphrase_secret_name TEXT,
     host_fingerprint       TEXT,
     fingerprint_status     TEXT NOT NULL DEFAULT 'pending_verification',
     sensitivity            TEXT NOT NULL DEFAULT 'low',
     allowed_agents         TEXT NOT NULL DEFAULT '[]',
     disabled               INTEGER NOT NULL DEFAULT 0,
     legacy_algos           INTEGER NOT NULL DEFAULT 0,
     jump_host              TEXT,
     tags                   TEXT DEFAULT '[]',
     notes                  TEXT,
     last_connected_at      TEXT,
     created_at             TEXT NOT NULL,
     updated_at             TEXT NOT NULL
   )`,
  // §11.1 decouple/hardening columns — idempotent ADD COLUMN (swallow-on-duplicate).
  // allowed_agents is the fail-closed containment layer; sensitivity drives confirm-before-run.
  `ALTER TABLE ssh_machines ADD COLUMN passphrase_secret_name TEXT`,
  `ALTER TABLE ssh_machines ADD COLUMN fingerprint_status TEXT NOT NULL DEFAULT 'pending_verification'`,
  `ALTER TABLE ssh_machines ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'low'`,
  `ALTER TABLE ssh_machines ADD COLUMN allowed_agents TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE ssh_machines ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ssh_machines ADD COLUMN legacy_algos INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ssh_machines ADD COLUMN jump_host TEXT`,
  'CREATE INDEX IF NOT EXISTS idx_ssh_machines_name ON ssh_machines(name)',
  // §11.3 ssh_audit — dedicated typed/indexed forensic table (hive_mind blob is wrong shape).
  `CREATE TABLE IF NOT EXISTS ssh_audit (
     id                 TEXT PRIMARY KEY,
     ts                 TEXT NOT NULL,
     agent_id           TEXT,
     session_id         TEXT,
     task_id            TEXT,
     delegation_chain   TEXT,
     machine_id         TEXT,
     host               TEXT,
     port               INTEGER,
     auth_method        TEXT,
     fingerprint_result TEXT,
     command_scrubbed   TEXT,
     exit_code          INTEGER,
     stdout_bytes       INTEGER,
     stderr_bytes       INTEGER,
     duration_ms        INTEGER,
     outcome            TEXT,
     exec_id            TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_ssh_audit_ts ON ssh_audit(ts)',
  'CREATE INDEX IF NOT EXISTS idx_ssh_audit_machine ON ssh_audit(machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_ssh_audit_outcome ON ssh_audit(outcome)',
  'CREATE INDEX IF NOT EXISTS idx_ssh_audit_fingerprint ON ssh_audit(fingerprint_result)',
  // §4.3 pending_confirmations — ONE shared block-until-human primitive (critical-run + TOFU-pin).
  `CREATE TABLE IF NOT EXISTS pending_confirmations (
     id           TEXT PRIMARY KEY,
     kind         TEXT NOT NULL,
     subject_ref  TEXT,
     agent_id     TEXT,
     session_id   TEXT,
     payload      TEXT,
     status       TEXT NOT NULL DEFAULT 'pending',
     created_at   TEXT NOT NULL,
     expires_at   TEXT NOT NULL,
     resolved_at  TEXT,
     resolved_by  TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_pending_conf_status ON pending_confirmations(status)',
  // spec: native-notebook-rag — ephemeral per-session "active notebook" pointer.
  // NOT authoritative: every notebook tool accepts an explicit notebook_id and
  // falls back to this pointer only when omitted. The notebook corpus itself
  // lives in Supabase (neuroclaw_kb.doc_notebooks / doc_notebook_sources).
  `CREATE TABLE IF NOT EXISTS doc_notebook_context (
     session_id   TEXT PRIMARY KEY,
     notebook_id  TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   )`,

  // Studio Phase 1 — server-side spend circuit breaker state.
  // These tables are enforcement state, NOT a parallel meter; actual provider
  // spend continues to flow through model_spend / src/infra/*-usage.ts.
  `CREATE TABLE IF NOT EXISTS spend_in_flight (
     id          TEXT PRIMARY KEY,
     user_id     TEXT NOT NULL,
     tool        TEXT NOT NULL,
     model       TEXT,
     started_at  INTEGER NOT NULL,
     est_usd     REAL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_spend_in_flight_user    ON spend_in_flight(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_spend_in_flight_started ON spend_in_flight(started_at)`,
  `CREATE TABLE IF NOT EXISTS spend_counters (
     scope    TEXT NOT NULL,            -- 'user' | 'global'
     user_id  TEXT NOT NULL,
     window   TEXT NOT NULL,            -- 'burst' | 'day'
     bucket   TEXT NOT NULL,            -- burst=timestamp/window ; day=YYYY-MM-DD
     calls    INTEGER NOT NULL DEFAULT 0,
     usd      REAL NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (scope, user_id, window, bucket)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_spend_counters_user_window ON spend_counters(user_id, window, bucket)`,
  `CREATE TABLE IF NOT EXISTS spend_breaker_trips (
     id            TEXT PRIMARY KEY,
     user_id       TEXT NOT NULL,
     reason        TEXT NOT NULL,
     spend_at_trip REAL NOT NULL DEFAULT 0,
     created_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_spend_breaker_trips_created ON spend_breaker_trips(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_spend_breaker_trips_user    ON spend_breaker_trips(user_id)`,

  // Sub-agent provider selection (Settings › Sub-Agents): per-family live
  // overrides for the MODEL and provider ENDPOINT (base URL), layered on top of
  // the env defaults in config.subAgent.<family>. NULL = "no override, use the
  // env default". The API KEY is deliberately NOT stored here — keys stay in
  // Live .env / the broker; base_url only repoints which OpenAI-compatible
  // endpoint the family's existing key authenticates against. Resolved by
  // subagent-providers-store on every task, so changes take effect with no restart.
  `ALTER TABLE subagent_providers ADD COLUMN model TEXT`,
  `ALTER TABLE subagent_providers ADD COLUMN base_url TEXT`,

  // v4.1: durable synchronous agent hand-off recovery table for existing DBs.
  `CREATE TABLE IF NOT EXISTS handoff_recovery (
    id                  TEXT PRIMARY KEY,
    caller_session_id   TEXT,
    caller_agent_id     TEXT,
    caller_run_id       TEXT,
    target_agent_id     TEXT NOT NULL,
    target_session_id   TEXT NOT NULL,
    message             TEXT NOT NULL,
    source              TEXT NOT NULL CHECK(source IN ('message_agent', 'execute_now')),
    agent_message_id    TEXT,
    task_id             TEXT,
    parent_handoff_id   TEXT REFERENCES handoff_recovery(id),
    depth               INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'running'
                        CHECK(status IN ('running', 'done', 'failed', 'orphaned')),
    response            TEXT,
    error               TEXT,
    created_at          TEXT NOT NULL,
    heartbeat_at        INTEGER NOT NULL,
    completed_at        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_recovery_poll    ON handoff_recovery(status, heartbeat_at)`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_recovery_target  ON handoff_recovery(target_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_recovery_parent  ON handoff_recovery(parent_handoff_id)`,

  // Compression Phase 1 — per-agent engine toggles (nullable → inherit global).
  'ALTER TABLE agents ADD COLUMN compress_lite INTEGER DEFAULT NULL',
  'ALTER TABLE agents ADD COLUMN compress_headroom INTEGER DEFAULT NULL',
  'ALTER TABLE agents ADD COLUMN compress_rtk INTEGER DEFAULT NULL',

  // Self-heal Phase 2: distinct-session verification gate. Capped JSON array
  // of session/run ids that produced a verify_pass, so trusted-fix promotion
  // requires corroboration from multiple autonomous runs, not one flapping run.
  `ALTER TABLE self_heal_memory ADD COLUMN verify_sessions TEXT NOT NULL DEFAULT '[]'`,

  // ── Mission-Control Wave 2 ────────────────────────────────────────────────
  // Item D — first-class task dependency edges (blocked_by DAG). Join table,
  // not a JSON column: indexable both directions (cycle checks + "what does X
  // block" cascades), no read-modify-write races. Empty table = today's
  // behavior exactly (the claim/transition gate never fires), so fully
  // backward-compatible with no backfill.
  `CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id       TEXT NOT NULL,   -- the dependent (blocked) task
    depends_on_id TEXT NOT NULL,   -- the blocker (must be 'done' first)
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (task_id, depends_on_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_task_deps_task    ON task_dependencies(task_id)',
  'CREATE INDEX IF NOT EXISTS idx_task_deps_blocker ON task_dependencies(depends_on_id)',

  // Item E — routine coalescing key. Set ONLY on tasks a cron 'create_task'
  // routine spawns (NULL for everything else). Lets a routine keep at most one
  // outstanding open instance per key instead of stampeding the board.
  'ALTER TABLE tasks ADD COLUMN routine_key TEXT',
  'CREATE INDEX IF NOT EXISTS idx_tasks_routine_key ON tasks(routine_key)',

  // Item C4 — immutable todo→doing start stamp (epoch ms). Distinct from
  // last_heartbeat_at (moves every 20s → useless for elapsed) and updated_at.
  // Set on the todo→doing edge, cleared on any exit from doing. Feeds Sentinel's
  // runaway pass (a task can't be "runaway" without a stable start time).
  'ALTER TABLE tasks ADD COLUMN doing_since INTEGER',

  // spec: gallery-model-capture-display — the model actually used to generate
  // an archived image (e.g. 'flux-2-pro', 'gemini-3.1-flash-image'). NULL means
  // "never captured" (pre-migration rows / uploads), distinct from the string
  // 'unknown' the backfill script uses when it can't confidently correlate one.
  'ALTER TABLE agent_images ADD COLUMN model TEXT',
  ];
  for (const sql of alters) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }

  // spec: uploaded-document-handling-overhaul — Stage-1 correctness (A.S.A.G.I review).
  // (Catch 2) The shared alters loop above swallows EVERY error silently, so a
  //   non-"duplicate" ALTER failure would be invisible and downstream code would
  //   assume columns that don't exist. PRAGMA table_info is the deterministic
  //   existence check — assert the 5 raw/parsed-decouple columns actually landed
  //   and log loudly if any is missing instead of letting it fail closed-silent.
  // (Catch 1) One-shot legacy backfill: existing rows predate parse_status (the
  //   ALTER leaves them NULL). Mark already-parsed rows 'done' and unparsed legacy
  //   rows 'skipped' — both terminal — so the background re-parse pipeline never
  //   wakes thousands of dead pre-migration rows. New funnel rows are inserted
  //   'pending' explicitly. `WHERE parse_status IS NULL` makes it idempotent.
  try {
    const cols = new Set(
      (database.prepare('PRAGMA table_info(chat_attachments)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    );
    const required = ['storage_bucket', 'storage_path', 'raw_expires_at', 'parse_status', 'parse_attempts'];
    const missing = required.filter((c) => !cols.has(c));
    if (missing.length) {
      logger.error('migration: chat_attachments raw/parsed columns missing — an ALTER was swallowed', { missing });
    } else {
      database.prepare(`
        UPDATE chat_attachments
           SET parse_status = CASE
             WHEN parsed_markdown IS NOT NULL AND parsed_markdown != '' THEN 'done'
             ELSE 'skipped'
           END
         WHERE parse_status IS NULL
      `).run();
    }
  } catch (err) {
    logger.warn('migration: chat_attachments Stage-1 backfill failed', { error: (err as Error).message });
  }

  // v3.x: one-time backfill of sessions.source from legacy title/external_id
  // patterns. Best-effort heuristic only — correctness comes from creation-time
  // stamping. Anything unmatched → 'unknown', which cleanup treats as protected.
  try {
    database.prepare(`
      UPDATE sessions SET source = CASE
        WHEN external_id LIKE 'discord::%'   THEN 'discord'
        WHEN external_id = 'room::neuroroom' THEN 'room'
        WHEN title LIKE 'Comms:%'            THEN 'comms'
        WHEN title = 'Dashboard Chat'        THEN 'dashboard'
        WHEN title LIKE 'Spawn:%'            THEN 'spawn'
        WHEN title LIKE 'Step %:%'           THEN 'step'
        WHEN title LIKE '[sentinel]%'        THEN 'sentinel'
        WHEN title LIKE 'cron-%'             THEN 'cron'
        WHEN title LIKE 'Voice%'             THEN 'voice'
        WHEN title = 'Terminal'              THEN 'terminal'
        WHEN title LIKE 'CLI Session%'       THEN 'cli'
        WHEN title LIKE 'Code CLI%'          THEN 'cli'
        WHEN title LIKE 'Task:%'             THEN 'agent_task'
        ELSE 'unknown'
      END
      WHERE source IS NULL
    `).run();
  } catch (err) {
    logger.warn('migration: session source backfill failed', { error: (err as Error).message });
  }

  // spec 2026-07-15 (decomposer-router-durable-fix, Lever 2): de-poison agent
  // capabilities. A broken one-shot extractor wrote NEGATION tags
  // (not-code-generation, etc.) into ~30 agents' `capabilities` arrays; the
  // decomposer + router rendered them as POSITIVE skills, inverting routing.
  // Apply the SAME filter the read path (formatAgentCapabilities) uses, once, to
  // the stored data so the DB stops lying. Deterministic, no LLM, idempotent.
  // ASAGI correction: malformed (non-array) JSON is SKIPPED, not blanked — mirror
  // the read path's fail-open so a corrupted-but-differently-shaped row that
  // merely contains the substring "not-" is never destroyed.
  try {
    const rows = database
      .prepare(`SELECT id, name, capabilities FROM agents
                 WHERE capabilities LIKE '%"not-%' OR capabilities LIKE '%"not_%'`)
      .all() as Array<{ id: string; name: string; capabilities: string | null }>;
    const upd = database.prepare('UPDATE agents SET capabilities = ? WHERE id = ?');
    let cleaned = 0;
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.capabilities || '[]'); } catch { continue; } // fail-open: skip malformed
      if (!Array.isArray(parsed)) continue;                                      // fail-open: skip non-array
      const before = parsed as string[];
      const after = stripNegationTags(before);
      if (after.length === before.length) continue;                             // no negation tags → untouched
      const removed = before.filter(t => typeof t === 'string' && !after.includes(t.trim()));
      upd.run(JSON.stringify(after), row.id);
      cleaned++;
      logger.info('migration: de-poisoned agent capabilities', {
        agent: row.name, removed, kept: after,
      });
    }
    if (cleaned > 0) logger.info('migration: agent-capability de-poison complete', { agentsCleaned: cleaned });
  } catch (err) {
    logger.warn('migration: agent-capability de-poison failed', { error: (err as Error).message });
  }

  try {
    database.prepare(`
      CREATE TABLE IF NOT EXISTS discord_bot_skills (
        bot_id     TEXT NOT NULL REFERENCES discord_bots(id) ON DELETE CASCADE,
        skill_name TEXT NOT NULL,
        PRIMARY KEY (bot_id, skill_name)
      )
    `).run();
  } catch {}
  // Patch Alfred's role if it was seeded before this column existed
  database.exec("UPDATE agents SET role = 'orchestrator' WHERE name = 'Alfred' AND role = 'agent'");

  // v3.2: workload profile seeds. Heavy-reasoning agents get bigger turn
  // budgets; logging / sentinel agents stay light. Idempotent — only nudges
  // rows whose profile is still NULL or 'normal' so a user's explicit choice
  // is never stomped.
  try {
    database.exec(`
      UPDATE agents
         SET workload_profile = 'heavy'
       WHERE name IN ('Oracle','Jarvis','Lucius','A.S.A.G.I','Da Vinci','Joker')
         AND (workload_profile IS NULL OR workload_profile = 'normal')
    `);
    database.exec(`
      UPDATE agents
         SET workload_profile = 'light'
       WHERE name IN ('Sentinel','LogAnalyst','Tim')
         AND (workload_profile IS NULL OR workload_profile = 'normal')
    `);
  } catch (err) {
    logger.warn('workload_profile seed skipped', { err: String(err) });
  }

  // Token-optimization directive seed (spec 2026-07-10, Component A). Runs ONCE
  // — guarded by a config_items marker so a user who later toggles flags off is
  // never re-stomped on the next boot. Defaults chosen from the live roster:
  //   terse: pure code/build agents only (verbosity costs output tokens; their
  //          answers are code+commands, not conversation).
  //   lean_code: code builders + infra-as-code agents that emit YAML / compose /
  //          migrations / workflows. User-facing & prose agents get NEITHER.
  try {
    const marker = database
      .prepare("SELECT value FROM config_items WHERE key = 'seed:optimize_directives_v1'")
      .get() as { value: string } | undefined;
    if (!marker) {
      database.exec(`
        UPDATE agents
           SET optimize_terse = 1
         WHERE name IN ('Jarvis','A.S.A.G.I','F.R.I.D.A.Y')
      `);
      database.exec(`
        UPDATE agents
           SET optimize_lean_code = 1
         WHERE name IN (
           'Jarvis','A.S.A.G.I','F.R.I.D.A.Y','Lucius',
           'Angelina','Raphtalia','Shorekeeper','Mayumi Saegusa',
           'Rossweisse','Yukina Himeragi','Liese Sherlock'
         )
      `);
      database
        .prepare("INSERT OR REPLACE INTO config_items (key, value, description) VALUES (?, ?, ?)")
        .run('seed:optimize_directives_v1', new Date().toISOString(),
             'One-time token-optimization directive seed (Component A). Do not delete — its presence blocks re-seeding.');
      logger.info('token-opt: seeded optimize directives for code/infra agents');
    }
  } catch (err) {
    logger.warn('optimize_directives seed skipped', { err: String(err) });
  }

  // Token-optimization directive seed v2 (2026-07-14). ADDITIVE fill for the
  // infra/backend agents the v1 seed missed — RAG/memory, network/DNS, identity
  // and static-publishing engineers whose output is config/migrations/records,
  // not conversation. Separate marker so it runs ONCE and never re-stomps a user
  // who toggles a flag off afterward; the `AND optimize_lean_code = 0` guard is a
  // second belt so we only flip agents still at the default.
  //   - Only `lean_code` is added here (safe/additive: minimum-code / YAGNI).
  //   - `terse` is deliberately NOT widened — it reshapes an agent's output
  //     voice, so it stays scoped to the pure code-emitting agents from v1
  //     (Jarvis / A.S.A.G.I / F.R.I.D.A.Y).
  //   - Tool-output compression (lite / headroom / rtk) needs no per-agent seed:
  //     it is ON globally (config.optimize.engines) and every agent inherits it
  //     via a NULL compress_* column, with retrieval/memory/KB/vision hard-exempt.
  try {
    const markerV2 = database
      .prepare("SELECT value FROM config_items WHERE key = 'seed:optimize_directives_v2'")
      .get() as { value: string } | undefined;
    if (!markerV2) {
      database.exec(`
        UPDATE agents
           SET optimize_lean_code = 1
         WHERE name IN (
           'Jibril','Rei Miyamoto','Nonaka Yuki','Mio Naruse'
         )
           AND optimize_lean_code = 0
      `);
      database
        .prepare("INSERT OR REPLACE INTO config_items (key, value, description) VALUES (?, ?, ?)")
        .run('seed:optimize_directives_v2', new Date().toISOString(),
             'One-time token-optimization directive seed v2 (infra/backend lean_code fill). Do not delete — its presence blocks re-seeding.');
      logger.info('token-opt: seeded v2 lean_code directives for infra/backend agents');
    }
  } catch (err) {
    logger.warn('optimize_directives v2 seed skipped', { err: String(err) });
  }

  // Backfill the FTS5 index for memory_index rows that pre-date v1.7. The
  // triggers keep new writes in sync; this catches everything that was in
  // the DB before the FTS table existed. Idempotent — INSERT-OR-IGNORE on
  // the (memory_id) we've already mirrored.
  try {
    database.exec(`
      INSERT INTO memory_index_fts (memory_id, title, summary, tags)
      SELECT id, title, COALESCE(summary, ''), COALESCE(tags, '')
      FROM memory_index
      WHERE id NOT IN (SELECT memory_id FROM memory_index_fts)
    `);
  } catch { /* FTS5 unavailable — backfill is best-effort */ }

  // v1.9: ensure a default project exists, then backfill orphan tasks onto it
  // so every row has a project_id once the new UI lands. We pick the first
  // project (by created_at ASC) so re-runs don't churn — the seed is idempotent
  // by name lookup just below.
  try {
    const defaultProject = database.prepare(
      "SELECT id FROM projects WHERE title = 'NeuroClaw' ORDER BY created_at ASC LIMIT 1"
    ).get() as { id: string } | undefined;

    let projectId = defaultProject?.id;
    if (!projectId) {
      projectId = randomUUID();
      database.prepare(
        "INSERT INTO projects (id, title, description, pinned) VALUES (?, ?, ?, 1)"
      ).run(
        projectId,
        'NeuroClaw',
        'Default project — every task without an explicit project lands here. Created by v1.9 migration.',
      );
    }
    database.prepare("UPDATE tasks SET project_id = ? WHERE project_id IS NULL").run(projectId);
  } catch (err) {
    logger.warn('default project backfill skipped', { err: (err as Error).message });
  }

  // v1.9: backfill priority_level (enum) from the legacy numeric priority.
  // Buckets borrowed from Archon's priority enum. Only touches rows where the
  // enum is still at its default 'medium' AND the numeric column has been
  // explicitly set to something non-default — avoids stomping new writes that
  // already chose a level.
  try {
    database.exec(`
      UPDATE tasks SET priority_level = CASE
        WHEN priority >= 75 THEN 'critical'
        WHEN priority >= 50 THEN 'high'
        WHEN priority >= 25 THEN 'medium'
        ELSE 'low'
      END
      WHERE priority_level = 'medium' AND priority IS NOT NULL
    `);
  } catch { /* legacy numeric priority might not exist on a fresh DB */ }

  // spec: task-management-overhaul — backfill task_source for pre-migration rows.
  // Existing 'doing' tasks had task_source=NULL before this migration; Sentinel's
  // allowlist query would skip them. Stamp them 'dashboard' so they stay monitored.
  try {
    database.prepare(
      "UPDATE tasks SET task_source = 'dashboard' WHERE task_source IS NULL"
    ).run();
  } catch (err) {
    logger.warn('migration: task_source backfill failed', { error: (err as Error).message });
  }

  // spec: task-attribution-sentinel — sync assignee to the real doer for legacy
  // rows where an agent is assigned but the label is still the default 'User'.
  // No marker needed: all four producer write-sites now sync assignee to agent_id,
  // so "agent_id set AND assignee='User'" is unreproducible going forward — the
  // WHERE clause is self-limiting to legacy rows on every boot.
  try {
    database.prepare(`
      UPDATE tasks
      SET assignee = (SELECT name FROM agents WHERE agents.id = tasks.agent_id)
      WHERE agent_id IS NOT NULL
        AND (assignee IS NULL OR assignee = 'User')
        AND EXISTS (SELECT 1 FROM agents WHERE agents.id = tasks.agent_id)
    `).run();
  } catch (err) {
    logger.warn('migration: assignee attribution backfill failed', { error: (err as Error).message });
  }

  // v2.x → v3.x: extend job_queue CHECK to include the newer job types.
  // Guard checks for 'maintenance' (last type added) so any DB still on the
  // older 3- or 4-type CHECK gets re-migrated. Previously this guard only
  // looked for 'agent_task', so DBs that ran the earlier migration silently
  // skipped this — every chat turn's post-pipeline (memory_extract,
  // tts_synthesize, etc.) then threw CHECK constraint failures that crashed
  // the agent loop mid-stream.
  // SQLite requires full table recreation to change a CHECK constraint.
  try {
    const row = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='job_queue'"
    ).get() as { sql: string } | undefined;
    if (row && !row.sql.includes('maintenance')) {
      // Step 1: copy old table so we can inspect its columns before recreating.
      database.exec(`CREATE TABLE job_queue_tmp AS SELECT * FROM job_queue;`);

      // Step 2: check if the old schema already carried run_after so we can
      // preserve any scheduled timestamps (NULL means "run immediately").
      const oldHasRunAfter = ((database.prepare(
        "SELECT COUNT(*) as c FROM pragma_table_info('job_queue_tmp') WHERE name='run_after'"
      ).get() as { c: number }).c) > 0;
      // runAfterExpr is either 'run_after' (column ref) or 'NULL' — both safe in exec().
      const runAfterExpr = oldHasRunAfter ? 'run_after' : 'NULL';

      // Step 3: recreate table with expanded CHECK constraint and copy data back.
      database.exec(`
        DROP TABLE job_queue;
        CREATE TABLE job_queue (
          id            TEXT PRIMARY KEY,
          type          TEXT NOT NULL CHECK(type IN ('background_agent', 'cron_run', 'agent_task', 'tts_synthesize', 'memory_extract', 'embedding_generate', 'workflow_run', 'dream_cycle', 'maintenance')),
          payload       TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'claimed', 'done', 'failed')),
          attempts      INTEGER NOT NULL DEFAULT 0,
          max_attempts  INTEGER NOT NULL DEFAULT 3,
          priority      INTEGER NOT NULL DEFAULT 5,
          run_after     TEXT,
          created_at    TEXT NOT NULL,
          claimed_at    TEXT,
          completed_at  TEXT,
          result        TEXT,
          error         TEXT
        );
        INSERT INTO job_queue (id, type, payload, status, attempts, max_attempts, priority, run_after, created_at, claimed_at, completed_at, result, error)
          SELECT id, type, payload, status, attempts, max_attempts, priority,
                 ${runAfterExpr} as run_after,
                 created_at, claimed_at, completed_at, result, error FROM job_queue_tmp;
        DROP TABLE job_queue_tmp;
        CREATE INDEX IF NOT EXISTS idx_job_queue_poll
          ON job_queue(status, priority DESC, created_at ASC);
      `);
      logger.info('Migrated job_queue: expanded types + added run_after column');
    }
  } catch (err) {
    logger.warn('job_queue migration skipped', { err: String(err) });
  }

  // v2.x patch: add run_after column if the table recreation above was skipped (already had agent_task).
  try {
    const hasRunAfter = (database.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('job_queue') WHERE name='run_after'"
    ).get() as { c: number }).c;
    if (!hasRunAfter) {
      database.exec(`ALTER TABLE job_queue ADD COLUMN run_after TEXT;`);
      logger.info('job_queue migration: added run_after column');
    }
  } catch (err) {
    logger.warn('job_queue run_after migration failed', { err: String(err) });
  }

  // Immortal-live backstop: immutable first-claim timestamp (NOT refreshed by the
  // 20s claim heartbeat, unlike claimed_at), so a sweeper can detect a job whose
  // run has exceeded an absolute hard cap regardless of liveness.
  try {
    const hasFirstClaimed = (database.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('job_queue') WHERE name='first_claimed_at'"
    ).get() as { c: number }).c;
    if (!hasFirstClaimed) {
      database.exec(`ALTER TABLE job_queue ADD COLUMN first_claimed_at TEXT;`);
      logger.info('job_queue migration: added first_claimed_at column');
    }
  } catch (err) {
    logger.warn('job_queue first_claimed_at migration failed', { err: String(err) });
  }

  // Tasks: add failure_count + last_error columns and extend status CHECK to include 'failed'.
  // SQLite requires table recreation to alter a CHECK constraint.
  let hasFailureCount = 0;
  try {
    hasFailureCount = (database.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('tasks') WHERE name='failure_count'"
    ).get() as { c: number }).c;
  } catch { /* treat as missing — tasks table not yet created */ }

  if (!hasFailureCount) {
    database.pragma('foreign_keys = OFF');
    database.exec(`
      CREATE TABLE tasks_v2 (
        id                  TEXT PRIMARY KEY,
        title               TEXT NOT NULL,
        description         TEXT,
        status              TEXT DEFAULT 'todo'
                            CHECK(status IN ('todo','doing','review','done','failed','blocked','cancelled')),
        priority            INTEGER DEFAULT 50,
        session_id          TEXT REFERENCES sessions(id),
        agent_id            TEXT REFERENCES agents(id),
        created_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        project_id          TEXT REFERENCES projects(id),
        parent_task_id      TEXT REFERENCES tasks_v2(id),
        assignee            TEXT NOT NULL DEFAULT 'User',
        task_order          INTEGER NOT NULL DEFAULT 0,
        feature             TEXT,
        sources             TEXT DEFAULT '[]',
        code_examples       TEXT DEFAULT '[]',
        archived            INTEGER NOT NULL DEFAULT 0,
        archived_at         TEXT,
        archived_by         TEXT,
        priority_level      TEXT DEFAULT 'medium',
        failure_count       INTEGER NOT NULL DEFAULT 0,
        last_error          TEXT,
        output              TEXT,
        terminal_outcome    TEXT,
        block_reason        TEXT,
        notify_policy       TEXT NOT NULL DEFAULT 'done_only',
        child_session_key   TEXT,
        last_heartbeat_at   INTEGER,
        recovery_started_at INTEGER,
        provider            TEXT,
        reviewer_feedback   TEXT NOT NULL DEFAULT '',
        max_retries         INTEGER NOT NULL DEFAULT 3,
        task_source         TEXT DEFAULT 'dashboard',
        archon_task_id      TEXT DEFAULT NULL
      );
      INSERT INTO tasks_v2
        SELECT id, title, description, status, priority, session_id, agent_id,
               created_at, updated_at, project_id, parent_task_id, assignee,
               task_order, feature, sources, code_examples, archived, archived_at,
               archived_by, priority_level, 0, NULL, NULL,
               NULL, NULL, 'done_only', NULL, NULL, NULL, NULL,
               '', 3, 'dashboard', NULL
        FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_v2 RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_project      ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent       ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_archived     ON tasks(archived);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_order ON tasks(status, task_order ASC);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent_status  ON tasks(agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_archon_id     ON tasks(archon_task_id) WHERE archon_task_id IS NOT NULL;
    `);
    database.pragma('foreign_keys = ON');
    logger.info('Tasks migration: added failure_count/last_error, extended status CHECK to include failed');
  }

  // v3.2: extend runs.status CHECK to include 'paused' | 'detached' | 'dropped' | 'stopped'.
  // SQLite requires table recreation to change a CHECK constraint. Idempotent: we
  // only run if the existing CREATE statement is missing the new states.
  try {
    const row = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'"
    ).get() as { sql: string } | undefined;
    if (row && !row.sql.includes("'paused'")) {
      database.pragma('foreign_keys = OFF');
      database.exec(`
        CREATE TABLE runs_v2 (
          id                  TEXT PRIMARY KEY,
          session_id          TEXT REFERENCES sessions(id),
          parent_run_id       TEXT REFERENCES runs_v2(id),
          origin              TEXT NOT NULL,
          initiating_agent_id TEXT REFERENCES agents(id),
          user_message        TEXT NOT NULL,
          final_output        TEXT,
          status              TEXT NOT NULL DEFAULT 'running'
                              CHECK(status IN ('running','done','error','paused','detached','dropped','stopped')),
          is_multi_agent      INTEGER NOT NULL DEFAULT 0,
          step_count          INTEGER NOT NULL DEFAULT 0,
          total_input_tokens  INTEGER NOT NULL DEFAULT 0,
          total_output_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms         INTEGER,
          error_text          TEXT,
          started_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          ended_at            TEXT,
          current_activity    TEXT,
          last_heartbeat_at   TEXT,
          partial_output      TEXT,
          turn_number         INTEGER NOT NULL DEFAULT 0,
          detached_at         TEXT,
          delivery_target     TEXT,
          delivered           INTEGER NOT NULL DEFAULT 0,
          notify_attempts     INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO runs_v2
          SELECT id, session_id, parent_run_id, origin, initiating_agent_id,
                 user_message, final_output, status, is_multi_agent, step_count,
                 total_input_tokens, total_output_tokens, duration_ms, error_text,
                 started_at, ended_at,
                 current_activity, last_heartbeat_at, partial_output, turn_number, detached_at,
                 delivery_target, delivered, notify_attempts
          FROM runs;
        DROP TABLE runs;
        ALTER TABLE runs_v2 RENAME TO runs;
        CREATE INDEX IF NOT EXISTS idx_runs_session   ON runs(session_id);
        CREATE INDEX IF NOT EXISTS idx_runs_started   ON runs(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_status    ON runs(status);
        CREATE INDEX IF NOT EXISTS idx_runs_heartbeat ON runs(status, last_heartbeat_at);
      `);
      database.pragma('foreign_keys = ON');
      logger.info('Runs migration: extended status CHECK to include paused/detached/dropped/stopped');
    }
  } catch (err) {
    logger.warn('runs status-check migration skipped', { err: String(err) });
  }

  // Tasks: extend status CHECK to include 'blocked' | 'cancelled'.
  // (spec: task-status-extension — Phase 2 after sub-agent-blocked-outcome lands)
  // Also adds all new columns from this batch of specs if not yet present.
  // Only runs when the current tasks table CHECK does not include 'blocked'.
  try {
    const tasksRow = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get() as { sql: string } | undefined;
    if (tasksRow && !tasksRow.sql.includes("'blocked'")) {
      database.pragma('foreign_keys = OFF');
      database.exec(`
        CREATE TABLE tasks_v3 (
          id                  TEXT PRIMARY KEY,
          title               TEXT NOT NULL,
          description         TEXT,
          status              TEXT DEFAULT 'todo'
                              CHECK(status IN ('todo','doing','review','done','failed','blocked','cancelled')),
          priority            INTEGER DEFAULT 50,
          session_id          TEXT REFERENCES sessions(id),
          agent_id            TEXT REFERENCES agents(id),
          created_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          project_id          TEXT REFERENCES projects(id),
          parent_task_id      TEXT REFERENCES tasks_v3(id),
          assignee            TEXT NOT NULL DEFAULT 'User',
          task_order          INTEGER NOT NULL DEFAULT 0,
          feature             TEXT,
          sources             TEXT DEFAULT '[]',
          code_examples       TEXT DEFAULT '[]',
          archived            INTEGER NOT NULL DEFAULT 0,
          archived_at         TEXT,
          archived_by         TEXT,
          priority_level      TEXT DEFAULT 'medium',
          failure_count       INTEGER NOT NULL DEFAULT 0,
          last_error          TEXT,
          output              TEXT,
          terminal_outcome    TEXT,
          block_reason        TEXT,
          notify_policy       TEXT NOT NULL DEFAULT 'done_only',
          child_session_key   TEXT,
          last_heartbeat_at   INTEGER,
          recovery_started_at INTEGER,
          provider            TEXT,
          reviewer_feedback   TEXT NOT NULL DEFAULT '',
          max_retries         INTEGER NOT NULL DEFAULT 3,
          task_source         TEXT DEFAULT 'dashboard',
          archon_task_id      TEXT DEFAULT NULL
        );
        INSERT INTO tasks_v3
          SELECT
            id, title, description, status, priority, session_id, agent_id,
            created_at, updated_at, project_id, parent_task_id, assignee,
            task_order, feature, sources, code_examples, archived, archived_at,
            archived_by, priority_level,
            COALESCE(failure_count, 0), last_error, output,
            terminal_outcome, block_reason,
            COALESCE(notify_policy, 'done_only'),
            child_session_key, last_heartbeat_at, recovery_started_at, provider,
            COALESCE(reviewer_feedback, ''), COALESCE(max_retries, 3),
            COALESCE(task_source, 'dashboard'), archon_task_id
          FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_v3 RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_project      ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_parent       ON tasks(parent_task_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_archived     ON tasks(archived);
        CREATE INDEX IF NOT EXISTS idx_tasks_status_order ON tasks(status, task_order ASC);
        CREATE INDEX IF NOT EXISTS idx_tasks_agent_status  ON tasks(agent_id, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_archon_id     ON tasks(archon_task_id) WHERE archon_task_id IS NOT NULL;
      `);
      database.pragma('foreign_keys = ON');
      logger.info('Tasks migration: extended status CHECK to include blocked/cancelled; added sweep metadata columns');
    }
  } catch (err) {
    logger.warn('tasks status-extension migration skipped', { err: String(err) });
  }
  // spec: review-vs-reconcile-gate-fix — deterministic gate discriminator.
  // Set-once-at-creation by the dispatcher. 'reconcile' asserts main HEAD moved;
  // 'review' bypasses that assertion because a review is supposed to leave main
  // untouched. NULL/absent keeps the existing outer regex gate behavior.
  try {
    const hasVerificationMode = (database.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('tasks') WHERE name='verification_mode'"
    ).get() as { c: number }).c;
    if (!hasVerificationMode) {
      database.exec(`ALTER TABLE tasks ADD COLUMN verification_mode TEXT CHECK(verification_mode IS NULL OR verification_mode IN ('reconcile','review'));`);
      logger.info('Tasks migration: added verification_mode discriminator');
    }
  } catch (err) {
    logger.warn('tasks verification_mode migration skipped', { err: String(err) });
  }
}

function migrateDeprecatedProviders(database: Database.Database): void {
  // NOTE: 'kimi' (native Anthropic gateway) is NOT deprecated. Only genuinely
  // retired providers belong here. This list MUST stay in sync with the agent
  // provider dropdown in src/dashboard/v2/src/page-agents.jsx — prior drift
  // force-deactivated the live kimi agents on every restart.
  //   gemini / gemini-api → antigravity (Google moved behind the agy gateway)
  //   openai              → voidai      (same VoidAI client; collapse the duplicate string)
  //   kilo / opencode / kimi-api → deactivate (provider pruned 2026-06-06; 0 live agents, redundant)
  //   venice → deactivate as a CHAT provider (pruned 2026-06-07). The Venice image
  //            API/tool is KEPT (generate_image_venice + config.venice) — only the
  //            chat-roster entry is removed.
  const stale = (database.prepare(
    "SELECT COUNT(*) as n FROM agents WHERE provider IN ('gemini', 'gemini-api', 'openai', 'kilo', 'opencode', 'kimi-api', 'venice')"
  ).get() as { n: number }).n;
  if (stale === 0) return;

  database.prepare(
    "UPDATE agents SET provider = 'antigravity' WHERE provider IN ('gemini', 'gemini-api')"
  ).run();

  database.prepare(
    "UPDATE agents SET provider = 'voidai' WHERE provider = 'openai'"
  ).run();

  database.prepare(
    "UPDATE agents SET status = 'inactive' WHERE provider IN ('kilo', 'opencode', 'kimi-api', 'venice') AND status = 'active'"
  ).run();

  console.log(`[db] migrateDeprecatedProviders: migrated ${stale} agent(s)`);
}

// ── Seed ────────────────────────────────────────────────────────────────────

const SPAWN_GUIDANCE =
  '\n\nYou may create temporary sub-agents when:\n' +
  '- the task is complex and requires deep specialization\n' +
  '- parallel work would significantly improve performance\n' +
  'Prefer delegation before spawning. Do NOT spawn agents unnecessarily.';

const SEEDED_AGENT_NAMES = new Set(['LogAnalyst']);

const SUB_AGENTS = [
  {
    name: 'LogAnalyst',
    description: 'Analyzes NeuroClaw logs, errors, and downtime. Ask it about error patterns, incidents, and root causes.',
    role: 'specialist',
    capabilities: ['logs', 'errors', 'downtime', 'analytics'],
    systemPrompt:
      'You are LogAnalyst, NeuroClaw\'s log intelligence specialist.\n\n' +
      'You have tools to:\n' +
      '- get_recent_errors(hours?) — fetch recent errors/warnings from analytics_events\n' +
      '- get_downtime_windows(hours?) — fetch detected downtime windows\n' +
      '- search_log_lines(query, limit?) — substring-search the live log file\n' +
      '- get_error_timeline(hours?) — hourly error counts for spotting spikes\n\n' +
      'When asked about errors or incidents:\n' +
      '1. Use get_recent_errors or get_downtime_windows to retrieve data first\n' +
      '2. Identify patterns: which source is most error-prone, when did spikes occur\n' +
      '3. Give a concise summary with actionable findings\n' +
      '4. Suggest likely root causes based on error messages\n\n' +
      'Be direct and data-driven. One or two paragraphs max unless detail is requested.',
  },
];

const SENTINEL_PROMPT =
  'You are Sentinel, NeuroClaw\'s background task manager.\n\n' +
  'Your role:\n' +
  '- Monitor tasks assigned to agents and ensure they make progress\n' +
  '- When a task is stalled, check in with the assigned agent to understand blockers\n' +
  '- Provide status updates concisely — you are an internal system agent\n' +
  '- If an agent is genuinely blocked, report clearly what is blocking them\n' +
  '- You operate silently in the background; your responses are logged to Hive Mind only\n\n' +
  'When checking in about a stalled task, ask specifically:\n' +
  '1. What progress has been made?\n' +
  '2. What are you currently working on?\n' +
  '3. Is anything blocking you?\n\n' +
  'Be direct and professional. One short paragraph is enough.';

function buildAlfredPrompt(): string {
  const agentLines = SUB_AGENTS.map(a => `- @${a.name} — ${a.description}`).join('\n');
  return (
    'You are Alfred, a strategic AI butler and orchestrator.\n\n' +
    'You:\n' +
    '- Understand intent and route requests to the right specialist\n' +
    '- Respond clearly and think like a manager\n' +
    '- Assign tasks to agents best suited for them\n\n' +
    'Available sub-agents (users can address them with @Name):\n' +
    agentLines +
    '\n\nWhen a request is better handled by a sub-agent, recommend the user address @AgentName directly.' +
    SPAWN_GUIDANCE
  );
}

// Persona-only default for Alfred. The live specialist roster + spawn/comms
// guidance are appended at RUNTIME by buildOrchestratorPrompt() (alfred.ts), so
// they are intentionally NOT baked in here — this stays the user-editable persona
// that the dashboard exposes and that the runtime now actually uses.
function buildAlfredPersona(): string {
  return (
    'You are Alfred, a strategic AI butler and orchestrator.\n\n' +
    'You:\n' +
    '- Understand intent and route requests to the right specialist\n' +
    '- Respond clearly and think like a manager\n' +
    '- Assign tasks to agents best suited for them'
  );
}

// Refresh a seeded agent's system_prompt ONLY when it's still the unmodified code
// default (or empty) — so dashboard edits to a seeded agent's persona survive a
// restart instead of being clobbered. The description (a short label, not the
// persona) is always kept current. No-op if the agent isn't seeded yet (the
// caller's INSERT handles first creation).
function refreshSeededAgentDefaults(
  database: Database.Database,
  name: string,
  defaultPrompt: string,
  defaultDescription?: string,
): void {
  const row = database.prepare('SELECT system_prompt FROM agents WHERE name = ?')
    .get(name) as { system_prompt: string | null } | undefined;
  if (!row) return;
  const sp = row.system_prompt;
  if (sp == null || sp.trim() === '' || sp === defaultPrompt) {
    database.prepare('UPDATE agents SET system_prompt = ? WHERE name = ?').run(defaultPrompt, name);
  }
  if (defaultDescription !== undefined) {
    database.prepare('UPDATE agents SET description = ? WHERE name = ?').run(defaultDescription, name);
  }
}

function seedDefaultData(database: Database.Database): void {
  // Alfred
  const alfredExists = database.prepare('SELECT id FROM agents WHERE name = ?').get('Alfred');
  if (!alfredExists) {
    const alfredId = randomUUID();
    database.prepare(`
      INSERT INTO agents (id, name, description, system_prompt, model, role, capabilities)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      alfredId,
      'Alfred',
      'Strategic AI butler and orchestrator',
      buildAlfredPersona(),
      config.voidai.model,
      'orchestrator',
      JSON.stringify(['orchestrate', 'delegate', 'plan', 'respond']),
    );

    const insertConfig = database.prepare(
      'INSERT OR IGNORE INTO config_items (key, value, description, is_secret) VALUES (?, ?, ?, ?)',
    );
    for (const item of [
      { key: 'VOIDAI_MODEL',    value: config.voidai.model,           description: 'Active AI model',        is_secret: 0 },
      { key: 'DASHBOARD_PORT',  value: String(config.dashboard.port),  description: 'Dashboard port',         is_secret: 0 },
      { key: 'VOIDAI_API_KEY',  value: config.voidai.apiKey,           description: 'VoidAI API key',         is_secret: 1 },
      { key: 'DASHBOARD_TOKEN', value: config.dashboard.token,         description: 'Dashboard access token', is_secret: 1 },
    ]) {
      insertConfig.run(item.key, item.value, item.description, item.is_secret);
    }
    logger.info('Seeded default Alfred agent');
  }

  database.exec("UPDATE agents SET role = 'orchestrator' WHERE name = 'Alfred'");
  // Alfred's system_prompt is NO LONGER overwritten on every boot — dashboard
  // edits now persist. One-time migration: the legacy default baked the roster +
  // spawn guidance into the stored prompt; those are now appended at runtime by
  // buildOrchestratorPrompt(), so collapse an UNMODIFIED legacy default to the
  // persona-only form. Any customization (prompt != the legacy default) is left
  // untouched.
  const alfredPrompt = (database.prepare("SELECT system_prompt FROM agents WHERE name = 'Alfred'")
    .get() as { system_prompt: string | null } | undefined)?.system_prompt;
  if (alfredPrompt == null || alfredPrompt.trim() === '' || alfredPrompt === buildAlfredPrompt()) {
    database.prepare("UPDATE agents SET system_prompt = ? WHERE name = 'Alfred'").run(buildAlfredPersona());
  }

  for (const agent of SUB_AGENTS) {
    const suppressed = (database.prepare("SELECT value FROM config_items WHERE key = ?")
      .get(`seed_suppress_${agent.name}`) as { value: string } | undefined)?.value === '1';
    if (suppressed) continue;

    const row = database.prepare('SELECT id FROM agents WHERE name = ?').get(agent.name) as { id: string } | undefined;
    if (!row) {
      database.prepare(`
        INSERT INTO agents (id, name, description, system_prompt, model, role, capabilities)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        agent.name,
        agent.description,
        agent.systemPrompt,
        config.voidai.model,
        agent.role,
        JSON.stringify(agent.capabilities),
      );
      logger.info(`Seeded sub-agent: ${agent.name}`);
    } else {
      // Preserve dashboard edits — only refresh the prompt if still the default.
      refreshSeededAgentDefaults(database, agent.name, agent.systemPrompt, agent.description);
    }
  }

  // Sentinel — background task manager agent
  const sentinelExists = database.prepare('SELECT id FROM agents WHERE name = ?').get('Sentinel');
  if (!sentinelExists) {
    database.prepare(`
      INSERT INTO agents (id, name, description, system_prompt, model, role, capabilities)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      'Sentinel',
      'Background task manager — monitors stalled tasks and escalates intelligently',
      SENTINEL_PROMPT,
      config.voidai.model,
      'orchestrator',
      JSON.stringify(['monitor', 'check_in', 'reassign', 'escalate']),
    );
    logger.info('Seeded Sentinel agent');
  }
  refreshSeededAgentDefaults(database, 'Sentinel', SENTINEL_PROMPT,
    'Background task manager — monitors stalled tasks and escalates intelligently');

  // Gemini — first-class antigravity (agy) agent, seeded idempotently like Sentinel.
  const GEMINI_PROMPT = `You are Gemini, a NeuroClaw AI specialist powered by Google's Gemini models via the Antigravity CLI.

You have full access to NeuroClaw's tool ecosystem via MCP — including agent delegation, memory search, task management, Discord messaging, workflow execution, and sub-agent spawning. Use tools proactively to complete tasks.

When delegating to other agents use ask_alfred or spawn_agent. When searching memory use search_memory. Be thorough, direct, and collaborative — you are a peer-level agent in the NeuroClaw team.`;

  const geminiExists = database.prepare('SELECT id FROM agents WHERE name = ?').get('Gemini');
  if (!geminiExists) {
    database.prepare(`
      INSERT INTO agents (id, name, description, system_prompt, model, role, capabilities, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      'Gemini',
      'Google Gemini specialist via Antigravity CLI — full NeuroClaw tool access',
      GEMINI_PROMPT,
      'antigravity/gemini-3-5-flash-medium',
      'specialist',
      JSON.stringify(['research', 'analysis', 'tools', 'delegation']),
      'antigravity',
    );
    logger.info('Seeded Gemini agent');
  } else {
    refreshSeededAgentDefaults(database, 'Gemini', GEMINI_PROMPT,
      'Google Gemini specialist via Antigravity CLI — full NeuroClaw tool access');
  }

  // Seed default CLI tools (idempotent)
  const insertTool = database.prepare(
    `INSERT OR IGNORE INTO cli_tools (id, name, slug, description, status, install_command, features, tool_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertTool.run('cli-tool-code', 'nrclw code', 'code',
    'Claude Code, powered by NeuroClaw agents', 'building',
    'npm install -g @neuroclaw/code',
    JSON.stringify(['AI pair programming via your agents', 'Tool use, file edits, shell access', '@Agent delegation mid-session']),
    20);
  insertTool.run('cli-tool-boilerplates', 'nrclw boilerplates', 'boilerplates',
    'Docker Compose templates via agent', 'planned', null,
    JSON.stringify(['Browse agent-managed template library', 'Select app, agent generates all config files', 'Auto-generated .env guide and deploy docs']),
    10);
  insertTool.run('cli-tool-setup', 'nrclw setup', 'setup',
    'Easy project setup wizard for new NeuroClaw deployments', 'planned', null,
    JSON.stringify(['Interactive .env builder', 'One-command install', 'Health checks']),
    5);

  // Sonar — Perplexity-backed research agent (seeded when session token present)
  if (config.perplexity.enabled) {
    const existingServer = database.prepare(
      "SELECT id FROM mcp_servers WHERE name = 'perplexity-web'"
    ).get() as { id: string } | undefined;

    let serverId: string;
    if (!existingServer) {
      serverId = randomUUID();
      database.prepare(
        `INSERT INTO mcp_servers (id, name, url, transport, headers, enabled, status)
         VALUES (?, ?, ?, ?, ?, 1, 'ok')`
      ).run(serverId, 'perplexity-web', config.perplexity.mcpUrl, 'sse', '{}');
      logger.info('Seeded perplexity-web MCP server');
    } else {
      serverId = existingServer.id;
      // URL-only update — preserves operator-set headers, transport, enabled flag
      database.prepare('UPDATE mcp_servers SET url = ? WHERE id = ?')
        .run(config.perplexity.mcpUrl, serverId);
    }

    const sonarExists = database.prepare("SELECT id FROM agents WHERE name = 'Sonar'").get();
    if (!sonarExists) {
      database.prepare(`
        INSERT INTO agents
          (id, name, description, system_prompt, model, role, capabilities,
           provider, mcp_server_id, mcp_tool_name, mcp_input_field)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        'Sonar',
        'Web research via Perplexity — comprehensive answers with citations',
        'You are Sonar, a research specialist powered by Perplexity. Answer questions with up-to-date web data and cite your sources.',
        null,
        'specialist',
        JSON.stringify(['search', 'research', 'citations', 'web']),
        'mcp',
        serverId,
        'perplexity_ask',
        'query',
      );
      logger.info('Seeded Sonar agent (Perplexity-backed)');
    }
  }

  // Sonar Smart — auto-routing sidecar (deep vs fast Perplexity mode, opt-in)
  if (config.sonarSmart.enabled) {
    const existingSonarSmart = database.prepare(
      "SELECT id FROM mcp_servers WHERE name = 'sonar-smart'"
    ).get() as { id: string } | undefined;

    let sonarSmartServerId: string;
    if (!existingSonarSmart) {
      sonarSmartServerId = randomUUID();
      database.prepare(
        `INSERT INTO mcp_servers (id, name, url, transport, headers, enabled, status)
         VALUES (?, ?, ?, ?, ?, 1, 'ok')`
      ).run(sonarSmartServerId, 'sonar-smart', config.sonarSmart.mcpUrl, 'http', '{}');
      logger.info('Seeded sonar-smart MCP server');
    } else {
      sonarSmartServerId = existingSonarSmart.id;
      database.prepare('UPDATE mcp_servers SET url = ? WHERE id = ?')
        .run(config.sonarSmart.mcpUrl, sonarSmartServerId);
    }

    // Re-wire Sonar agent to point at the smart router.
    // Only updates MCP wiring — system_prompt is preserved so user customisations survive.
    const sonarAgent = database.prepare(
      "SELECT id FROM agents WHERE name = 'Sonar'"
    ).get() as { id: string } | undefined;

    if (sonarAgent) {
      database.prepare(`
        UPDATE agents
        SET mcp_server_id = ?, mcp_tool_name = ?, mcp_input_field = ?,
            description = ?
        WHERE name = 'Sonar'
      `).run(
        sonarSmartServerId,
        'sonar',
        'query',
        'Deep web research via Perplexity — auto-routes to fast or deep mode based on query complexity',
      );
      logger.info('Updated Sonar agent to use sonar-smart router');
    } else {
      // Fresh install with sonar-smart from the start
      database.prepare(`
        INSERT INTO agents
          (id, name, description, system_prompt, model, role, capabilities,
           provider, mcp_server_id, mcp_tool_name, mcp_input_field)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        'Sonar',
        'Deep web research via Perplexity — auto-routes to fast or deep mode based on query complexity',
        'You are Sonar, a research specialist powered by Perplexity Smart Router. '
        + 'Answer questions with up-to-date web data and cite your sources. '
        + 'Complex research questions automatically receive deep analysis; simple questions get fast comprehensive answers.',
        null,
        'specialist',
        JSON.stringify(['search', 'research', 'citations', 'web', 'deep-research']),
        'mcp',
        sonarSmartServerId,
        'sonar',
        'query',
      );
      logger.info('Seeded Sonar agent with sonar-smart router');
    }
  }

  // VeniceImage — Venice AI image generation (seeded when session token present)
  if (config.veniceImage.enabled) {
    const existingVeniceServer = database.prepare(
      "SELECT id FROM mcp_servers WHERE name = 'venice-image'"
    ).get() as { id: string } | undefined;

    let veniceServerId: string;
    if (!existingVeniceServer) {
      veniceServerId = randomUUID();
      database.prepare(
        `INSERT INTO mcp_servers (id, name, url, transport, headers, enabled, status)
         VALUES (?, ?, ?, ?, ?, 1, 'ok')`
      ).run(veniceServerId, 'venice-image', config.veniceImage.mcpUrl, 'http', '{}');
      logger.info('Seeded venice-image MCP server');
    } else {
      veniceServerId = existingVeniceServer.id;
      database.prepare('UPDATE mcp_servers SET url = ? WHERE id = ?')
        .run(config.veniceImage.mcpUrl, veniceServerId);
    }

    const veniceImageExists = database.prepare("SELECT id FROM agents WHERE name = 'VeniceImage'").get();
    if (!veniceImageExists) {
      database.prepare(`
        INSERT INTO agents
          (id, name, description, system_prompt, model, role, capabilities,
           provider, mcp_server_id, mcp_tool_name, mcp_input_field)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        'VeniceImage',
        'Image generation via Venice AI Flux models — text-to-image using your Venice subscription',
        'You are VeniceImage, an image generation specialist powered by Venice AI. Generate high-quality images from text prompts.',
        null,
        'specialist',
        JSON.stringify(['image-generation', 'flux', 'venice', 'text-to-image']),
        'mcp',
        veniceServerId,
        'venice_image_generate',
        'prompt',
      );
      logger.info('Seeded VeniceImage agent (Venice-backed)');
    }
  }

  // Canva — official Canva MCP (remote, per-user OAuth). Seeded once DCR
  // client credentials exist (config.canva.configured); the row is HONEST
  // about auth state — it will sit at status='error'/0 cached tools until an
  // operator completes the browser consent flow via GET /api/oauth/canva/start,
  // at which point canva-oauth.ts writes a fresh bearer header and re-probes.
  // No dedicated persona agent seeded here: the generic MCP-registry adapter
  // (tools/adapters/mcp-registry-adapter.ts) already merges every cached
  // remote tool as mcp__canva__<tool> into ALL agents' toolsets once the
  // server has tools_count > 0 — that's the intended exposure surface for a
  // ~25-tool server, not a single wrapper persona.
  if (config.canva.configured) {
    const existingCanvaServer = database.prepare(
      "SELECT id FROM mcp_servers WHERE name = 'canva'"
    ).get() as { id: string } | undefined;

    const headers = config.canva.hasToken
      ? { Authorization: `Bearer ${process.env.CANVA_ACCESS_TOKEN}` }
      : null;

    if (!existingCanvaServer) {
      // Use the audited helper (not a raw INSERT) so this seed emits the same
      // 'mcp_server_created' audit trail as an operator-created server.
      createMcpServer({ name: 'canva', url: config.canva.mcpUrl, transport: 'http', headers, enabled: true });
      logger.info('Seeded canva MCP server', { hasToken: config.canva.hasToken });
    } else if (config.canva.hasToken) {
      // Only overwrite headers on boot if we actually have a token cached in
      // env — never clobber an operator-set header with an empty one.
      updateMcpServer(existingCanvaServer.id, { url: config.canva.mcpUrl, headers });
    }
  }
}

// ── Agent CRUD ───────────────────────────────────────────────────────────────

export interface AgentRecord {
  id:                  string;
  name:                string;
  description:         string | null;
  system_prompt:       string | null;
  model:               string | null;
  role:                string;
  capabilities:        string;
  status:              string;
  temporary:           number;
  spawn_depth:         number;
  parent_agent_id:     string | null;
  created_by_agent_id: string | null;
  expires_at:          string | null;
  provider:            string;
  exec_enabled:        number;
  ssh_enabled:         number;            // 0/1 — may this agent use ssh_run/upload/download
  chat_mode:           number;            // 0/1 — plain-completion mode (no tools/skills/MCP)
  model_tier:          string;
  area_id:             string | null;
  skills:              string;            // JSON array of skill names
  last_heartbeat_at:   string | null;
  heartbeat_status:    string;            // 'ok' | 'fail' | 'skipped' | 'never'
  heartbeat_latency_ms: number | null;
  composio_enabled:    number;            // 0/1
  composio_user_id:    string | null;     // Composio user id (per-agent identity)
  composio_toolkits:   string | null;     // JSON array; null = all toolkits
  composio_tool_allowlist: string | null; // JSON string[] of glob patterns; null = no filter
  composio_token_budget:   number | null; // per-agent cap; null = env COMPOSIO_MAX_TOOLS (40)
  vision_mode:         string;            // 'auto' | 'native' | 'preprocess'
  vision_provider:     string | null;     // null=inherit global VISION_PROVIDER; 'openrouter'|'hermes'
  extra_core_tools:    string | null;     // JSON array of tool names elevated to this agent's upfront list; null=none
  mcp_server_id:       string | null;
  mcp_tool_name:       string | null;
  mcp_input_field:     string | null;     // JSON field name to put the user's message into; defaults to 'query'
  tts_enabled:         number;            // 0/1
  tts_provider:        string;            // 'voidai' | 'elevenlabs' | 'hermes' | 'kokoro' | 'chatterbox'
  tts_voice:           string | null;     // provider-specific voice id (e.g. 'alloy' or an ElevenLabs voice_id)
  spawn_exempt:        number;            // 0/1 — skips evaluateSpawn() LLM gate when spawning
  avatar_url:          string | null;
  voice_provider:      string;            // 'default' | 'gemini_live'
  gemini_live_voice:   string;            // e.g. 'Zephyr'
  gemini_tools_enabled: number;           // 0/1
  // v3.2 (turn budgets) — null means "fall back to workload_profile preset".
  max_turns_soft:      number | null;
  max_turns_hard:      number | null;
  workload_profile:    string;            // 'light' | 'normal' | 'heavy' | 'marathon'
  // Token-optimization directives (spec 2026-07-10, Component A). Opt-in per
  // agent; default OFF so user-facing/prose agents keep their normal voice.
  optimize_terse:      number;            // 0/1 — minimum-prose output directive (caveman-derived)
  optimize_lean_code:  number;            // 0/1 — minimum-code / YAGNI directive (ponytail-derived)
  // Compression Phase 1 engine toggles (null = inherit global default).
  compress_lite:       number | null;
  compress_headroom:   number | null;
  compress_rtk:        number | null;
  created_at:          string;
  updated_at:          string;
}

// ── Discord bots (multi-bot integration) ─────────────────────────────────

export interface DiscordBotRow {
  id:                   string;
  name:                 string;
  token:                string;
  application_id:       string | null;
  default_agent_id:     string | null;
  enabled:              number;
  created_by_agent_id:  string | null;
  created_at:           string;
  last_started_at:      string | null;
  status:               string;
  status_detail:        string | null;
  bot_user_id:          string | null;
  bot_user_tag:         string | null;
  auto_reply_guilds:    string | null;     // JSON array of Discord guild ids
  voice_enabled:         number;            // 0/1; gates whether replies attach synthesized audio
  voice_channel_enabled: number;            // 0/1; gates whether bot joins voice channels
}

/** Parse the JSON-encoded auto_reply_guilds column. Returns [] for null/invalid. */
export function parseAutoReplyGuilds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch { return []; }
}

export interface DiscordChannelRouteRow {
  id:               string;
  bot_id:           string;
  channel_id:       string;
  agent_id:         string;
  require_mention:  number;       // 0 or 1; when 1, overrides guild-level auto_reply for this channel
  auto_reply:       number;       // 0 or 1
  created_at:       string;
}

export function listDiscordBots(includeDisabled = true): DiscordBotRow[] {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  return getDb().prepare(`SELECT * FROM discord_bots ${where} ORDER BY created_at DESC`).all() as DiscordBotRow[];
}

export function getDiscordBot(id: string): DiscordBotRow | null {
  return (getDb().prepare('SELECT * FROM discord_bots WHERE id = ?').get(id) as DiscordBotRow | undefined) ?? null;
}

export function getDiscordBotByToken(token: string): DiscordBotRow | null {
  return (getDb().prepare('SELECT * FROM discord_bots WHERE token = ?').get(token) as DiscordBotRow | undefined) ?? null;
}

export function createDiscordBot(input: {
  name:                 string;
  token:                string;
  application_id?:      string | null;
  default_agent_id?:    string | null;
  created_by_agent_id?: string | null;
}): DiscordBotRow {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO discord_bots (id, name, token, application_id, default_agent_id, created_by_agent_id, enabled, status)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'idle')
  `).run(id, input.name, input.token, input.application_id ?? null, input.default_agent_id ?? null, input.created_by_agent_id ?? null);
  return getDiscordBot(id)!;
}

export function updateDiscordBot(id: string, fields: Partial<{
  name:               string;
  token:              string;
  application_id:     string | null;
  default_agent_id:   string | null;
  enabled:            boolean;
  status:             string;
  status_detail:      string | null;
  bot_user_id:        string | null;
  bot_user_tag:       string | null;
  last_started_at:    string | null;
  auto_reply_guilds:  string[] | null;     // null clears, empty array also clears
  voice_enabled:         boolean;
  voice_channel_enabled: boolean;
}>): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    if (k === 'auto_reply_guilds') {
      const arr = Array.isArray(v) ? (v as string[]).map(s => String(s).trim()).filter(Boolean) : null;
      args.push(arr && arr.length > 0 ? JSON.stringify(arr) : null);
    } else if (typeof v === 'boolean') {
      args.push(v ? 1 : 0);
    } else {
      args.push(v);
    }
  }
  if (sets.length === 0) return;
  args.push(id);
  getDb().prepare(`UPDATE discord_bots SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteDiscordBot(id: string): void {
  getDb().prepare('DELETE FROM discord_bots WHERE id = ?').run(id);
}

export function listDiscordRoutes(botId?: string): DiscordChannelRouteRow[] {
  if (botId) {
    return getDb().prepare('SELECT * FROM discord_channel_routes WHERE bot_id = ? ORDER BY created_at DESC').all(botId) as DiscordChannelRouteRow[];
  }
  return getDb().prepare('SELECT * FROM discord_channel_routes ORDER BY created_at DESC').all() as DiscordChannelRouteRow[];
}

export function upsertDiscordRoute(
  botId: string, channelId: string, agentId: string,
  requireMention?: boolean, autoReply?: boolean,
): DiscordChannelRouteRow {
  const existing = getDb().prepare(
    'SELECT * FROM discord_channel_routes WHERE bot_id = ? AND channel_id = ?'
  ).get(botId, channelId) as DiscordChannelRouteRow | undefined;

  if (existing) {
    const sets: string[] = ['agent_id = ?'];
    const args: unknown[] = [agentId];
    if (requireMention !== undefined) { sets.push('require_mention = ?'); args.push(requireMention ? 1 : 0); }
    if (autoReply !== undefined)      { sets.push('auto_reply = ?');      args.push(autoReply ? 1 : 0); }
    args.push(existing.id);
    getDb().prepare(`UPDATE discord_channel_routes SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return getDb().prepare('SELECT * FROM discord_channel_routes WHERE id = ?').get(existing.id) as DiscordChannelRouteRow;
  }

  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO discord_channel_routes (id, bot_id, channel_id, agent_id, require_mention, auto_reply)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, botId, channelId, agentId, requireMention === true ? 1 : 0, autoReply === true ? 1 : 0);
  return getDb().prepare('SELECT * FROM discord_channel_routes WHERE id = ?').get(id) as DiscordChannelRouteRow;
}

export function setDiscordRouteRequireMention(routeId: string, requireMention: boolean): void {
  getDb().prepare('UPDATE discord_channel_routes SET require_mention = ? WHERE id = ?').run(requireMention ? 1 : 0, routeId);
}

export function setDiscordRouteAutoReply(routeId: string, autoReply: boolean): void {
  getDb().prepare('UPDATE discord_channel_routes SET auto_reply = ? WHERE id = ?').run(autoReply ? 1 : 0, routeId);
}

export function deleteDiscordRoute(id: string): void {
  getDb().prepare('DELETE FROM discord_channel_routes WHERE id = ?').run(id);
}

// ── Discord per-user voice preference ─────────────────────────────────────
// Lets a user mute audio replies on a per-(bot, user) basis without flipping
// the bot or agent globally. `null` → no preference set, fall back to the
// existing bot+agent gate.

export interface DiscordVoicePrefRow {
  bot_id:        string;
  user_id:       string;
  voice_enabled: number;
  reason:        string | null;
  updated_at:    string;
}

export function getDiscordVoicePref(botId: string, userId: string): DiscordVoicePrefRow | null {
  return (getDb()
    .prepare('SELECT * FROM discord_voice_prefs WHERE bot_id = ? AND user_id = ?')
    .get(botId, userId) as DiscordVoicePrefRow | undefined) ?? null;
}

export function setDiscordVoicePref(botId: string, userId: string, enabled: boolean, reason?: string | null): void {
  getDb().prepare(`
    INSERT INTO discord_voice_prefs (bot_id, user_id, voice_enabled, reason, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(bot_id, user_id) DO UPDATE SET
      voice_enabled = excluded.voice_enabled,
      reason        = excluded.reason,
      updated_at    = excluded.updated_at
  `).run(botId, userId, enabled ? 1 : 0, reason ?? null);
}

export function clearDiscordVoicePref(botId: string, userId: string): void {
  getDb().prepare('DELETE FROM discord_voice_prefs WHERE bot_id = ? AND user_id = ?').run(botId, userId);
}

// ── Areas (PARA Map) ──────────────────────────────────────────────────────────

export interface AreaRecord {
  id:          string;
  name:        string;
  icon_glyph:  string;
  color_token: string;
  sort_order:  number;
  created_at:  string;
  updated_at:  string;
}

export function listAreas(): AreaRecord[] {
  return getDb().prepare('SELECT * FROM areas ORDER BY sort_order ASC, created_at ASC').all() as AreaRecord[];
}

export function createArea(name: string, opts: { icon_glyph?: string; color_token?: string; sort_order?: number } = {}): AreaRecord {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO areas (id, name, icon_glyph, color_token, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, opts.icon_glyph ?? '◈', opts.color_token ?? 'neon', opts.sort_order ?? 0);
  logAudit('area_created', 'area', id, { name });
  return getDb().prepare('SELECT * FROM areas WHERE id = ?').get(id) as AreaRecord;
}

export function updateArea(id: string, fields: Partial<Pick<AreaRecord, 'name' | 'icon_glyph' | 'color_token' | 'sort_order'>>): void {
  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"];
  const args: unknown[] = [];
  if (fields.name        !== undefined) { sets.push('name = ?');        args.push(fields.name); }
  if (fields.icon_glyph  !== undefined) { sets.push('icon_glyph = ?');  args.push(fields.icon_glyph); }
  if (fields.color_token !== undefined) { sets.push('color_token = ?'); args.push(fields.color_token); }
  if (fields.sort_order  !== undefined) { sets.push('sort_order = ?');  args.push(fields.sort_order); }
  if (sets.length === 1) return;
  args.push(id);
  getDb().prepare(`UPDATE areas SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  logAudit('area_updated', 'area', id, fields);
}

export function deleteArea(id: string): void {
  getDb().prepare('UPDATE agents SET area_id = NULL WHERE area_id = ?').run(id);
  getDb().prepare('DELETE FROM areas WHERE id = ?').run(id);
  logAudit('area_deleted', 'area', id);
}

export function setAgentArea(agentId: string, areaId: string | null): void {
  getDb().prepare(`UPDATE agents SET area_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(areaId, agentId);
  logAudit('agent_area_set', 'agent', agentId, { area_id: areaId });
}

export function seedDefaultAreas(): void {
  const existing = (getDb().prepare('SELECT COUNT(*) as n FROM areas').get() as { n: number }).n;
  if (existing > 0) return;
  const defaults: Array<[string, string, string]> = [
    ['Lifestyle', '◈', 'neon'],
    ['Finance',   '$', 'amber'],
    ['Health',    '+', 'green'],
    ['Work',      '▣', 'neon-2'],
    ['Learning',  '✦', 'violet'],
  ];
  defaults.forEach(([name, icon, col], i) => createArea(name, { icon_glyph: icon, color_token: col, sort_order: i * 10 }));
}

// ── Projects (Archon port) ───────────────────────────────────────────────
// Top-level grouping for tasks. `docs`/`features`/`data` are JSON columns —
// we keep them as strings on the wire and let callers JSON.parse when they
// actually need the structured form. `pinned` floats favourite projects to
// the top of the dashboard list. Soft-delete via `archived` matches the
// Archon convention used on tasks.

export interface ProjectRecord {
  id:           string;
  title:        string;
  description:  string | null;
  docs:         string;       // JSON array
  features:     string;       // JSON array
  data:         string;       // JSON object
  github_repo:  string | null;
  pinned:       number;       // 0/1
  archived:     number;       // 0/1
  created_at:   string;
  updated_at:   string;
}

export function listProjects(includeArchived = false): ProjectRecord[] {
  const where = includeArchived ? '' : 'WHERE archived = 0';
  return getDb()
    .prepare(`SELECT * FROM projects ${where} ORDER BY pinned DESC, created_at DESC`)
    .all() as ProjectRecord[];
}

export function getProject(id: string): ProjectRecord | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRecord | undefined;
}

export function getProjectByTitle(title: string): ProjectRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM projects WHERE title = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1')
    .get(title) as ProjectRecord | undefined;
}

/** The default "NeuroClaw" project created by the v1.9 migration. Returned
 *  so callers (route handlers, task creators) can fall back to it when the
 *  user / agent didn't pick a specific project. */
export function getDefaultProject(): ProjectRecord {
  const p = getProjectByTitle('NeuroClaw');
  if (p) return p;
  // Fallback create — only triggers if someone deleted the seeded row.
  const id = randomUUID();
  getDb().prepare(
    "INSERT INTO projects (id, title, description, pinned) VALUES (?, ?, ?, 1)",
  ).run(id, 'NeuroClaw', 'Default project (re-seeded).');
  return getProject(id)!;
}

export function createProject(input: {
  title:        string;
  description?: string | null;
  github_repo?: string | null;
  pinned?:      boolean;
  docs?:        unknown;
  features?:    unknown;
  data?:        unknown;
}): ProjectRecord {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO projects (id, title, description, github_repo, pinned, docs, features, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.title.trim(),
    input.description ?? null,
    input.github_repo ?? null,
    input.pinned ? 1 : 0,
    JSON.stringify(input.docs     ?? []),
    JSON.stringify(input.features ?? []),
    JSON.stringify(input.data     ?? {}),
  );
  logAudit('project_created', 'project', id, { title: input.title });
  return getProject(id)!;
}

export function updateProject(
  id: string,
  fields: Partial<{
    title:        string;
    description:  string | null;
    github_repo:  string | null;
    pinned:       boolean;
    archived:     boolean;
    docs:         unknown;
    features:     unknown;
    data:         unknown;
  }>,
): void {
  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"];
  const args: unknown[] = [];
  if (fields.title       !== undefined) { sets.push('title = ?');       args.push(fields.title.trim()); }
  if (fields.description !== undefined) { sets.push('description = ?'); args.push(fields.description); }
  if (fields.github_repo !== undefined) { sets.push('github_repo = ?'); args.push(fields.github_repo); }
  if (fields.pinned      !== undefined) { sets.push('pinned = ?');      args.push(fields.pinned ? 1 : 0); }
  if (fields.archived    !== undefined) { sets.push('archived = ?');    args.push(fields.archived ? 1 : 0); }
  if (fields.docs        !== undefined) { sets.push('docs = ?');        args.push(JSON.stringify(fields.docs)); }
  if (fields.features    !== undefined) { sets.push('features = ?');    args.push(JSON.stringify(fields.features)); }
  if (fields.data        !== undefined) { sets.push('data = ?');        args.push(JSON.stringify(fields.data)); }
  if (sets.length === 1) return;
  args.push(id);
  getDb().prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  logAudit('project_updated', 'project', id, fields);
}

/** Soft-delete a project by flipping `archived = 1`. Use deleteProjectHard()
 *  when the user really wants the row gone (and accepts that orphaned tasks
 *  fall back to the default NeuroClaw project). */
export function archiveProject(id: string): void {
  updateProject(id, { archived: true });
}

/** Permanently remove a project. Tasks that pointed at it are reassigned to
 *  the default NeuroClaw project so we don't violate the FK on a re-read. */
export function deleteProjectHard(id: string): { ok: boolean; reason?: string } {
  const p = getProject(id);
  if (!p) return { ok: false, reason: 'not found' };
  const fallback = getDefaultProject();
  if (p.id === fallback.id) return { ok: false, reason: 'cannot delete the default NeuroClaw project' };
  const db = getDb();
  db.prepare('UPDATE tasks SET project_id = ? WHERE project_id = ?').run(fallback.id, id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  logAudit('project_deleted', 'project', id, { title: p.title, reassigned_to: fallback.id });
  return { ok: true };
}

export function getAgentById(id: string): AgentRecord | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRecord | undefined;
}

export function getAgentByName(name: string): AgentRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM agents WHERE name = ? COLLATE NOCASE')
    .get(name) as AgentRecord | undefined;
}

let _agentsCache: AgentRecord[] | null = null;
let _agentsCacheTs = 0;
const AGENTS_CACHE_TTL_MS = 2_000;

export function invalidateAgentsCache(): void {
  _agentsCache = null;
}

export function getAllAgents(): AgentRecord[] {
  const now = Date.now();
  if (_agentsCache && now - _agentsCacheTs < AGENTS_CACHE_TTL_MS) return _agentsCache;
  _agentsCache = getDb()
    .prepare('SELECT * FROM agents ORDER BY role DESC, name ASC')
    .all() as AgentRecord[];
  _agentsCacheTs = now;
  return _agentsCache;
}

export function createAgentRecord(
  name: string,
  opts: {
    description?: string;
    systemPrompt?: string;
    model?: string;
    role?: string;
    capabilities?: string[];
    provider?: string;
    exec_enabled?: boolean;
    chat_mode?: boolean;
    model_tier?: string;
    skills?: string[];
    mcp_server_id?: string | null;
    mcp_tool_name?: string | null;
    mcp_input_field?: string | null;
    optimize_terse?: boolean;
    optimize_lean_code?: boolean;
    compress_lite?: boolean | null;
    compress_headroom?: boolean | null;
    compress_rtk?: boolean | null;
  } = {},
): AgentRecord {
  const id = randomUUID();
  const db = getDb();
  const provider = opts.provider ?? 'voidai';
  const defaultModel = provider === 'anthropic'
    ? defaultAnthropicModel()
    : provider === 'kimi-api'
      ? config.kimiApi.model
      : provider === 'openrouter'
        ? config.openrouter.model
        : config.voidai.model;
  db.prepare(`
    INSERT INTO agents (id, name, description, system_prompt, model, role, capabilities, provider, exec_enabled, chat_mode, model_tier, skills, mcp_server_id, mcp_tool_name, mcp_input_field)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    opts.description ?? null,
    opts.systemPrompt ?? null,
    opts.model ?? defaultModel,
    opts.role ?? 'agent',
    JSON.stringify(opts.capabilities ?? []),
    provider,
    opts.exec_enabled ? 1 : 0,
    opts.chat_mode ? 1 : 0,
    opts.model_tier ?? 'pinned',
    JSON.stringify(opts.skills ?? []),
    opts.mcp_server_id ?? null,
    opts.mcp_tool_name ?? null,
    opts.mcp_input_field ?? 'query',
  );
  if (
    opts.optimize_terse !== undefined ||
    opts.optimize_lean_code !== undefined ||
    opts.compress_lite !== undefined ||
    opts.compress_headroom !== undefined ||
    opts.compress_rtk !== undefined
  ) {
    updateAgentRecord(id, {
      optimize_terse: opts.optimize_terse,
      optimize_lean_code: opts.optimize_lean_code,
      compress_lite: opts.compress_lite,
      compress_headroom: opts.compress_headroom,
      compress_rtk: opts.compress_rtk,
    });
  }
  logAudit('agent_created', 'agent', id, { name, provider, exec_enabled: !!opts.exec_enabled });
  invalidateAgentsCache();
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRecord;
}

export function updateAgentRecord(
  id: string,
  fields: {
    name?: string;
    description?: string;
    system_prompt?: string;
    model?: string;
    role?: string;
    capabilities?: string[];
    status?: string;
    provider?: string;
    exec_enabled?: boolean;
    ssh_enabled?: boolean;
    chat_mode?: boolean;
    model_tier?: string;
    skills?: string[];
    vision_mode?: string;
    vision_provider?: string | null;
    extra_core_tools?: string[] | string | null;
    composio_enabled?:  boolean;
    composio_user_id?:  string | null;
    composio_toolkits?:       string[] | null;
    composio_tool_allowlist?: string[] | null;   // glob patterns; null clears the filter
    composio_token_budget?:   number  | null;    // null = fall back to COMPOSIO_MAX_TOOLS
    tts_enabled?:  boolean;
    tts_provider?: string;
    tts_voice?:    string | null;
    mcp_server_id?:   string | null;
    mcp_tool_name?:   string | null;
    mcp_input_field?: string | null;
    spawn_exempt?:    boolean;
    avatar_url?:      string | null;
    optimize_terse?:     boolean;
    optimize_lean_code?: boolean;
    compress_lite?:      boolean | null;
    compress_headroom?:  boolean | null;
    compress_rtk?:       boolean | null;
  },
): void {
  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"];
  const params: unknown[] = [];

  if (fields.name          !== undefined) { sets.push('name = ?');          params.push(fields.name); }
  if (fields.description   !== undefined) { sets.push('description = ?');   params.push(fields.description); }
  if (fields.system_prompt !== undefined) { sets.push('system_prompt = ?'); params.push(fields.system_prompt); }
  if (fields.model         !== undefined) { sets.push('model = ?');         params.push(fields.model); }
  if (fields.role          !== undefined) { sets.push('role = ?');          params.push(fields.role); }
  if (fields.capabilities  !== undefined) { sets.push('capabilities = ?');  params.push(JSON.stringify(fields.capabilities)); }
  if (fields.status        !== undefined) { sets.push('status = ?');        params.push(fields.status); }
  if (fields.provider      !== undefined) { sets.push('provider = ?');      params.push(fields.provider); }
  if (fields.exec_enabled  !== undefined) { sets.push('exec_enabled = ?');  params.push(fields.exec_enabled ? 1 : 0); }
  if (fields.ssh_enabled   !== undefined) { sets.push('ssh_enabled = ?');   params.push(fields.ssh_enabled ? 1 : 0); }
  if (fields.chat_mode     !== undefined) { sets.push('chat_mode = ?');     params.push(fields.chat_mode ? 1 : 0); }
  if (fields.model_tier    !== undefined) { sets.push('model_tier = ?');    params.push(fields.model_tier); }
  if (fields.skills        !== undefined) { sets.push('skills = ?');        params.push(JSON.stringify(fields.skills)); }
  if (fields.vision_mode   !== undefined) {
    const v = fields.vision_mode === 'native' || fields.vision_mode === 'preprocess' ? fields.vision_mode : 'auto';
    sets.push('vision_mode = ?'); params.push(v);
  }
  if (fields.vision_provider !== undefined) {
    // null/empty/unknown all collapse to NULL = inherit global VISION_PROVIDER.
    const allowed = ['openrouter', 'hermes'];
    const v = fields.vision_provider && allowed.includes(fields.vision_provider) ? fields.vision_provider : null;
    sets.push('vision_provider = ?'); params.push(v);
  }
  if (fields.extra_core_tools !== undefined) {
    // Write-time: validate SHAPE only (array of strings) → store JSON, else NULL.
    // Names are NOT validated against the registry here because the MCP tool list
    // is dynamic; unknown names are ignored harmlessly at resolution time.
    let arr: string[] | null = null;
    const v = fields.extra_core_tools;
    if (Array.isArray(v)) {
      arr = v.filter((x): x is string => typeof x === 'string');
    } else if (typeof v === 'string' && v.trim()) {
      try { const p = JSON.parse(v); if (Array.isArray(p)) arr = p.filter((x: unknown): x is string => typeof x === 'string'); } catch { arr = null; }
    }
    sets.push('extra_core_tools = ?'); params.push(arr && arr.length ? JSON.stringify(arr) : null);
  }
  if (fields.composio_enabled  !== undefined) { sets.push('composio_enabled = ?');  params.push(fields.composio_enabled ? 1 : 0); }
  if (fields.composio_user_id  !== undefined) { sets.push('composio_user_id = ?');  params.push(fields.composio_user_id); }
  if (fields.composio_toolkits !== undefined) {
    sets.push('composio_toolkits = ?');
    params.push(fields.composio_toolkits === null || fields.composio_toolkits.length === 0 ? null : JSON.stringify(fields.composio_toolkits));
  }
  if (fields.composio_tool_allowlist !== undefined) {
    sets.push('composio_tool_allowlist = ?');
    params.push(fields.composio_tool_allowlist === null || fields.composio_tool_allowlist.length === 0 ? null : JSON.stringify(fields.composio_tool_allowlist));
  }
  if (fields.composio_token_budget !== undefined) {
    sets.push('composio_token_budget = ?');
    params.push(fields.composio_token_budget ?? null);
  }
  if (fields.tts_enabled  !== undefined) { sets.push('tts_enabled = ?');  params.push(fields.tts_enabled ? 1 : 0); }
  if (fields.tts_provider !== undefined) {
    const providers: string[] = ['voidai', 'elevenlabs', 'hermes', 'kokoro', 'chatterbox'];
    const p = providers.includes(fields.tts_provider) ? fields.tts_provider : 'voidai';
    sets.push('tts_provider = ?'); params.push(p);
  }
  if (fields.tts_voice    !== undefined) { sets.push('tts_voice = ?');    params.push(fields.tts_voice); }
  if (fields.mcp_server_id   !== undefined) { sets.push('mcp_server_id = ?');   params.push(fields.mcp_server_id); }
  if (fields.mcp_tool_name   !== undefined) { sets.push('mcp_tool_name = ?');   params.push(fields.mcp_tool_name); }
  if (fields.mcp_input_field !== undefined) { sets.push('mcp_input_field = ?'); params.push(fields.mcp_input_field); }
  if (fields.spawn_exempt    !== undefined) { sets.push('spawn_exempt = ?');    params.push(fields.spawn_exempt ? 1 : 0); }
  if (fields.avatar_url      !== undefined) { sets.push('avatar_url = ?');      params.push(fields.avatar_url); }
  if (fields.optimize_terse     !== undefined) { sets.push('optimize_terse = ?');     params.push(fields.optimize_terse ? 1 : 0); }
  if (fields.optimize_lean_code !== undefined) { sets.push('optimize_lean_code = ?'); params.push(fields.optimize_lean_code ? 1 : 0); }
  if (fields.compress_lite     !== undefined) { sets.push('compress_lite = ?');     params.push(fields.compress_lite === null ? null : fields.compress_lite ? 1 : 0); }
  if (fields.compress_headroom !== undefined) { sets.push('compress_headroom = ?'); params.push(fields.compress_headroom === null ? null : fields.compress_headroom ? 1 : 0); }
  if (fields.compress_rtk      !== undefined) { sets.push('compress_rtk = ?');      params.push(fields.compress_rtk === null ? null : fields.compress_rtk ? 1 : 0); }

  if (sets.length === 1) return;
  params.push(id);
  getDb().prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logAudit('agent_updated', 'agent', id, fields);
  invalidateAgentsCache();
}

export function deactivateAgent(id: string): { ok: boolean; reason?: string } {
  const agent = getAgentById(id);
  if (!agent) return { ok: false, reason: 'not found' };
  if (agent.name === 'Alfred' || agent.name === 'Sentinel') return { ok: false, reason: `${agent.name} cannot be deactivated` };
  updateAgentRecord(id, { status: 'inactive' });
  return { ok: true };
}

export function activateAgent(id: string): void {
  updateAgentRecord(id, { status: 'active' });
}

// ── SSH machine registry (spec: ssh-machine-connections) ───────────────────
// METADATA ONLY. The private key / password lives in the broker as
// SHARED_SSH_<name>_KEY / _PASSWORD; secret_name references it. host_fingerprint
// is TOFU-pinned on first connect. Never store credential VALUES here.
export interface SshMachineRow {
  id:                     string;
  name:                   string;
  host:                   string;
  port:                   number;
  username:               string;
  auth_method:            string;   // 'key' | 'password'
  secret_name:            string;   // broker secret name holding the key/password
  passphrase_secret_name: string | null; // optional broker secret for key passphrase
  host_fingerprint:       string | null; // sha256, append-only (TOFU-pinned)
  fingerprint_status:     string;   // 'pending_verification' | 'verified' | 'mismatch'
  sensitivity:            string;   // 'low' | 'high' | 'critical'
  allowed_agents:         string;   // JSON array of agent IDs (fail-closed empty)
  disabled:               number;   // 0/1 quarantine flag
  legacy_algos:           number;   // 0/1 weak-kex opt-in
  jump_host:              string | null; // nullable v2 bastion stub
  tags:                   string;   // JSON array
  notes:                  string | null;
  last_connected_at:      string | null;
  created_at:             string;
  updated_at:             string;
}

export function listSshMachines(): SshMachineRow[] {
  return getDb().prepare('SELECT * FROM ssh_machines ORDER BY name COLLATE NOCASE').all() as SshMachineRow[];
}

export function getSshMachine(id: string): SshMachineRow | undefined {
  return getDb().prepare('SELECT * FROM ssh_machines WHERE id = ?').get(id) as SshMachineRow | undefined;
}

export function getSshMachineByName(name: string): SshMachineRow | undefined {
  return getDb().prepare('SELECT * FROM ssh_machines WHERE name = ? COLLATE NOCASE').get(name) as SshMachineRow | undefined;
}

export function createSshMachine(opts: {
  name: string; host: string; port?: number; username: string;
  auth_method?: string; secret_name: string; tags?: string[]; notes?: string | null;
  passphrase_secret_name?: string | null; sensitivity?: string;
  allowed_agents?: string[]; legacy_algos?: boolean; jump_host?: string | null;
}): SshMachineRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  const auth = opts.auth_method === 'password' ? 'password' : 'key';
  const sens = ['low', 'high', 'critical'].includes(opts.sensitivity ?? '') ? opts.sensitivity! : 'low';
  getDb().prepare(
    `INSERT INTO ssh_machines
       (id, name, host, port, username, auth_method, secret_name, passphrase_secret_name,
        fingerprint_status, sensitivity, allowed_agents, disabled, legacy_algos, jump_host,
        tags, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_verification', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, opts.name, opts.host, opts.port ?? 22, opts.username, auth,
    opts.secret_name, opts.passphrase_secret_name ?? null,
    sens, JSON.stringify(opts.allowed_agents ?? []), opts.legacy_algos ? 1 : 0,
    opts.jump_host ?? null, JSON.stringify(opts.tags ?? []), opts.notes ?? null, now, now,
  );
  logAudit('ssh_machine_created', 'ssh_machine', id, {
    name: opts.name, host: opts.host, auth_method: auth, sensitivity: sens,
  });
  return getSshMachine(id)!;
}

export function updateSshMachine(id: string, fields: {
  name?: string; host?: string; port?: number; username?: string;
  auth_method?: string; secret_name?: string; tags?: string[]; notes?: string | null;
  host_fingerprint?: string | null; last_connected_at?: string | null;
  passphrase_secret_name?: string | null; fingerprint_status?: string; sensitivity?: string;
  allowed_agents?: string[]; disabled?: boolean; legacy_algos?: boolean; jump_host?: string | null;
}): void {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [new Date().toISOString()];
  if (fields.name                   !== undefined) { sets.push('name = ?');                   params.push(fields.name); }
  if (fields.host                   !== undefined) { sets.push('host = ?');                   params.push(fields.host); }
  if (fields.port                   !== undefined) { sets.push('port = ?');                   params.push(fields.port); }
  if (fields.username               !== undefined) { sets.push('username = ?');               params.push(fields.username); }
  if (fields.auth_method            !== undefined) { sets.push('auth_method = ?');            params.push(fields.auth_method === 'password' ? 'password' : 'key'); }
  if (fields.secret_name            !== undefined) { sets.push('secret_name = ?');            params.push(fields.secret_name); }
  if (fields.passphrase_secret_name !== undefined) { sets.push('passphrase_secret_name = ?'); params.push(fields.passphrase_secret_name); }
  if (fields.tags                   !== undefined) { sets.push('tags = ?');                   params.push(JSON.stringify(fields.tags)); }
  if (fields.notes                  !== undefined) { sets.push('notes = ?');                  params.push(fields.notes); }
  if (fields.host_fingerprint       !== undefined) { sets.push('host_fingerprint = ?');       params.push(fields.host_fingerprint); }
  if (fields.fingerprint_status     !== undefined) { sets.push('fingerprint_status = ?');     params.push(fields.fingerprint_status); }
  if (fields.sensitivity            !== undefined) { sets.push('sensitivity = ?');            params.push(['low','high','critical'].includes(fields.sensitivity) ? fields.sensitivity : 'low'); }
  if (fields.allowed_agents         !== undefined) { sets.push('allowed_agents = ?');         params.push(JSON.stringify(fields.allowed_agents)); }
  if (fields.disabled               !== undefined) { sets.push('disabled = ?');               params.push(fields.disabled ? 1 : 0); }
  if (fields.legacy_algos           !== undefined) { sets.push('legacy_algos = ?');           params.push(fields.legacy_algos ? 1 : 0); }
  if (fields.jump_host              !== undefined) { sets.push('jump_host = ?');              params.push(fields.jump_host); }
  if (fields.last_connected_at      !== undefined) { sets.push('last_connected_at = ?');      params.push(fields.last_connected_at); }
  if (sets.length === 1) return;
  params.push(id);
  getDb().prepare(`UPDATE ssh_machines SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  // Redact secret-shaped fields from the audit detail (names only, never values).
  logAudit('ssh_machine_updated', 'ssh_machine', id, {
    ...fields, host_fingerprint: fields.host_fingerprint ? '<pinned>' : fields.host_fingerprint,
  });
}

export function deleteSshMachine(id: string): { ok: boolean } {
  const r = getDb().prepare('DELETE FROM ssh_machines WHERE id = ?').run(id);
  if (r.changes > 0) logAudit('ssh_machine_deleted', 'ssh_machine', id, {});
  return { ok: r.changes > 0 };
}

// ─── ssh_audit (§11.3) — typed/indexed forensic store for §9.1 alerting ──────
export interface SshAuditRow {
  id:                 string;
  ts:                 string;
  agent_id:           string | null;
  session_id:         string | null;
  task_id:            string | null;
  delegation_chain:   string | null;
  machine_id:         string | null;
  host:               string | null;
  port:               number | null;
  auth_method:        string | null;
  fingerprint_result: string | null; // 'match' | 'first-seen-pending' | 'mismatch-blocked'
  command_scrubbed:   string | null;
  exit_code:          number | null;
  stdout_bytes:       number | null;
  stderr_bytes:       number | null;
  duration_ms:        number | null;
  outcome:            string | null; // success|auth-fail|fingerprint-mismatch|denied-no-grant|denied-gate|error
  exec_id:            string | null;
}

export function insertSshAudit(row: Partial<Omit<SshAuditRow, 'id' | 'ts'>> & { id?: string; ts?: string; outcome?: string | null }): string {
  const id = row.id ?? randomUUID();
  const ts = row.ts ?? new Date().toISOString();
  getDb().prepare(
    `INSERT INTO ssh_audit
       (id, ts, agent_id, session_id, task_id, delegation_chain, machine_id, host, port,
        auth_method, fingerprint_result, command_scrubbed, exit_code, stdout_bytes,
        stderr_bytes, duration_ms, outcome, exec_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, ts, row.agent_id ?? null, row.session_id ?? null, row.task_id ?? null,
    row.delegation_chain ?? null, row.machine_id ?? null, row.host ?? null, row.port ?? null,
    row.auth_method ?? null, row.fingerprint_result ?? null, row.command_scrubbed ?? null,
    row.exit_code ?? null, row.stdout_bytes ?? null, row.stderr_bytes ?? null,
    row.duration_ms ?? null, row.outcome ?? null, row.exec_id ?? null,
  );
  return id;
}

/** Recent ssh_audit rows, optionally filtered by machine/outcome — feeds §9.1 alerting + the Machines tab. */
export function querySshAudit(opts: { machineId?: string; outcome?: string; sinceIso?: string; limit?: number } = {}): SshAuditRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.machineId) { where.push('machine_id = ?'); params.push(opts.machineId); }
  if (opts.outcome)   { where.push('outcome = ?');    params.push(opts.outcome); }
  if (opts.sinceIso)  { where.push('ts >= ?');        params.push(opts.sinceIso); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 1000));
  return getDb().prepare(`SELECT * FROM ssh_audit ${clause} ORDER BY ts DESC LIMIT ?`).all(...params) as SshAuditRow[];
}

// ─── pending_confirmations (§4.3) — ONE shared block-until-human primitive ────
export interface PendingConfirmationRow {
  id:          string;
  kind:        string;  // 'ssh_critical_run' | 'ssh_tofu_pin'
  subject_ref: string | null;
  agent_id:    string | null;
  session_id:  string | null;
  payload:     string | null; // JSON
  status:      string;  // 'pending' | 'approved' | 'denied' | 'expired'
  created_at:  string;
  expires_at:  string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export function createPendingConfirmation(opts: {
  kind: string; subjectRef?: string | null; agentId?: string | null;
  sessionId?: string | null; payload?: unknown; ttlMs?: number;
}): PendingConfirmationRow {
  const id = randomUUID();
  const now = Date.now();
  const created = new Date(now).toISOString();
  const expires = new Date(now + (opts.ttlMs ?? 10 * 60_000)).toISOString(); // §4.3 default ~10 min
  getDb().prepare(
    `INSERT INTO pending_confirmations
       (id, kind, subject_ref, agent_id, session_id, payload, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id, opts.kind, opts.subjectRef ?? null, opts.agentId ?? null, opts.sessionId ?? null,
    opts.payload !== undefined ? JSON.stringify(opts.payload) : null, created, expires,
  );
  return getPendingConfirmation(id)!;
}

export function getPendingConfirmation(id: string): PendingConfirmationRow | undefined {
  return getDb().prepare('SELECT * FROM pending_confirmations WHERE id = ?').get(id) as PendingConfirmationRow | undefined;
}

export function listPendingConfirmations(): PendingConfirmationRow[] {
  return getDb().prepare(
    `SELECT * FROM pending_confirmations WHERE status = 'pending' ORDER BY created_at ASC`,
  ).all() as PendingConfirmationRow[];
}

/** Approve/deny a pending confirmation. Only transitions rows still in 'pending' (idempotent, race-safe). */
export function resolvePendingConfirmation(id: string, status: 'approved' | 'denied', by: string): { ok: boolean } {
  const r = getDb().prepare(
    `UPDATE pending_confirmations SET status = ?, resolved_at = ?, resolved_by = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(status, new Date().toISOString(), by, id);
  return { ok: r.changes > 0 };
}

/** Fail-closed sweep: mark still-pending rows past their TTL as expired. Returns count expired. */
export function expireStalePendingConfirmations(): number {
  const r = getDb().prepare(
    `UPDATE pending_confirmations SET status = 'expired', resolved_at = ?
      WHERE status = 'pending' AND expires_at < ?`,
  ).run(new Date().toISOString(), new Date().toISOString());
  return r.changes;
}

// ── Notebook active-context pointer (spec: native-notebook-rag) ────────────
// Ephemeral per-session "current notebook". Not authoritative — every notebook
// tool takes an explicit notebook_id and only falls back here when omitted.
export function setActiveNotebook(sessionId: string, notebookId: string): void {
  if (!sessionId) return;
  getDb().prepare(
    `INSERT INTO doc_notebook_context (session_id, notebook_id, updated_at)
       VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET notebook_id = excluded.notebook_id, updated_at = excluded.updated_at`,
  ).run(sessionId, notebookId, new Date().toISOString());
}

export function getActiveNotebook(sessionId: string): string | null {
  if (!sessionId) return null;
  const row = getDb().prepare(
    'SELECT notebook_id FROM doc_notebook_context WHERE session_id = ?',
  ).get(sessionId) as { notebook_id?: string } | undefined;
  return row?.notebook_id ?? null;
}

export function clearActiveNotebook(sessionId: string): void {
  if (!sessionId) return;
  getDb().prepare('DELETE FROM doc_notebook_context WHERE session_id = ?').run(sessionId);
}

/**
 * Permanently delete an agent. Alfred/Sentinel are protected. NULLs out FK
 * references so history isn't lost — we orphan the references. For discord
 * channel routes (non-nullable FK), we DELETE the rows since they're config,
 * not history. Use deactivateAgent() for the soft-delete (status='inactive').
 */
export function deleteAgentHard(id: string): { ok: boolean; reason?: string; cleared?: { tasks: number; messages: number; agentMessagesFrom: number; agentMessagesTo: number; discordRoutes: number } } {
  const agent = getAgentById(id);
  if (!agent) return { ok: false, reason: 'not found' };
  if (agent.name === 'Alfred' || agent.name === 'Sentinel') return { ok: false, reason: `${agent.name} is protected from hard delete` };

  const db = getDb();
  // NULL out FK references so we keep historical context but drop the agent.
  const tasksUpd            = db.prepare('UPDATE tasks SET agent_id = NULL WHERE agent_id = ?').run(id);
  const messagesUpd         = db.prepare('UPDATE messages SET agent_id = NULL WHERE agent_id = ?').run(id);
  const agentMessagesFromUpd= db.prepare('UPDATE agent_messages SET from_agent_id = NULL WHERE from_agent_id = ?').run(id);
  const agentMessagesToUpd  = db.prepare('UPDATE agent_messages SET to_agent_id = NULL WHERE to_agent_id = ?').run(id);
  // Drop spawned-by references too so child temp agents aren't orphaned with a dangling parent_agent_id.
  db.prepare('UPDATE agents SET parent_agent_id = NULL, created_by_agent_id = NULL WHERE parent_agent_id = ? OR created_by_agent_id = ?').run(id, id);

  // NULL out other FK references that allow NULL
  db.prepare('UPDATE sessions SET agent_id = NULL WHERE agent_id = ?').run(id);
  db.prepare('UPDATE hive_mind SET agent_id = NULL WHERE agent_id = ?').run(id);
  db.prepare('UPDATE runs SET initiating_agent_id = NULL WHERE initiating_agent_id = ?').run(id);
  db.prepare('UPDATE comms_notes SET agent_id = NULL WHERE agent_id = ?').run(id);
  db.prepare('UPDATE agent_user_messages SET from_agent_id = NULL WHERE from_agent_id = ?').run(id);
  db.prepare('UPDATE memory_index SET agent_id = NULL WHERE agent_id = ?').run(id);

  // discord_channel_routes has NOT NULL FK — delete the config rows (they're
  // route config, not historical data, so deletion is appropriate here)
  const discordRoutesUpd = db.prepare('DELETE FROM discord_channel_routes WHERE agent_id = ?').run(id);

  db.prepare('DELETE FROM agents WHERE id = ?').run(id);

  // Prevent the seed loop from re-creating built-in agents that were intentionally deleted.
  if (SEEDED_AGENT_NAMES.has(agent.name)) {
    db.prepare(
      'INSERT INTO config_items (key, value, description, is_secret) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(`seed_suppress_${agent.name}`, '1', `Suppress auto-seed for ${agent.name}`, 0);
  }

  logAudit('agent_deleted_hard', 'agent', id, { name: agent.name });
  invalidateAgentsCache();
  return {
    ok: true,
    cleared: {
      tasks:                tasksUpd.changes,
      messages:             messagesUpd.changes,
      agentMessagesFrom:    agentMessagesFromUpd.changes,
      agentMessagesTo:      agentMessagesToUpd.changes,
      discordRoutes:        discordRoutesUpd.changes,
    },
  };
}

// ── Session helpers ───────────────────────────────────────────────────────────

export interface SessionRecord {
  id:            string;
  title:         string | null;
  status:        string;          // 'active' | 'archived'
  agent_id:      string | null;
  message_count: number;
  external_id:   string | null;
  source:        string | null;   // immutable origin classification (set at creation)
  title_source:  string;          // 'default' | 'auto' | 'user'
  pinned:        number;          // 0 | 1
  // v3.2: per-session turn budget override. null = use agent's budget.
  max_turns_override: number | null;
  // Per-session chat-mode override. null = inherit agent.chat_mode; 1 = force
  // plain; 0 = force full agent mode.
  chat_mode:     number | null;
  created_at:    string;
  updated_at:    string;
}

export interface MessageRecord {
  id:         string;
  session_id: string;
  role:       string;
  content:    string;
  agent_id:   string | null;
  tokens_used: number;
  created_at: string;
}

/**
 * Create a session. `source` is the immutable origin classification used by
 * session cleanup — pass one of: comms, spawn, step, sentinel, cron,
 * agent_task, dashboard, cli, terminal, voice, discord, room. Omitting it
 * defaults to 'unknown', which cleanup treats as protected (fail-safe).
 */
export function createSession(
  agentId: string,
  title?: string,
  source: string = 'unknown',
  titleSource?: 'default' | 'auto' | 'user',
): string {
  const id = randomUUID();
  // An explicit title is treated as user-set (so the auto-titler skips it) unless
  // the caller overrides; an omitted title gets the placeholder + 'default' provenance,
  // which makes it eligible for auto-titling.
  const resolvedSource = titleSource ?? (title ? 'user' : 'default');
  getDb().prepare(`
    INSERT INTO sessions (id, title, agent_id, source, title_source) VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    title ?? `Chat ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`,
    agentId,
    source,
    resolvedSource,
  );
  return id;
}

/**
 * Look up a session by its stable external key (e.g. "discord::botId::channelId::userId").
 * If no such session exists, creates one and stores the external_id so future
 * lookups hit the same row even after a process restart.
 *
 * This is the correct way for integrations (Discord bot, Slack, etc.) to get a
 * persistent session — avoids the "new session on every restart" bug that occurs
 * when session IDs are cached only in memory.
 */
export function getOrCreateSessionByExternalId(externalId: string, agentId: string, title?: string, source: string = 'unknown'): string {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM sessions WHERE external_id = ?').get(externalId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const titleSource = title ? 'user' : 'default';
  try {
    db.prepare(`
      INSERT INTO sessions (id, title, agent_id, external_id, source, title_source) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      title ?? `Discord ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`,
      agentId, externalId, source, titleSource,
    );
    return id;
  } catch (err) {
    // A concurrent caller won the race and inserted this external_id first
    // (UNIQUE idx_sessions_external). Re-select the existing row instead of
    // creating a duplicate.
    const winner = db.prepare('SELECT id FROM sessions WHERE external_id = ?').get(externalId) as { id: string } | undefined;
    if (winner) return winner.id;
    throw err; // not a uniqueness conflict — surface it
  }
}

export function getSessionById(id: string): SessionRecord | undefined {
  const db = getDb();
  return (db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) ??
          db.prepare('SELECT * FROM sessions WHERE external_id = ?').get(id)) as SessionRecord | undefined;
}

/**
 * Set (or clear) the per-session chat-mode override. value:
 *   true  → force plain completion for this conversation
 *   false → force full agent mode for this conversation
 *   null  → clear the override (inherit the agent's chat_mode default)
 * Resolves external_id → internal id so Discord/CLI sessions work too.
 */
export function setSessionChatMode(sessionId: string, value: boolean | null): void {
  const db = getDb();
  const resolved = (db.prepare('SELECT id FROM sessions WHERE external_id = ?').get(sessionId) as { id: string } | undefined)?.id ?? sessionId;
  db.prepare("UPDATE sessions SET chat_mode = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
    .run(value === null ? null : (value ? 1 : 0), resolved);
}

export function getSessions(limit = 50): SessionRecord[] {
  return getDb()
    .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as SessionRecord[];
}

export function getSessionsWithPreviews(limit = 100): Array<SessionRecord & { last_message: string | null; last_role: string | null }> {
  // Single query: correlated subqueries use idx_messages_session_created so each
  // inner lookup is O(log N) instead of a full scan. No N+1 prepared statements.
  return getDb().prepare(`
    SELECT s.*,
      (SELECT SUBSTR(content, 1, 101) FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS _raw_content,
      (SELECT role              FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_role
    FROM sessions s
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(limit).map((row: unknown) => {
    const r = row as SessionRecord & { _raw_content: string | null; last_role: string | null };
    const raw = r._raw_content;
    const { _raw_content: _, ...rest } = r;
    return {
      ...rest,
      last_message: raw ? (raw.length > 100 ? raw.slice(0, 100) + '…' : raw) : null,
    };
  }) as Array<SessionRecord & { last_message: string | null; last_role: string | null }>;
}

export interface SearchSessionsOpts {
  q?: string;
  source?: string;
  status?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export function searchSessions(opts: SearchSessionsOpts = {}): {
  items: Array<SessionRecord & { last_message: string | null; last_role: string | null }>;
  total: number;
  limit: number;
  offset: number;
} {
  const db = getDb();
  const limit  = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    // Match title OR the most recent message content.
    where.push(`(s.title LIKE ? OR EXISTS(SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ?))`);
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  if (opts.source) { where.push('s.source = ?'); params.push(opts.source); }
  if (opts.status) { where.push('s.status = ?'); params.push(opts.status); }
  if (opts.pinned !== undefined) { where.push('s.pinned = ?'); params.push(opts.pinned ? 1 : 0); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sessions s ${whereSql}`).get(...params) as { n: number }).n;

  const rows = db.prepare(`
    SELECT s.*,
      (SELECT SUBSTR(content, 1, 101) FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS _raw_content,
      (SELECT role              FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_role
    FROM sessions s
    ${whereSql}
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map((row: unknown) => {
    const r = row as SessionRecord & { _raw_content: string | null; last_role: string | null };
    const raw = r._raw_content;
    const { _raw_content: _, ...rest } = r;
    return { ...rest, last_message: raw ? (raw.length > 100 ? raw.slice(0, 100) + '…' : raw) : null };
  }) as Array<SessionRecord & { last_message: string | null; last_role: string | null }>;

  return { items: rows, total, limit, offset };
}

export function getSessionMessages(sessionId: string): MessageRecord[] {
  const db = getDb();
  // Resolve external_id (e.g. "s-1042") to the internal UUID before querying messages.
  const resolved = (db.prepare('SELECT id FROM sessions WHERE external_id = ?').get(sessionId) as { id: string } | undefined)?.id ?? sessionId;
  return db
    .prepare(`
      SELECT m.*, a.name AS agent_name
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.session_id = ?
      ORDER BY m.created_at ASC
    `)
    .all(resolved) as MessageRecord[];
}

export function updateSessionTitle(sessionId: string, title: string, source: 'auto' | 'user' = 'user'): void {
  getDb().prepare(
    `UPDATE sessions SET title = ?, title_source = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  ).run(title, source, sessionId);
}

export function setSessionPinned(sessionId: string, pinned: boolean): void {
  getDb().prepare(
    `UPDATE sessions SET pinned = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  ).run(pinned ? 1 : 0, sessionId);
}

export function setSessionStatus(sessionId: string, status: 'active' | 'archived'): void {
  getDb().prepare(
    `UPDATE sessions SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  ).run(status, sessionId);
}

/** Recompute message_count from ground truth (the messages table) and persist it.
 *  Returns the recomputed count. Used by mergeSessions and available for any future
 *  path that trims messages without deleting the session. */
export function recalcMessageCount(sessionId: string): number {
  const db = getDb();
  const n = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }).n;
  db.prepare(
    `UPDATE sessions SET message_count = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  ).run(n, sessionId);
  return n;
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session_prompts WHERE session_id = ?').run(sessionId);
    // Clean up the session's purely-ephemeral children too. FK enforcement is
    // OFF at runtime, so without this they'd be left as orphan rows pointing at a
    // deleted session. runs (per-turn telemetry) and session_uploads (session-
    // scoped files) have no value once the session is gone. tasks / memories /
    // memory_index are intentionally NOT touched here — they carry independent
    // value and their retention on session delete is a separate decision (and
    // memory is mid-migration to Supabase).
    db.prepare('DELETE FROM runs WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session_uploads WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  })();
  logAudit('session_deleted', 'session', sessionId);
}

// ── Session prompts (WS1 prompt-cache stability) ───────────────────────────

export function getSessionPrompt(sessionId: string, agentId: string | undefined): { prompt: string; prompt_hash: string } | undefined {
  return getDb().prepare(
    'SELECT prompt, prompt_hash FROM session_prompts WHERE session_id = ? AND agent_id = ?',
  ).get(sessionId, agentId ?? '') as { prompt: string; prompt_hash: string } | undefined;
}

export function upsertSessionPrompt(sessionId: string, agentId: string | undefined, prompt: string, promptHash: string): void {
  getDb().prepare(`
    INSERT INTO session_prompts (session_id, agent_id, prompt, prompt_hash, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(session_id, agent_id) DO UPDATE SET
      prompt = excluded.prompt,
      prompt_hash = excluded.prompt_hash,
      updated_at = excluded.updated_at
  `).run(sessionId, agentId ?? '', prompt, promptHash);
}

/**
 * Merge one or more sessions into a single target session.
 *
 * All messages from `mergeSessionIds` are re-homed onto `keepSessionId` via a
 * single UPDATE. The now-empty source sessions are then deleted (messages first,
 * then the session row). The `message_count` on the surviving session is
 * recalculated from the DB so it reflects the new total.
 *
 * Optionally stamps `externalId` on the survivor if it does not already have one.
 *
 * All three writes happen inside a transaction so a mid-flight crash cannot
 * leave messages orphaned on a deleted session.
 *
 * Returns the number of source sessions deleted and messages re-homed.
 */
export function mergeSessions(
  keepSessionId: string,
  mergeSessionIds: string[],
  externalId?: string | null,
): { merged: number; messagesRehoused: number } {
  if (mergeSessionIds.length === 0) return { merged: 0, messagesRehoused: 0 };

  const db = getDb();

  const doMerge = db.transaction(() => {
    // Build an IN(...) placeholder list — safe because these are our own UUIDs.
    const placeholders = mergeSessionIds.map(() => '?').join(', ');

    // Re-home all messages from the source sessions to the survivor.
    const moveResult = db.prepare(
      `UPDATE messages SET session_id = ? WHERE session_id IN (${placeholders})`
    ).run(keepSessionId, ...mergeSessionIds);

    // Delete the now-empty source sessions (messages row already re-homed above).
    db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...mergeSessionIds);

    // Recalculate message_count on the survivor from ground truth.
    recalcMessageCount(keepSessionId);

    // Stamp external_id on the survivor only if it does not already have one.
    if (externalId) {
      db.prepare(
        `UPDATE sessions SET external_id = ? WHERE id = ? AND external_id IS NULL`
      ).run(externalId, keepSessionId);
    }

    return { merged: mergeSessionIds.length, messagesRehoused: moveResult.changes };
  });

  const result = doMerge();
  logAudit('sessions_merged', 'session', keepSessionId, {
    merged: mergeSessionIds,
    messagesRehoused: result.messagesRehoused,
    externalId: externalId ?? null,
  });
  return result;
}

export function saveMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  agentId?: string,
): void {
  const id = randomUUID();
  const database = getDb();
  database.prepare(`
    INSERT INTO messages (id, session_id, role, content, agent_id) VALUES (?, ?, ?, ?, ?)
  `).run(id, sessionId, role, content, agentId ?? null);
  database.prepare(`
    UPDATE sessions SET message_count = message_count + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
  `).run(sessionId);
  // Auto-title hook. Dynamic import avoids a static db→session-namer→db cycle.
  // The namer is fully guarded (provenance + >=2 msgs + user-facing source) and
  // fire-and-forget; failures never affect the message write.
  if (role === 'assistant') {
    void import('./system/session-namer')
      .then(m => m.maybeGenerateSessionTitle(sessionId))
      .catch(() => { /* namer module load failed — ignore */ });
  }
}

export function deleteLastUserMessage(sessionId: string, agentId?: string): void {
  const db = getDb();
  const row = agentId
    ? db.prepare(`SELECT id FROM messages WHERE session_id = ? AND agent_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1`).get(sessionId, agentId) as { id: string } | undefined
    : db.prepare(`SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1`).get(sessionId) as { id: string } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
  db.prepare(`UPDATE sessions SET message_count = MAX(0, message_count - 1), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(sessionId);
}

export function getAlfredAgent(): AgentRecord | undefined {
  return getAgentByName('Alfred');
}

export function getSentinelAgent(): AgentRecord | undefined {
  return getAgentByName('Sentinel');
}

// ── Logging helpers ───────────────────────────────────────────────────────────

export function logAudit(action: string, entityType?: string, entityId?: string, details?: unknown): void {
  getDb().prepare(`
    INSERT INTO audit_logs (id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    action,
    entityType ?? null,
    entityId ?? null,
    details !== undefined ? JSON.stringify(details) : null,
  );
}

export function logAnalytics(eventType: string, data?: unknown, sessionId?: string): void {
  getDb().prepare(`
    INSERT INTO analytics_events (id, event_type, data, session_id)
    VALUES (?, ?, ?, ?)
  `).run(
    randomUUID(),
    eventType,
    data !== undefined ? JSON.stringify(data) : null,
    sessionId ?? null,
  );
}

// ── Skill telemetry (Pillar 3 of MED skill plan) ─────────────────────────────
// Passive: every call records one row. No throttling, no warnings, no pruning
// suggestions. The Skills page reads aggregates from this table to show fire
// counts and last-used timestamps. That's it. Frontier-model users will
// ignore the data; low-tier users will use it to consolidate skills.
//
// We deliberately DON'T:
//   - Aggregate at write time (a row per injection is cheap; aggregation is
//     a single read-side query)
//   - Tie this to audit_logs (parsing JSON for every dashboard tick is wasteful)
//   - Track "correction rate" yet — that needs a clean signal we don't have
//     ergonomically today. Leave it for a future iteration.

export interface SkillInvocationInput {
  skillName:  string;
  agentId?:   string | null;
  sessionId?: string | null;
  /** Agent's model_tier at injection time. Lets us see if low-tier injections pay off. */
  tier?:      string | null;
  /** 'declared' (agent explicitly listed the skill) | 'always_on' (forced by frontmatter). */
  source?:    'declared' | 'always_on' | string | null;
}

export function recordSkillInvocation(inp: SkillInvocationInput): void {
  try {
    getDb().prepare(`
      INSERT INTO skill_invocations (skill_name, agent_id, session_id, tier, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      inp.skillName,
      inp.agentId  ?? null,
      inp.sessionId ?? null,
      inp.tier      ?? null,
      inp.source    ?? null,
    );
  } catch {
    // Telemetry must never throw — if the table is missing or locked, the
    // user's actual skill execution continues unaffected.
  }
}

/** Aggregate row returned by getSkillTelemetry(). One per skill in the table. */
export interface SkillTelemetryRow {
  skill_name:    string;
  fire_count:    number;       // total injections all-time
  last_fired_at: string | null;
  unique_agents: number;
  unique_sessions: number;
  /** Counts by tier — gives a sense of which tiers actually use the skill. */
  by_tier:       Record<string, number>;
}

/** Return one row per skill that has ever been injected. Skills with zero
 *  invocations are NOT returned — the caller (Skills page) merges this against
 *  the live catalog from skill-loader so dormant skills show as "never fired". */
export function getSkillTelemetry(): SkillTelemetryRow[] {
  const rows = getDb().prepare(`
    SELECT skill_name,
           COUNT(*)                              AS fire_count,
           MAX(injected_at)                      AS last_fired_at,
           COUNT(DISTINCT agent_id)              AS unique_agents,
           COUNT(DISTINCT session_id)            AS unique_sessions
    FROM skill_invocations
    GROUP BY skill_name
  `).all() as Array<{
    skill_name: string; fire_count: number; last_fired_at: string | null;
    unique_agents: number; unique_sessions: number;
  }>;

  // Pull per-tier breakdowns in one extra query, then join in memory. Saves us
  // from a much uglier GROUP BY with conditional aggregates.
  const tierRows = getDb().prepare(`
    SELECT skill_name, COALESCE(tier, 'unknown') AS tier, COUNT(*) AS n
    FROM skill_invocations
    GROUP BY skill_name, tier
  `).all() as Array<{ skill_name: string; tier: string; n: number }>;

  const tierMap = new Map<string, Record<string, number>>();
  for (const r of tierRows) {
    const m = tierMap.get(r.skill_name) ?? {};
    m[r.tier] = r.n;
    tierMap.set(r.skill_name, m);
  }

  return rows.map(r => ({
    skill_name:      r.skill_name,
    fire_count:      r.fire_count,
    last_fired_at:   r.last_fired_at,
    unique_agents:   r.unique_agents,
    unique_sessions: r.unique_sessions,
    by_tier:         tierMap.get(r.skill_name) ?? {},
  }));
}

// ── Runs (v2.0 run grouping) ─────────────────────────────────────────────────

export type RunStatus = 'running' | 'done' | 'error' | 'paused' | 'detached' | 'dropped' | 'stopped';

export interface RunRecord {
  id:                  string;
  session_id:          string | null;
  parent_run_id:       string | null;
  origin:              string;
  initiating_agent_id: string | null;
  user_message:        string;
  final_output:        string | null;
  status:              RunStatus;
  is_multi_agent:      number;
  step_count:          number;
  total_input_tokens:  number;
  total_output_tokens: number;
  duration_ms:         number | null;
  error_text:          string | null;
  started_at:          string;
  ended_at:            string | null;
  // v3.2: resumable runs.
  current_activity:    string | null;
  last_heartbeat_at:   string | null;
  partial_output:      string | null;
  turn_number:         number;
  detached_at:         string | null;
  // Background-generation delivery.
  delivery_target:     string | null;   // JSON: { botId, channelId, messageId, userId, guildId }
  delivered:           number;          // 0 = pending, 1 = delivered, -1 = permanently failed
  notify_attempts:     number;
}

/** Alias used by callers that just want the same row shape. */
export type RunRow = RunRecord;

export interface StartRunInput {
  origin:              string;
  sessionId?:          string | null;
  parentRunId?:        string | null;
  initiatingAgentId?:  string | null;
  userMessage:         string;
  deliveryTarget?:     Record<string, unknown> | null;
}

export function startRun(input: StartRunInput): string {
  const id = randomUUID();
  try {
    getDb().prepare(`
      INSERT INTO runs (
        id, session_id, parent_run_id, origin, initiating_agent_id, user_message, delivery_target
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId ?? null,
      input.parentRunId ?? null,
      input.origin,
      input.initiatingAgentId ?? null,
      input.userMessage,
      input.deliveryTarget ? JSON.stringify(input.deliveryTarget) : null,
    );
  } catch (err) {
    logger.warn('startRun: insert failed', { error: (err as Error).message });
  }
  return id;
}

export interface EndRunPatch {
  status?:              'done' | 'error' | 'paused' | 'stopped' | 'dropped';
  final_output?:        string | null;
  is_multi_agent?:      boolean;
  step_count?:          number;
  total_input_tokens?:  number;
  total_output_tokens?: number;
  error_text?:          string | null;
}

export function endRun(runId: string, patch: EndRunPatch = {}): void {
  const sets: string[] = [
    "ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
    "duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)",
  ];
  const params: unknown[] = [];

  if (patch.status              !== undefined) { sets.push('status = ?');              params.push(patch.status); }
  if (patch.final_output        !== undefined) { sets.push('final_output = ?');        params.push(patch.final_output); }
  if (patch.is_multi_agent      !== undefined) { sets.push('is_multi_agent = ?');      params.push(patch.is_multi_agent ? 1 : 0); }
  if (patch.step_count          !== undefined) { sets.push('step_count = ?');          params.push(patch.step_count); }
  if (patch.total_input_tokens  !== undefined) { sets.push('total_input_tokens = ?');  params.push(patch.total_input_tokens); }
  if (patch.total_output_tokens !== undefined) { sets.push('total_output_tokens = ?'); params.push(patch.total_output_tokens); }
  if (patch.error_text          !== undefined) { sets.push('error_text = ?');          params.push(patch.error_text); }

  // Default status to 'done' when caller didn't specify (and didn't already error).
  if (patch.status === undefined) { sets.push("status = 'done'"); }

  params.push(runId);
  try {
    getDb().prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    // Notify delivery subscribers once the terminal state is committed.
    // 'paused' is not terminal; 'dropped' is handled by the delivery sweeper.
    // Emitted inside the try so a failed UPDATE never fires a stale event.
    const finalStatus = patch.status ?? 'done';
    if (finalStatus === 'done' || finalStatus === 'error' || finalStatus === 'stopped') {
      try {
        runEvents.emit('run:terminal', { runId, status: finalStatus } as RunTerminalEvent);
      } catch {
        // Event emission must never crash the chat path.
      }
    }
    // Also announce on the live agent bus so attached SSE watchers (resume
    // connections, secondary tabs) learn about the terminal state instantly.
    // The primary /api/chat stream skips its 'done' SSE write when the client
    // disconnected mid-run — without this emit, those watchers only caught up
    // via the resume endpoint's 1.5s DB poll (or showed "thinking" forever).
    try {
      const row = getDb().prepare('SELECT session_id FROM runs WHERE id = ?').get(runId) as { session_id: string | null } | undefined;
      if (row?.session_id) {
        if (finalStatus === 'error' || finalStatus === 'dropped') {
          agentBus.emitAgent({ type: 'error', sessionId: row.session_id, runId, message: patch.error_text ?? `run ended (${finalStatus})` });
        } else {
          agentBus.emitAgent({ type: 'thought_end', sessionId: row.session_id, runId, signal: finalStatus });
        }
      }
    } catch {
      // Bus emission must never crash the chat path.
    }
  } catch (err) {
    logger.warn('endRun: update failed', { runId, error: (err as Error).message });
  }
}

/**
 * Increment a run's running token counters. Called per LLM iteration so that
 * tool-loop turns and multi-agent step turns all roll up into the parent run.
 */
export function bumpRunTokens(runId: string, inputTokens: number, outputTokens: number): void {
  try {
    getDb().prepare(`
      UPDATE runs
         SET total_input_tokens  = total_input_tokens  + ?,
             total_output_tokens = total_output_tokens + ?
       WHERE id = ?
    `).run(inputTokens | 0, outputTokens | 0, runId);
  } catch {
    // Token bookkeeping must never crash the chat path.
  }
}

/**
 * v3.2: heartbeat + checkpoint write. Called every N seconds by the heartbeat
 * emitter so a detached / disconnected client can resume by reading
 * runs.partial_output + runs.current_activity. Best-effort — must never crash
 * the agent loop.
 */
export function updateRunHeartbeat(
  runId: string,
  activity: string,
  turnNumber: number,
  partialOutput?: string,
): void {
  try {
    const sets: string[] = [
      "last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
      'current_activity = ?',
      'turn_number = ?',
    ];
    const params: unknown[] = [activity, turnNumber | 0];
    if (partialOutput !== undefined) {
      sets.push('partial_output = ?');
      params.push(partialOutput);
    }
    params.push(runId);
    getDb().prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch {
    // bookkeeping must never crash the chat path
  }
}

/**
 * v3.2: append a chunk to runs.partial_output. Called on every streamed chunk
 * so a disconnected client can replay all accumulated output on resume.
 * Uses SQLite COALESCE-concat so we don't have to round-trip the full string.
 */
export function appendPartialOutput(runId: string, chunk: string): void {
  if (!chunk) return;
  try {
    getDb().prepare(
      `UPDATE runs SET partial_output = COALESCE(partial_output, '') || ? WHERE id = ?`
    ).run(chunk, runId);
  } catch {
    // bookkeeping must never crash the chat path
  }
}

/**
 * v3.2: mark a run as detached (client disconnected, but the agent loop is
 * still running and will continue writing to partial_output). The run will
 * naturally flip to 'done' / 'paused' / 'stopped' when the loop ends.
 */
export function detachRun(runId: string): void {
  try {
    getDb().prepare(
      `UPDATE runs
          SET status = 'detached',
              detached_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?
          AND status = 'running'`
    ).run(runId);
  } catch (err) {
    logger.warn('detachRun: update failed', { runId, error: (err as Error).message });
  }
}

/**
 * v3.2: find the most recent resumable run for a session. Used by
 * GET /api/chat/resume/:sessionId to re-attach to an in-flight or just-
 * completed turn after a network blip.
 */
export function findResumableRun(sessionId: string): RunRecord | null {
  try {
    const row = getDb().prepare(`
      SELECT * FROM runs
       WHERE session_id = ?
         AND status IN ('running','detached','paused','done','error','stopped')
       ORDER BY started_at DESC
       LIMIT 1
    `).get(sessionId) as RunRecord | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Most recent run for a session regardless of status — used by the subtask
 * continuation to recover the origin + Discord delivery_target so a proactive
 * follow-up lands on the same surface the user is on.
 */
export function getLatestRunForSession(sessionId: string): RunRecord | null {
  try {
    const row = getDb().prepare(
      `SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(sessionId) as RunRecord | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** True if the session has a run currently mid-flight (a live turn the user is
 *  watching / interacting with). The subtask continuation skips proactive
 *  follow-ups while one is active to avoid colliding with a live reply. */
export function sessionHasActiveRun(sessionId: string): boolean {
  try {
    const row = getDb().prepare(
      `SELECT 1 FROM runs WHERE session_id = ? AND status IN ('running','detached') LIMIT 1`,
    ).get(sessionId) as { 1: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/**
 * v3.2: mark a run as dropped (the heartbeat went stale — the host process
 * almost certainly died mid-run). Called by the sentinel sweep.
 */
export function markRunDropped(runId: string, reason: string): void {
  try {
    const res = getDb().prepare(`
      UPDATE runs
         SET status     = 'dropped',
             error_text = ?,
             ended_at   = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
       WHERE id = ?
         AND status IN ('running','detached','paused')
    `).run(reason, runId);
    // Unstick any live watchers immediately (resume connections would
    // otherwise wait for their next DB poll to notice the drop).
    if (res.changes > 0) {
      try {
        const row = getDb().prepare('SELECT session_id FROM runs WHERE id = ?').get(runId) as { session_id: string | null } | undefined;
        if (row?.session_id) {
          agentBus.emitAgent({ type: 'error', sessionId: row.session_id, runId, message: reason });
        }
      } catch { /* best-effort */ }
      // Re-arm the subtask continuation for any session parked 'pending' behind
      // this run. A dropped run is NOT a clean terminal, so it does NOT fire
      // 'run:terminal' (that would also wake run-delivery / run-continuation and
      // double-deliver). This dedicated signal is consumed ONLY by the subtask
      // continuation's re-arm listener.
      try {
        runEvents.emit('run:dropped', { runId, status: 'dropped' } as RunTerminalEvent);
      } catch { /* event emission must never crash */ }
    }
  } catch (err) {
    logger.warn('markRunDropped: update failed', { runId, error: (err as Error).message });
  }
}

/**
 * v3.2: list runs whose heartbeat hasn't ticked within `maxAgeMs`. These are
 * candidates for the stale-run sweep. We only flag runs that are CURRENTLY
 * marked 'running' (or 'detached') — the others have already terminated.
 *
 * `last_heartbeat_at IS NULL` is treated as "never beat" — those are flagged
 * too if started_at is older than the threshold.
 */
export function listStaleRuns(maxAgeMs: number): RunRecord[] {
  try {
    return getDb().prepare(`
      SELECT * FROM runs
       WHERE status IN ('running','detached','paused')
         AND (
           (last_heartbeat_at IS NOT NULL
              AND (julianday('now') - julianday(last_heartbeat_at)) * 86400000 > ?)
           OR (last_heartbeat_at IS NULL
              AND (julianday('now') - julianday(started_at)) * 86400000 > ?)
         )
    `).all(maxAgeMs, maxAgeMs) as RunRecord[];
  } catch {
    return [];
  }
}

export function getRun(id: string): RunRecord | undefined {
  return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined;
}

export function listRuns(opts: { sessionId?: string; limit?: number } = {}): (RunRecord & { agent_name: string | null; event_count: number })[] {
  const where: string[] = [];
  const args:  unknown[] = [];
  if (opts.sessionId) { where.push('r.session_id = ?'); args.push(opts.sessionId); }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const sql = `
    SELECT r.*, a.name AS agent_name, COUNT(hm.id) AS event_count
      FROM runs r
 LEFT JOIN agents a ON r.initiating_agent_id = a.id
 LEFT JOIN hive_mind hm ON hm.run_id = r.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY r.id
    ORDER BY r.started_at DESC
    LIMIT ?
  `;
  return getDb().prepare(sql).all(...args, limit) as (RunRecord & { agent_name: string | null; event_count: number })[];
}

/** Set a run's delivery state: 0 = pending, 1 = delivered, -1 = permanently failed. */
export function markRunDelivered(runId: string, state: 0 | 1 | -1): void {
  try {
    getDb().prepare('UPDATE runs SET delivered = ? WHERE id = ?').run(state, runId);
  } catch (err) {
    logger.warn('markRunDelivered: update failed', { runId, error: (err as Error).message });
  }
}

/** Increment a run's delivery-attempt counter; returns the new count. */
export function bumpNotifyAttempts(runId: string): number {
  try {
    getDb().prepare('UPDATE runs SET notify_attempts = notify_attempts + 1 WHERE id = ?').run(runId);
    const row = getDb().prepare('SELECT notify_attempts FROM runs WHERE id = ?')
      .get(runId) as { notify_attempts: number } | undefined;
    return row?.notify_attempts ?? 0;
  } catch (err) {
    logger.warn('bumpNotifyAttempts: update failed', { runId, error: (err as Error).message });
    return 0;
  }
}

/** Terminal Discord-origin runs that have not yet been delivered and are still under the retry cap. */
export function listUndeliveredDiscordRuns(maxAttempts: number): RunRecord[] {
  try {
    return getDb().prepare(`
      SELECT * FROM runs
       WHERE origin = 'discord'
         AND delivered = 0
         AND status IN ('done','error','dropped')
         AND notify_attempts < ?
       ORDER BY started_at ASC
       LIMIT 50
    `).all(maxAttempts) as RunRecord[];
  } catch {
    return [];
  }
}

/** Fetch all hive_mind events tied to a run, oldest-first. */
export function getRunHiveEvents(runId: string): Array<{
  id: string; agent_id: string | null; agent_name: string | null;
  action: string; summary: string; metadata: string | null; created_at: string;
}> {
  return getDb().prepare(`
    SELECT hm.id, hm.agent_id, hm.action, hm.summary, hm.metadata, hm.created_at,
           a.name AS agent_name
      FROM hive_mind hm
 LEFT JOIN agents a ON hm.agent_id = a.id
     WHERE hm.run_id = ?
  ORDER BY hm.created_at ASC
  `).all(runId) as Array<{
    id: string; agent_id: string | null; agent_name: string | null;
    action: string; summary: string; metadata: string | null; created_at: string;
  }>;
}

// ── Agent messages (inter-agent comms) ───────────────────────────────────────

export interface AgentMessageRecord {
  id:            string;
  from_agent_id: string;
  from_name:     string;
  to_agent_id:   string;
  to_name:       string;
  content:       string;
  response:      string | null;
  status:        'pending' | 'delivered' | 'responded' | 'failed';
  session_id:    string | null;
  task_id:       string | null;
  created_at:    string;
  updated_at:    string;
}

export function createAgentMessage(
  fromAgentId: string | null,
  fromName: string,
  toAgentId: string,
  toName: string,
  content: string,
  sessionId?: string,
): AgentMessageRecord {
  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_messages
      (id, from_agent_id, from_name, to_agent_id, to_name, content, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, fromAgentId ?? null, fromName, toAgentId, toName, content, sessionId ?? null);
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessageRecord;
}

export function updateAgentMessageResponse(
  id: string,
  response: string,
  status: 'responded' | 'failed' = 'responded',
  taskId?: string,
): void {
  getDb().prepare(`
    UPDATE agent_messages
    SET response = ?, status = ?, task_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ?
  `).run(response, status, taskId ?? null, id);
}

/**
 * Pending (undelivered) agent messages addressed to an agent, oldest first.
 * Used by the agent inbox to surface async messages into the agent's next turn.
 */
export function getPendingAgentMessages(agentId: string, limit: number): AgentMessageRecord[] {
  return getDb().prepare(`
    SELECT * FROM agent_messages
    WHERE to_agent_id = ? AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(agentId, limit) as AgentMessageRecord[];
}

/**
 * Flip a batch of agent messages to 'delivered'. Called by the inbox when it
 * surfaces messages into an agent turn. No-op on an empty array.
 */
export function markAgentMessagesDelivered(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`
    UPDATE agent_messages
    SET status = 'delivered', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id IN (${placeholders})
  `).run(...ids);
}

export function getAgentMessages(limit = 100): AgentMessageRecord[] {
  return getDb()
    .prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AgentMessageRecord[];
}

export function getAgentMessagesByAgent(agentId: string, limit = 50): AgentMessageRecord[] {
  return getDb()
    .prepare(`
      SELECT * FROM agent_messages
      WHERE from_agent_id = ? OR to_agent_id = ?
      ORDER BY created_at DESC LIMIT ?
    `)
    .all(agentId, agentId, limit) as AgentMessageRecord[];
}

// ── Comms notes (user-authored annotations) ──────────────────────────────

export interface CommsNoteRecord {
  id:             string;
  author:         string;
  body:           string;
  visibility:     'private' | 'shared';
  agent_id:       string | null;
  session_id:     string | null;
  ref_message_id: string | null;
  pinned:         number;
  created_at:     string;
  updated_at:     string;
}

export function createCommsNote(input: {
  body: string;
  author?: string;
  visibility?: 'private' | 'shared';
  agentId?: string | null;
  sessionId?: string | null;
  refMessageId?: string | null;
  pinned?: boolean;
}): CommsNoteRecord {
  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO comms_notes
      (id, author, body, visibility, agent_id, session_id, ref_message_id, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.author ?? 'User',
    input.body,
    input.visibility ?? 'private',
    input.agentId ?? null,
    input.sessionId ?? null,
    input.refMessageId ?? null,
    input.pinned ? 1 : 0,
  );
  return db.prepare('SELECT * FROM comms_notes WHERE id = ?').get(id) as CommsNoteRecord;
}

export function getCommsNotes(limit = 100): CommsNoteRecord[] {
  return getDb()
    .prepare('SELECT * FROM comms_notes ORDER BY pinned DESC, created_at DESC LIMIT ?')
    .all(limit) as CommsNoteRecord[];
}

export function deleteCommsNote(id: string): boolean {
  const result = getDb().prepare('DELETE FROM comms_notes WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateCommsNote(
  id: string,
  patch: { body?: string; visibility?: 'private' | 'shared'; pinned?: boolean },
): CommsNoteRecord | null {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.body !== undefined)       { fields.push('body = ?');       values.push(patch.body); }
  if (patch.visibility !== undefined) { fields.push('visibility = ?'); values.push(patch.visibility); }
  if (patch.pinned !== undefined)     { fields.push('pinned = ?');     values.push(patch.pinned ? 1 : 0); }
  if (fields.length === 0) {
    return db.prepare('SELECT * FROM comms_notes WHERE id = ?').get(id) as CommsNoteRecord | null;
  }
  fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
  values.push(id);
  db.prepare(`UPDATE comms_notes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM comms_notes WHERE id = ?').get(id) as CommsNoteRecord | null;
}

/**
 * Returns 'shared' notes targeted at a given agent (or untargeted, i.e. broadcast
 * to all agents). Used by the agent runtime to inject user-authored guidance into
 * the system prompt. Capped to keep prompts bounded.
 */
export function getSharedCommsNotesForAgent(agentId: string | null, limit = 8): CommsNoteRecord[] {
  return getDb().prepare(`
    SELECT * FROM comms_notes
    WHERE (visibility = 'shared' OR pinned = 1)
      AND (agent_id IS NULL OR agent_id = ?)
    ORDER BY pinned DESC, created_at DESC
    LIMIT ?
  `).all(agentId ?? null, limit) as CommsNoteRecord[];
}

// ── Agent → User messages (notifications) ────────────────────────────────

export type AgentUserMessageKind = 'info' | 'question' | 'alert' | 'update';

export interface AgentUserMessageRecord {
  id:            string;
  from_agent_id: string;
  from_name:     string;
  kind:          AgentUserMessageKind;
  body:          string;
  metadata:      string | null;
  session_id:    string | null;
  created_at:    string;
  read_at:       string | null;
  dismissed_at:  string | null;
}

export function createAgentUserMessage(input: {
  fromAgentId: string;
  fromName: string;
  kind?: AgentUserMessageKind;
  body: string;
  metadata?: Record<string, unknown> | null;
  sessionId?: string | null;
}): AgentUserMessageRecord {
  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_user_messages
      (id, from_agent_id, from_name, kind, body, metadata, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.fromAgentId,
    input.fromName,
    input.kind ?? 'info',
    input.body,
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.sessionId ?? null,
  );
  const record = db.prepare('SELECT * FROM agent_user_messages WHERE id = ?').get(id) as AgentUserMessageRecord;
  const event: DashboardNotificationEvent = {
    type: 'agent_user_message',
    id: record.id,
    source: record.from_name,
    title: `${record.from_name} (${record.kind})`,
    body: record.body,
    severity: record.kind as DashboardNotificationEvent['severity'],
    metadata: record.metadata ? JSON.parse(record.metadata) : undefined,
    url: `/dashboard#/comms`,
  };
  notificationEvents.emit('new', event);
  return record;
}

export function getAgentUserMessages(opts: {
  limit?: number;
  unreadOnly?: boolean;
  undismissedOnly?: boolean;
} = {}): AgentUserMessageRecord[] {
  const { limit = 100, unreadOnly = false, undismissedOnly = true } = opts;
  const where: string[] = [];
  if (unreadOnly)       where.push('read_at IS NULL');
  if (undismissedOnly)  where.push('dismissed_at IS NULL');
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM agent_user_messages ${whereClause} ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AgentUserMessageRecord[];
}

export function getAgentUserMessageById(id: string): AgentUserMessageRecord | null {
  return getDb().prepare('SELECT * FROM agent_user_messages WHERE id = ?').get(id) as AgentUserMessageRecord | null;
}

export function markAgentUserMessageRead(id: string): AgentUserMessageRecord | null {
  getDb().prepare(`
    UPDATE agent_user_messages
    SET read_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ? AND read_at IS NULL
  `).run(id);
  return getDb().prepare('SELECT * FROM agent_user_messages WHERE id = ?').get(id) as AgentUserMessageRecord | null;
}

export function markAgentUserMessageDismissed(id: string): AgentUserMessageRecord | null {
  getDb().prepare(`
    UPDATE agent_user_messages
    SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ? AND dismissed_at IS NULL
  `).run(id);
  return getDb().prepare('SELECT * FROM agent_user_messages WHERE id = ?').get(id) as AgentUserMessageRecord | null;
}

export function getUnreadAgentUserMessageCount(): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as count FROM agent_user_messages
    WHERE read_at IS NULL AND dismissed_at IS NULL
  `).get() as { count: number };
  return row?.count ?? 0;
}

// ── MCP server registry (v1.9) ───────────────────────────────────────────
// User-managed remote MCP servers. Tools are probed and cached so the
// agent runtimes can expose them under mcp__<server>__<tool> names without
// hitting the network on every chat turn.

export interface McpServerRow {
  id:             string;
  name:           string;
  url:            string;
  transport:      string;
  headers:        string | null;     // JSON object
  enabled:        number;            // 0/1
  status:         string;            // 'unknown' | 'connecting' | 'ready' | 'error'
  status_detail:  string | null;
  tools_cached:   string | null;     // JSON array of {name, description, inputSchema}
  tools_count:    number;
  last_probed_at: string | null;
  created_at:     string;
  updated_at:     string;
}

/** Sanitize the user-supplied name into a safe tool prefix: lowercase, [a-z0-9_]. */
export function sanitizeMcpServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'server';
}

export function parseMcpHeaders(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        if (val == null) continue;
        out[String(k)] = String(val);
      }
      return out;
    }
  } catch { /* fall through */ }
  return {};
}

export interface McpToolCacheEntry {
  name:        string;
  description: string;
  inputSchema: unknown;
}

export function parseMcpToolsCache(raw: string | null | undefined): McpToolCacheEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) {
      return v.filter(t => t && typeof t.name === 'string').map(t => ({
        name:        String(t.name),
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: t.inputSchema ?? {},
      }));
    }
  } catch { /* fall through */ }
  return [];
}

export function listMcpServers(includeDisabled = true): McpServerRow[] {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  return getDb()
    .prepare(`SELECT * FROM mcp_servers ${where} ORDER BY created_at ASC`)
    .all() as McpServerRow[];
}

export function getMcpServer(id: string): McpServerRow | null {
  return (getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined) ?? null;
}

export function getMcpServerByName(name: string): McpServerRow | null {
  const sanitized = sanitizeMcpServerName(name);
  return (getDb().prepare('SELECT * FROM mcp_servers WHERE name = ?').get(sanitized) as McpServerRow | undefined) ?? null;
}

export function createMcpServer(input: {
  name:       string;
  url:        string;
  transport?: 'auto' | 'http' | 'sse';
  headers?:   Record<string, string> | null;
  enabled?:   boolean;
}): McpServerRow {
  const id   = randomUUID();
  const name = sanitizeMcpServerName(input.name);
  const transport = input.transport === 'http' || input.transport === 'sse' ? input.transport : 'auto';
  const headers = input.headers && Object.keys(input.headers).length > 0
    ? JSON.stringify(input.headers)
    : null;
  getDb().prepare(`
    INSERT INTO mcp_servers (id, name, url, transport, headers, enabled, status)
    VALUES (?, ?, ?, ?, ?, ?, 'unknown')
  `).run(id, name, input.url.trim(), transport, headers, input.enabled === false ? 0 : 1);
  logAudit('mcp_server_created', 'mcp_server', id, { name, url: input.url, transport });
  return getMcpServer(id)!;
}

export function updateMcpServer(id: string, fields: Partial<{
  name:           string;
  url:            string;
  transport:      'auto' | 'http' | 'sse';
  headers:        Record<string, string> | null;
  enabled:        boolean;
  status:         string;
  status_detail:  string | null;
  tools_cached:   McpToolCacheEntry[];
  tools_count:    number;
  last_probed_at: string | null;
}>): void {
  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"];
  const args: unknown[] = [];
  if (fields.name           !== undefined) { sets.push('name = ?');           args.push(sanitizeMcpServerName(fields.name)); }
  if (fields.url            !== undefined) { sets.push('url = ?');            args.push(fields.url.trim()); }
  if (fields.transport      !== undefined) {
    const t = fields.transport === 'http' || fields.transport === 'sse' ? fields.transport : 'auto';
    sets.push('transport = ?'); args.push(t);
  }
  if (fields.headers        !== undefined) {
    sets.push('headers = ?');
    args.push(fields.headers && Object.keys(fields.headers).length > 0 ? JSON.stringify(fields.headers) : null);
  }
  if (fields.enabled        !== undefined) { sets.push('enabled = ?');        args.push(fields.enabled ? 1 : 0); }
  if (fields.status         !== undefined) { sets.push('status = ?');         args.push(fields.status); }
  if (fields.status_detail  !== undefined) { sets.push('status_detail = ?');  args.push(fields.status_detail); }
  if (fields.tools_cached   !== undefined) { sets.push('tools_cached = ?');   args.push(JSON.stringify(fields.tools_cached)); }
  if (fields.tools_count    !== undefined) { sets.push('tools_count = ?');    args.push(fields.tools_count); }
  if (fields.last_probed_at !== undefined) { sets.push('last_probed_at = ?'); args.push(fields.last_probed_at); }
  if (sets.length === 1) return;
  args.push(id);
  getDb().prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function deleteMcpServer(id: string): void {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  logAudit('mcp_server_deleted', 'mcp_server', id);
}

// ── Approvals (v2.2 remote approval queue) ──────────────────────────────────
// One row per tool-call approval request. The agent runtime creates a row
// (status='pending') and waits (polling getApproval) until the dashboard
// resolves it to 'approved' or 'denied'.

export interface ApprovalRecord {
  id:          string;
  agent_id:    string | null;
  agent_name:  string | null;
  session_id:  string | null;
  tool_name:   string;
  tool_input:  string;           // JSON string
  status:      'pending' | 'approved' | 'denied';
  reason:      string | null;
  created_at:  string;
  resolved_at: string | null;
}

export function createApproval(fields: {
  agent_id?:   string | null;
  agent_name?: string | null;
  session_id?: string | null;
  tool_name:   string;
  tool_input:  object;
}): ApprovalRecord {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO approvals (id, agent_id, agent_name, session_id, tool_name, tool_input)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fields.agent_id   ?? null,
    fields.agent_name ?? null,
    fields.session_id ?? null,
    fields.tool_name,
    JSON.stringify(fields.tool_input),
  );
  const record = getApproval(id)!;
  const event: DashboardNotificationEvent = {
    type: 'approval',
    id: record.id,
    source: record.agent_name ?? 'system',
    title: `Approval: ${record.tool_name}`,
    body: `Agent ${record.agent_name ?? 'system'} requests approval for \`${record.tool_name}\`.`,
    severity: 'warn',
    metadata: { toolInput: JSON.parse(record.tool_input) },
    url: `/dashboard#/approvals`,
  };
  notificationEvents.emit('new', event);
  return record;
}

export function getApproval(id: string): ApprovalRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM approvals WHERE id = ?')
    .get(id) as ApprovalRecord | undefined;
}

export function resolveApproval(
  id: string,
  status: 'approved' | 'denied',
  reason?: string,
): boolean {
  // Guard on status='pending' so a resolved decision can't be overwritten by a
  // double-click, a retried request, or a race between two dashboard clients —
  // critically, this prevents flipping an already-`denied` tool-call approval to
  // `approved` after the fact. Returns true only if THIS call resolved it.
  const info = getDb().prepare(`
    UPDATE approvals
       SET status = ?, reason = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ? AND status = 'pending'
  `).run(status, reason ?? null, id);
  return info.changes > 0;
}

export function listApprovals(status?: string, limit = 50): ApprovalRecord[] {
  const cap = Math.min(Math.max(limit, 1), 200);
  if (status) {
    return getDb()
      .prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, cap) as ApprovalRecord[];
  }
  return getDb()
    .prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?')
    .all(cap) as ApprovalRecord[];
}

// ── Spawn config (runtime overrides stored in config_items) ──────────────────

const SPAWN_CONFIG_KEYS = ['spawn_enabled','spawn_max_depth','spawn_ttl_hours','spawn_soft_limit','spawn_hard_limit','spawn_auto_approve','spawn_eval_threshold'] as const;
type SpawnConfigKey = typeof SPAWN_CONFIG_KEYS[number];

export interface SpawnConfig {
  enabled:       boolean;
  maxDepth:      number;
  ttlHours:      number;
  softLimit:     number;
  hardLimit:     number;
  autoApprove:   boolean;
  evalThreshold: number;
}

export function getSpawnConfig(): SpawnConfig {
  const db = getDb();
  const row = (key: SpawnConfigKey) =>
    (db.prepare('SELECT value FROM config_items WHERE key = ?').get(key) as { value: string } | undefined)?.value;

  const env = config.spawning;

  return {
    enabled:       row('spawn_enabled')       !== undefined ? row('spawn_enabled') === '1' : env.enabled,
    maxDepth:      row('spawn_max_depth')      !== undefined ? parseInt(row('spawn_max_depth')!, 10) : 3,
    ttlHours:      row('spawn_ttl_hours')      !== undefined ? parseFloat(row('spawn_ttl_hours')!) : env.ttlHours,
    softLimit:     row('spawn_soft_limit')     !== undefined ? parseInt(row('spawn_soft_limit')!, 10) : env.softLimit,
    hardLimit:     row('spawn_hard_limit')     !== undefined ? parseInt(row('spawn_hard_limit')!, 10) : env.hardLimit,
    autoApprove:   row('spawn_auto_approve')   !== undefined ? row('spawn_auto_approve') === '1' : env.autoApprove,
    evalThreshold: row('spawn_eval_threshold') !== undefined ? parseFloat(row('spawn_eval_threshold')!) : 0.7,
  };
}

export function setSpawnConfig(patch: Partial<SpawnConfig>): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO config_items (key, value, description) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  );
  const pairs: [SpawnConfigKey, string][] = [];
  if (patch.enabled       !== undefined) pairs.push(['spawn_enabled',        patch.enabled ? '1' : '0']);
  if (patch.maxDepth      !== undefined) pairs.push(['spawn_max_depth',      String(patch.maxDepth)]);
  if (patch.ttlHours      !== undefined) pairs.push(['spawn_ttl_hours',      String(patch.ttlHours)]);
  if (patch.softLimit     !== undefined) pairs.push(['spawn_soft_limit',     String(patch.softLimit)]);
  if (patch.hardLimit     !== undefined) pairs.push(['spawn_hard_limit',     String(patch.hardLimit)]);
  if (patch.autoApprove   !== undefined) pairs.push(['spawn_auto_approve',   patch.autoApprove ? '1' : '0']);
  if (patch.evalThreshold !== undefined) pairs.push(['spawn_eval_threshold', String(patch.evalThreshold)]);

  const tx = db.transaction(() => {
    for (const [k, v] of pairs) upsert.run(k, v, `spawn config: ${k}`);
  });
  tx();
}

// ── Cron jobs ──────────────────────────────────────────────────────────────

export interface CronJob {
  id: string; name: string; description: string | null; schedule: string | null;
  enabled: number; job_type: string; config: string; inbound_slug: string | null;
  on_complete_webhook_url: string | null; created_by: string;
  last_run_at: string | null; next_run_at: string | null;
  created_at: string; updated_at: string;
}

export interface CronRun {
  id: string; job_id: string; status: string; triggered_by: string;
  output: string | null; error_text: string | null; duration_ms: number | null;
  outbound_webhook_status: number | null; started_at: string; ended_at: string | null;
}

export function listCronJobs(type?: string, enabled?: boolean): CronJob[] {
  const db = getDb();
  let sql = 'SELECT * FROM cron_jobs WHERE 1=1';
  const params: (string | number)[] = [];
  if (type !== undefined)    { sql += ' AND job_type = ?'; params.push(type); }
  if (enabled !== undefined) { sql += ' AND enabled = ?';  params.push(enabled ? 1 : 0); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as CronJob[];
}

export function getCronJob(id: string): CronJob | undefined {
  return getDb().prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJob | undefined;
}

export function getCronJobBySlug(slug: string): CronJob | undefined {
  return getDb().prepare('SELECT * FROM cron_jobs WHERE inbound_slug = ?').get(slug) as CronJob | undefined;
}

export function createCronJob(fields: Omit<CronJob, 'id' | 'created_at' | 'updated_at'>): CronJob {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`INSERT INTO cron_jobs
    (id, name, description, schedule, enabled, job_type, config, inbound_slug,
     on_complete_webhook_url, created_by, last_run_at, next_run_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, fields.name, fields.description ?? null, fields.schedule ?? null,
    fields.enabled, fields.job_type, fields.config,
    fields.inbound_slug ?? null, fields.on_complete_webhook_url ?? null,
    fields.created_by, fields.last_run_at ?? null, fields.next_run_at ?? null,
  );
  return getCronJob(id)!;
}

export function updateCronJob(id: string, fields: Partial<Omit<CronJob, 'id' | 'created_at'>>): CronJob | undefined {
  const db = getDb();
  const ALLOWED_CRON_KEYS = new Set(['name','description','schedule','enabled','job_type','config','inbound_slug','on_complete_webhook_url','created_by','last_run_at','next_run_at','updated_at']);
  const keys = (Object.keys(fields) as Array<keyof typeof fields>).filter(k => ALLOWED_CRON_KEYS.has(k as string));
  if (keys.length === 0) return getCronJob(id);
  const sets = [...keys.map(k => `${k} = ?`), "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"].join(', ');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.prepare(`UPDATE cron_jobs SET ${sets} WHERE id = ?`).run(...keys.map(k => (fields as any)[k] ?? null), id);
  return getCronJob(id);
}

export function deleteCronJob(id: string): void {
  getDb().prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
}

export function listCronRuns(jobId: string, limit = 50): CronRun[] {
  return getDb().prepare(
    'SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?',
  ).all(jobId, limit) as CronRun[];
}

export function createCronRun(jobId: string, triggeredBy: string): CronRun {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO cron_runs (id, job_id, status, triggered_by) VALUES (?, ?, 'running', ?)`,
  ).run(id, jobId, triggeredBy);
  return db.prepare('SELECT * FROM cron_runs WHERE id = ?').get(id) as CronRun;
}

export function finishCronRun(
  id: string, status: 'success' | 'error',
  output: string | null, errorText: string | null,
  durationMs: number, outboundStatus?: number,
): void {
  getDb().prepare(
    `UPDATE cron_runs SET status = ?, output = ?, error_text = ?, duration_ms = ?,
     outbound_webhook_status = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  ).run(status, output, errorText, durationMs, outboundStatus ?? null, id);
}

export function updateCronJobTimestamps(id: string, lastRunAt: string, nextRunAt: string | null): void {
  getDb().prepare(
    "UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
  ).run(lastRunAt, nextRunAt, id);
}

// ── Analyst alerts (Stephanie) ────────────────────────────────────────────────

export interface AnalystAlert {
  id: string;
  type: 'overload' | 'idle' | 'role_drift' | 'recommend_spawn';
  agent_id: string | null;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  metadata: string | null;
  created_at: string;
  dismissed_at: string | null;
}

export function createAnalystAlert(
  fields: Omit<AnalystAlert, 'id' | 'created_at' | 'dismissed_at'>,
): AnalystAlert {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO analyst_alerts (id, type, agent_id, severity, message, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `  ).run(id, fields.type, fields.agent_id ?? null, fields.severity, fields.message, fields.metadata ?? null);
  const record = db.prepare('SELECT * FROM analyst_alerts WHERE id = ?').get(id) as AnalystAlert;
  const event: DashboardNotificationEvent = {
    type: 'analyst_alert',
    id: record.id,
    source: record.type,
    title: `${record.type.toUpperCase()} alert`,
    body: record.message,
    severity: record.severity,
    metadata: record.metadata ? JSON.parse(record.metadata) : undefined,
    url: `/dashboard#/comms`,
  };
  notificationEvents.emit('new', event);
  return record;
}

export function listAnalystAlerts(opts: { unreadOnly?: boolean; limit?: number } = {}): AnalystAlert[] {
  const db = getDb();
  const { unreadOnly = false, limit = 50 } = opts;
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const where = unreadOnly ? 'WHERE dismissed_at IS NULL' : '';
  return db.prepare(
    `SELECT * FROM analyst_alerts ${where} ORDER BY created_at DESC LIMIT ?`,
  ).all(safeLimit) as AnalystAlert[];
}

export function dismissAnalystAlert(id: string): 'ok' | 'already_dismissed' | 'not_found' {
  const db = getDb();
  const row = db.prepare('SELECT dismissed_at FROM analyst_alerts WHERE id = ?').get(id) as { dismissed_at: string | null } | undefined;
  if (!row) return 'not_found';
  if (row.dismissed_at) return 'already_dismissed';
  db.prepare(
    `UPDATE analyst_alerts SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  ).run(id);
  return 'ok';
}

export function getDiscordBotSkills(botId: string): string[] {
  return (getDb().prepare('SELECT skill_name FROM discord_bot_skills WHERE bot_id = ?').all(botId) as { skill_name: string }[]).map(r => r.skill_name);
}

export function addDiscordBotSkill(botId: string, skillName: string): void {
  getDb().prepare('INSERT OR IGNORE INTO discord_bot_skills (bot_id, skill_name) VALUES (?, ?)').run(botId, skillName);
}

export function removeDiscordBotSkill(botId: string, skillName: string): void {
  getDb().prepare('DELETE FROM discord_bot_skills WHERE bot_id = ? AND skill_name = ?').run(botId, skillName);
}

// ── Audio Cache ────────────────────────────────────────────────────────────

export interface AudioCacheRow {
  id:         string;
  cache_key:  string;
  provider:   string;
  voice_id:   string;
  model:      string;
  text_hash:  string;
  mime_type:  string;
  audio_blob: Buffer;
  hit_count:  number;
  created_at: string;
}

function hashText(text: string): string {
  // SHA-256 truncated to 16 hex chars — collision-resistant at any cache size.
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function buildAudioCacheKey(provider: string, voiceId: string, model: string, text: string): string {
  return `${provider}:${voiceId}:${model}:${hashText(text)}`;
}

export function getCachedAudio(key: string): AudioCacheRow | null {
  const row = getDb().prepare('SELECT * FROM audio_cache WHERE cache_key = ?').get(key) as AudioCacheRow | undefined;
  if (row) {
    getDb().prepare('UPDATE audio_cache SET hit_count = hit_count + 1 WHERE id = ?').run(row.id);
  }
  return row ?? null;
}

export function saveAudioCache(
  provider: string, voiceId: string, model: string, text: string,
  mimeType: string, audioBlob: Buffer,
): AudioCacheRow {
  const id = randomUUID();
  const key = buildAudioCacheKey(provider, voiceId, model, text);
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT OR IGNORE INTO audio_cache (id, cache_key, provider, voice_id, model, text_hash, mime_type, audio_blob, hit_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, key, provider, voiceId, model, hashText(text), mimeType, audioBlob, now);
  return getDb().prepare('SELECT * FROM audio_cache WHERE id = ?').get(id) as AudioCacheRow;
}

// minHits <= 0 → pure age-based sweep (delete every entry older than the TTL
// regardless of hit count). With the old `hit_count < minHits` clause, passing 0
// would have matched nothing (hit_count is never negative), so the guard is
// dropped entirely in that case.
export function pruneAudioCache(maxAgeDays = 30, minHits = 1): number {
  if (minHits <= 0) {
    return getDb().prepare(`
      DELETE FROM audio_cache
      WHERE created_at < datetime('now', ?)
    `).run(`-${maxAgeDays} day`).changes;
  }
  const result = getDb().prepare(`
    DELETE FROM audio_cache
    WHERE created_at < datetime('now', ?)
      AND hit_count < ?
  `).run(`-${maxAgeDays} day`, minHits);
  return result.changes;
}

// ── Job Queue ──────────────────────────────────────────────────────────────

export type JobType =
  | 'background_agent' | 'cron_run' | 'agent_task'
  | 'tts_synthesize' | 'memory_extract' | 'embedding_generate'
  | 'workflow_run' | 'dream_cycle' | 'maintenance';

export interface JobRow {
  id:           string;
  type:         JobType;
  payload:      string;
  status:       'pending' | 'claimed' | 'done' | 'failed';
  attempts:     number;
  max_attempts: number;
  priority:     number;
  run_after:    string | null;
  created_at:   string;
  claimed_at:   string | null;
  first_claimed_at: string | null;
  completed_at: string | null;
  result:       string | null;
  error:        string | null;
}

export interface BackgroundAgentPayload {
  taskId:          string;
  agentId:         string;
  agentName:       string;
  sessionId:       string;
  taskDescription: string;
  systemPrompt:    string;
  runId?:          string;
}

export interface CronRunPayload {
  jobId:       string;
  triggeredBy: string;
}

export interface AgentTaskPayload {
  taskId:          string;
  agentId:         string;
  agentName:       string;
  taskTitle:       string;
  taskDescription: string;
  /** L3 same-agent retry: force a brand-new work session instead of resuming the
   *  task's existing agent_task session. Prevents a late-waking zombie run and the
   *  retry (which share agent_id, so stillOwner() passes for both) from interleaving
   *  writes into one shared conversation. Worst case degrades to a duplicate row. */
  freshSession?:   boolean;
}

export interface TtsPayload {
  text:      string;
  provider:  import('./audio/tts').TtsProvider;
  voiceId?:  string | null;
  format?:   'mp3' | 'wav' | 'opus';
  agentId?:  string | null;
  sessionId?: string | null;
  replyTarget?: 'dashboard' | 'discord' | { discord: { channelId: string; messageId?: string } } | null;
  // Full Discord delivery context — required to post audio back after async synthesis.
  // Without this, the job worker has no channel to send the file attachment to.
  discordContext?: {
    botId?:    string;
    channelId: string;
    messageId: string;
    userId?:   string;
  } | null;
}

export interface MemoryExtractPayload {
  source:      'chat' | 'task' | 'agent_result';
  agent_id?:   string | null;
  agent_name?: string | null;
  session_id?: string | null;
  user_text?:  string;
  assistant_text: string;
  context_hint?: string;
}

export interface EmbeddingGeneratePayload {
  /** Memory path (existing behavior). Required when target is 'memory'/absent. */
  memoryIndexId?: string;
  text:           string;
  /** KB/memory path. When set, the vector is written to Supabase instead of SQLite. */
  target?:        'memory' | 'kb_pages' | 'kb_code_examples';
  /** Supabase row id: numeric for KB tables, text UUID for memory_index. */
  rowId?:         number | string;
}

export interface WorkflowRunPayload {
  workflowName: string;
  input:        string;
  runId?:       string;
}

export interface DreamCyclePayload {
  triggeredBy: 'schedule' | 'manual';
}

export interface MaintenancePayload {
  task: 'curator_sweep' | 'heartbeat_batch' | 'session_cleanup';
}

export type JobPayload =
  | BackgroundAgentPayload
  | CronRunPayload
  | AgentTaskPayload
  | TtsPayload
  | MemoryExtractPayload
  | EmbeddingGeneratePayload
  | WorkflowRunPayload
  | DreamCyclePayload
  | MaintenancePayload;

export function enqueueJob(
  type: JobType,
  payload: JobPayload,
  priority    = 5,
  maxAttempts = 3,
  runAfter?:   Date,
): JobRow {
  // agent_task retries are governed by the TASK budget (failure_count/max_retries
  // in _runAgentTask + the holdout reviewer), not the job's own attempts. Give the
  // job ample headroom so the job layer never caps a retry before failure_count
  // does (which would strand the task with no job). Terminal failures in
  // _runAgentTask return (not throw), so the job completes rather than re-pending.
  if (type === 'agent_task') maxAttempts = Math.max(maxAttempts, 25);

  // Idempotency for task-execution jobs: never create a SECOND open job for the
  // same task — two open agent_task/background_agent jobs would each run the
  // agent turn (and its tool side-effects) independently. enqueueJob is fully
  // synchronous up to the INSERT, so this check-then-insert is atomic within the
  // single-process worker (no await can interleave between the SELECT and INSERT).
  const dedupTaskId = (payload as { taskId?: string }).taskId;
  if (dedupTaskId && (type === 'agent_task' || type === 'background_agent')) {
    const existing = getDb().prepare(
      `SELECT * FROM job_queue
       WHERE type = ? AND status IN ('pending','claimed')
         AND json_extract(payload, '$.taskId') = ?
       LIMIT 1`,
    ).get(type, dedupTaskId) as JobRow | undefined;
    if (existing) {
      logger.warn('enqueueJob: dedup — open job already exists for task; returning existing', {
        taskId: dedupTaskId, type, existingJobId: existing.id,
      });
      return existing;
    }
  }

  const id  = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO job_queue (id, type, payload, status, attempts, max_attempts, priority, run_after, created_at)
    VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)
  `).run(id, type, JSON.stringify(payload), maxAttempts, priority, runAfter ? runAfter.toISOString() : null, now);
  const job = getDb().prepare('SELECT * FROM job_queue WHERE id = ?').get(id) as JobRow;

  // ── Inngest dual-write (Phase 1: fires alongside the SQLite insert) ───────────
  // When INNGEST_ENABLED=dual|true, also emit the matching event so real job types
  // round-trip to the Inngest stub functions. The SQLite row above is still the
  // authoritative work item (job-worker.ts processes it) — this is observe-only
  // until Phase 2 flips enqueueJob to Inngest-only. Fire-and-forget so enqueueJob
  // stays synchronous and its return value/timing is unchanged.
  if (config.inngest.dualWrite) {
    const eventName = JOB_TYPE_TO_EVENT[type];
    if (eventName) {
      // Dynamic import keeps the Inngest client off db.ts's module-init path.
      import('./system/inngest-client').then(({ inngest }) => {
        inngest.send({ name: eventName, data: { ...payload, _sqliteJobId: id } })
          .catch((err: unknown) => logger.warn('enqueueJob: inngest dual-write send failed', { type, error: String(err) }));
      }).catch((err: unknown) => logger.warn('enqueueJob: inngest client load failed', { type, error: String(err) }));
    } else {
      logger.warn('enqueueJob: no Inngest event mapping for job type', { type });
    }
  }

  return job;
}

export function claimNextJob(): JobRow | null {
  const db = getDb();
  let claimed: JobRow | null = null;
  db.transaction(() => {
    const next = db.prepare(`
      SELECT * FROM job_queue
      WHERE status = 'pending' AND attempts < max_attempts
        AND (run_after IS NULL OR run_after <= ?)
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get(new Date().toISOString()) as JobRow | undefined;
    if (!next) return;
    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE job_queue
      SET status = 'claimed', claimed_at = ?, attempts = attempts + 1,
          first_claimed_at = COALESCE(first_claimed_at, ?)
      WHERE id = ?
    `).run(nowIso, nowIso, next.id);
    claimed = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(next.id) as JobRow;
  }).immediate();
  return claimed;
}

/**
 * Atomically claim the next actionable 'todo' task for an agent and flip it to
 * 'doing' (assigned to that agent, heartbeat stamped so it is immediately
 * "live" to Sentinel). Mirrors claimNextJob's IMMEDIATE-transaction pattern so
 * two agents never claim the same row. Eligible = status 'todo', not archived,
 * task_source = 'dashboard', and either unassigned or already
 * assigned to this agent. Optional project_id / feature filters.
 * Returns the claimed task row, or null if the board has nothing for this agent.
 */
export function claimNextTaskForAgent(
  agentId: string,
  opts?: { projectId?: string; feature?: string; sessionId?: string },
): Record<string, unknown> | null {
  const db = getDb();
  let claimed: Record<string, unknown> | null = null;
  db.transaction(() => {
    const filters: string[] = [
      "status = 'todo'",
      'archived = 0',
      "task_source = 'dashboard'",
      '(agent_id IS NULL OR agent_id = @agentId)',
      // Wave-2 Item D: never claim a task with an unmet blocker. A blocker is
      // "unmet" unless it is 'done' (a cancelled blocker still blocks — releasing
      // downstream work requires an explicit dependency-edge cleanup).
      `NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks bt ON bt.id = d.depends_on_id
        WHERE d.task_id = tasks.id AND bt.status NOT IN ('done')
      )`,
    ];
    if (opts?.projectId) filters.push('project_id = @projectId');
    if (opts?.feature)   filters.push('feature = @feature');
    const params: Record<string, unknown> = { agentId };
    if (opts?.projectId) params.projectId = opts.projectId;
    if (opts?.feature)   params.feature   = opts.feature;
    const next = db.prepare(
      `SELECT id FROM tasks WHERE ${filters.join(' AND ')}
       ORDER BY task_order ASC, priority DESC, created_at ASC LIMIT 1`,
    ).get(params) as { id: string } | undefined;
    if (!next) return;
    // Conditional update guards against a race: only claim if still 'todo'.
    // Bind the claiming chat session so that if the process dies mid-turn, the
    // recovered re-run resumes the SAME session (sees prior work) instead of
    // re-executing the task from scratch in a blank session.
    const res = db.prepare(
      `UPDATE tasks
       SET status = 'doing', agent_id = ?, session_id = COALESCE(?, session_id), last_heartbeat_at = ?,
           doing_since = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ? AND status = 'todo'`,
    ).run(agentId, opts?.sessionId ?? null, Date.now(), Date.now(), next.id);
    if (res.changes === 0) return; // someone else claimed it first
    claimed = db.prepare('SELECT * FROM tasks WHERE id = ?').get(next.id) as Record<string, unknown>;
  }).immediate();
  return claimed;
}

// ── Task dependency edges (Wave-2 Item D) ───────────────────────────────────

/** Count of a task's blockers that are not yet 'done'. 0 = clear to run.
 *  Drives both the claim/transition gate and the "⛔ blocked by N" badge. */
export function unmetBlockerCount(taskId: string): number {
  return (getDb().prepare(
    `SELECT COUNT(*) AS n FROM task_dependencies d
     JOIN tasks bt ON bt.id = d.depends_on_id
     WHERE d.task_id = ? AND bt.status NOT IN ('done')`,
  ).get(taskId) as { n: number }).n;
}

/** Blocker task ids this task depends on. */
export function getTaskDependencies(taskId: string): string[] {
  return (getDb().prepare(
    'SELECT depends_on_id FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC',
  ).all(taskId) as { depends_on_id: string }[]).map(r => r.depends_on_id);
}

/** Dependent task ids that this task blocks (reverse edge). */
export function getTaskDependents(dependsOnId: string): string[] {
  return (getDb().prepare(
    'SELECT task_id FROM task_dependencies WHERE depends_on_id = ? ORDER BY created_at ASC',
  ).all(dependsOnId) as { task_id: string }[]).map(r => r.task_id);
}

/** Would adding edge (taskId depends_on dependsOnId) create a cycle? DFS from
 *  dependsOnId over existing edges; if it reaches taskId, the edge closes a loop. */
function edgeWouldCycle(db: Database.Database, taskId: string, dependsOnId: string): boolean {
  const stack = [dependsOnId];
  const seen = new Set<string>();
  const stmt = db.prepare('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?');
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of stmt.all(cur) as { depends_on_id: string }[]) stack.push(r.depends_on_id);
  }
  return false;
}

/** Add a blocker edge: taskId is blocked until dependsOnId is 'done'. Rejects
 *  self-edges, cycles, and unknown/archived tasks. Wrapped in an IMMEDIATE
 *  transaction so two concurrent adds can't jointly form a cycle. */
export function addTaskDependency(taskId: string, dependsOnId: string): { ok: boolean; error?: string } {
  if (taskId === dependsOnId) return { ok: false, error: 'a task cannot depend on itself' };
  const db = getDb();
  let result: { ok: boolean; error?: string } = { ok: true };
  db.transaction(() => {
    const t = db.prepare('SELECT id FROM tasks WHERE id = ? AND archived = 0').get(taskId);
    const b = db.prepare('SELECT id FROM tasks WHERE id = ? AND archived = 0').get(dependsOnId);
    if (!t) { result = { ok: false, error: `task "${taskId}" not found` }; return; }
    if (!b) { result = { ok: false, error: `blocker "${dependsOnId}" not found` }; return; }
    if (edgeWouldCycle(db, taskId, dependsOnId)) {
      result = { ok: false, error: 'dependency would create a cycle' }; return;
    }
    db.prepare(
      'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)',
    ).run(taskId, dependsOnId);
  }).immediate();
  return result;
}

/** Remove a single blocker edge. */
export function removeTaskDependency(taskId: string, dependsOnId: string): void {
  getDb().prepare(
    'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?',
  ).run(taskId, dependsOnId);
}

/** Drop ALL blocker edges for a task (the intentional "release downstream after
 *  cancelling an upstream blocker" path — see D2 cancelled-blocker note). */
export function clearTaskDependencies(taskId: string): void {
  getDb().prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
}

export function completeJob(id: string, result: string): void {
  getDb().prepare(`
    UPDATE job_queue SET status = 'done', completed_at = ?, result = ?
    WHERE id = ?
  `).run(new Date().toISOString(), result, id);
}

export function failJob(id: string, error: string): void {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(id) as JobRow | undefined;
  if (!job) return;
  const exhausted = job.attempts >= job.max_attempts;
  db.prepare(`
    UPDATE job_queue SET status = ?, error = ?, completed_at = ?, claimed_at = ?
    WHERE id = ?
  `).run(
    exhausted ? 'failed' : 'pending',
    error,
    exhausted ? new Date().toISOString() : null,
    exhausted ? job.claimed_at : null,
    id,
  );
}

export function recoverStaleClaims(staleAfterMs = 60_000): number {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const result = getDb().prepare(`
    UPDATE job_queue SET status = 'pending', claimed_at = NULL
    WHERE status = 'claimed' AND claimed_at < ?
  `).run(cutoff);
  return result.changes;
}

// Heartbeat a job's claim so a still-RUNNING job (e.g. TTS behind a busy synth
// semaphore, or a multi-minute agent turn) is never treated as a stale claim and
// re-claimed mid-execution — which would re-run its side effects (duplicate TTS
// posts, repeated agent work). The worker calls this periodically while a job runs.
export function touchJobClaim(id: string): void {
  getDb().prepare(
    `UPDATE job_queue SET claimed_at = ? WHERE id = ? AND status = 'claimed'`,
  ).run(new Date().toISOString(), id);
}

/**
 * Stamp a task's liveness heartbeat (epoch-ms). Called periodically by the job
 * worker while a task is actively running so monitors can tell a busy task from
 * a dead one. Only touches 'doing' rows — a completed/failed task should not be
 * resurrected as "live".
 */
export function touchTaskHeartbeat(taskId: string): void {
  getDb().prepare(
    `UPDATE tasks SET last_heartbeat_at = ? WHERE id = ? AND status = 'doing'`,
  ).run(Date.now(), taskId);
}

// ── TTS delivery ledger (idempotent Discord delivery) ──────────────────────
// A re-run of the same TTS job (stale-claim recovery, or recovery after a
// restart that the heartbeat can't prevent) must NOT post the same voice note
// again. Keyed by channel+message+text so identical audio is delivered once.
let _ttsDeliveriesReady = false;
function ensureTtsDeliveriesTable(): void {
  if (_ttsDeliveriesReady) return;
  getDb().prepare(`
    CREATE TABLE IF NOT EXISTS tts_deliveries (
      delivery_key TEXT PRIMARY KEY,
      created_at   TEXT NOT NULL
    )
  `).run();
  _ttsDeliveriesReady = true;
}

export function wasTtsDelivered(deliveryKey: string): boolean {
  ensureTtsDeliveriesTable();
  return !!getDb().prepare('SELECT 1 FROM tts_deliveries WHERE delivery_key = ?').get(deliveryKey);
}

export function markTtsDelivered(deliveryKey: string): void {
  ensureTtsDeliveriesTable();
  getDb().prepare('INSERT OR IGNORE INTO tts_deliveries (delivery_key, created_at) VALUES (?, ?)')
    .run(deliveryKey, new Date().toISOString());
}

// ── Hand-off delivery ledger (idempotent recovered-result delivery) ─────────
// A single recovery sweep can encounter a nested hand-off chain (A→B→C) more
// than once: recovering C cascades through B and A, and then the sweep later
// iterates B directly. This ledger guarantees a recovered result is delivered
// into a target session exactly once, mirroring the tts_deliveries pattern.
let _handoffDeliveriesReady = false;
function ensureHandoffDeliveriesTable(): void {
  if (_handoffDeliveriesReady) return;
  getDb().prepare(`
    CREATE TABLE IF NOT EXISTS handoff_deliveries (
      handoff_id        TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (handoff_id, target_session_id)
    )
  `).run();
  _handoffDeliveriesReady = true;
}

export function wasHandoffDelivered(handoffId: string, targetSessionId: string): boolean {
  ensureHandoffDeliveriesTable();
  return !!getDb()
    .prepare('SELECT 1 FROM handoff_deliveries WHERE handoff_id = ? AND target_session_id = ?')
    .get(handoffId, targetSessionId);
}

export function markHandoffDelivered(handoffId: string, targetSessionId: string): boolean {
  ensureHandoffDeliveriesTable();
  const result = getDb()
    .prepare('INSERT OR IGNORE INTO handoff_deliveries (handoff_id, target_session_id, created_at) VALUES (?, ?, ?)')
    .run(handoffId, targetSessionId, new Date().toISOString());
  return result.changes > 0;
}

/**
 * On startup, find any tasks that are 'todo' with an agent assigned but have
 * no pending/claimed job_queue row. Enqueue an agent_task job for each so
 * they are not silently dropped after a restart.
 */
export function recoverOrphanAgentTasks(): number {
  const db = getDb();
  const orphans = db.prepare(`
    SELECT t.id, t.title, t.description, t.agent_id, a.name AS agent_name
    FROM tasks t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.status = 'todo'
      AND t.agent_id IS NOT NULL
      AND t.archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM job_queue jq
        WHERE jq.status IN ('pending', 'claimed')
          AND json_extract(jq.payload, '$.taskId') = t.id
      )
  `).all() as { id: string; title: string; description: string | null; agent_id: string; agent_name: string }[];

  for (const orphan of orphans) {
    enqueueJob('agent_task', {
      taskId:          orphan.id,
      agentId:         orphan.agent_id,
      agentName:       orphan.agent_name,
      taskTitle:       orphan.title,
      taskDescription: orphan.description ?? '',
    });
  }
  return orphans.length;
}

/**
 * On startup, find tasks stuck in 'doing' with no active job (e.g., server
 * crashed after chatStream completed but before completeJob was written).
 * Resets them to 'todo' so recoverOrphanAgentTasks() or the worker can retry.
 */
/**
 * Atomically increment a task's failure_count and return the new value. This is
 * the SINGLE owner of failure_count mutation — every retry/recovery path routes
 * through here so the +1 is a single SQL statement (no read-modify-write race
 * across the holdout reviewer, job-worker, and watchdog).
 */
export function bumpFailureCount(id: string): number {
  const row = getDb().prepare(
    `UPDATE tasks
     SET failure_count = failure_count + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
     RETURNING failure_count`,
  ).get(id) as { failure_count: number } | undefined;
  return row?.failure_count ?? 0;
}

export function recoverStuckDoingTasks(): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE tasks
    SET status = 'todo', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE status = 'doing'
      AND agent_id IS NOT NULL
      AND archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM job_queue jq
        WHERE jq.status IN ('pending', 'claimed')
          AND json_extract(jq.payload, '$.taskId') = tasks.id
      )
  `).run();
  return result.changes;
}

// ── Downtime events ──────────────────────────────────────────────────────

export interface DowntimeEvent {
  id: string;
  type: 'heartbeat_gap' | 'error_spike' | 'discord_offline' | 'provider_failure';
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  severity: 'warning' | 'critical';
  summary: string | null;
  metadata: string | null;
  created_at: string;
}

export function insertDowntimeEvent(
  event: Omit<DowntimeEvent, 'created_at'>
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO downtime_events
      (id, type, started_at, ended_at, duration_minutes, severity, summary, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.type, event.started_at, event.ended_at ?? null,
    event.duration_minutes ?? null, event.severity,
    event.summary ?? null, event.metadata ? JSON.stringify(event.metadata) : null,
  );
}

export function closeDowntimeEvent(id: string, endedAt: string, durationMinutes: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE downtime_events SET ended_at = ?, duration_minutes = ? WHERE id = ?
  `).run(endedAt, durationMinutes, id);
}

export function getOpenDowntimeEvent(type: DowntimeEvent['type']): DowntimeEvent | null {
  const db = getDb();
  return (db.prepare(`
    SELECT * FROM downtime_events WHERE type = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1
  `).get(type) as DowntimeEvent | undefined) ?? null;
}

// ── Debug logs ────────────────────────────────────────────────────────────

export interface DebugLogRow {
  id:         string;
  session_id: string | null;
  agent_id:   string | null;
  source:     string;
  message:    string;
  data:       string | null;
  created_at: string;
}

export function insertDebugLog(row: Omit<DebugLogRow, 'created_at'> & { id?: string }): void {
  try {
    getDb().prepare(`
      INSERT INTO debug_logs (id, session_id, agent_id, source, message, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      row.id || randomUUID(),
      row.session_id ?? null,
      row.agent_id   ?? null,
      row.source,
      row.message.slice(0, 2000),
      row.data ?? null,
    );
  } catch { /* never crash callers */ }
}

export function getDebugLogs(opts: {
  limit?:      number;
  source?:     string;
  session_id?: string;
  agent_id?:   string;
}): DebugLogRow[] {
  try {
    const { limit = 500, source, session_id, agent_id } = opts;
    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (source) {
      conditions.push("source LIKE ?");
      params.push(`%${source}%`);
    }
    if (session_id) {
      conditions.push("session_id = ?");
      params.push(session_id);
    }
    if (agent_id) {
      conditions.push("agent_id = ?");
      params.push(agent_id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(limit, 1000));

    return getDb().prepare(`
      SELECT * FROM debug_logs ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...params) as DebugLogRow[];
  } catch {
    return [];
  }
}

// ── Workflow runs ──────────────────────────────────────────────────────────

export interface WorkflowRunRow {
  id: string;
  workflow_name: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  worktree_path: string | null;
  branch_name: string | null;
  input: string;
  error: string | null;
  outputs: string;          // JSON: Record<string, { output: string; result?: unknown }>
  completed_nodes: string;  // JSON: string[]
  paused_at_node: string | null;
  created_at: number;
}

export function createWorkflowRun(workflowName: string, input: string): WorkflowRunRow {
  const id = randomUUID();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO nclaw_workflow_runs (id, workflow_name, input, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, workflowName, input, now);
  return getWorkflowRun(id)!;
}

export function getWorkflowRun(id: string): WorkflowRunRow | null {
  return (getDb().prepare('SELECT * FROM nclaw_workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined) ?? null;
}

export function listWorkflowRuns(limit = 20): WorkflowRunRow[] {
  return getDb().prepare('SELECT * FROM nclaw_workflow_runs ORDER BY created_at DESC LIMIT ?').all(limit) as WorkflowRunRow[];
}

export function updateWorkflowRun(id: string, fields: Partial<{
  status: string;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
  outputs: string;
  completed_nodes: string;
  paused_at_node: string | null;
}>): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    args.push(value);
  }
  if (sets.length === 0) return;
  args.push(id);
  getDb().prepare(`UPDATE nclaw_workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function addWorkflowEvent(runId: string, nodeId: string | null, type: string, data: Record<string, unknown>): void {
  getDb().prepare(`
    INSERT INTO nclaw_workflow_events (run_id, node_id, type, data, ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, nodeId, type, JSON.stringify(data), Date.now());
}

export function getWorkflowEvents(runId: string): Array<{ id: number; node_id: string | null; type: string; data: string; ts: number }> {
  return getDb().prepare('SELECT * FROM nclaw_workflow_events WHERE run_id = ? ORDER BY id ASC').all(runId) as Array<{ id: number; node_id: string | null; type: string; data: string; ts: number }>;
}

// ── Import Sessions ───────────────────────────────────────────────────────────

export interface ImportSession {
  id:          string;
  source:      string;
  filename:    string;
  status:      'running' | 'done' | 'failed' | 'cancelled';
  total:       number;
  processed:   number;
  created:     number;
  skipped:     number;
  error:       string | null;
  started_at:  string;
  finished_at: string | null;
}

export function createImportSession(
  id: string, source: string, filename: string, total: number,
): ImportSession {
  getDb().prepare(`
    INSERT INTO import_sessions (id, source, filename, total)
    VALUES (?, ?, ?, ?)
  `).run(id, source, filename, total);
  return getImportSession(id)!;
}

export function getImportSession(id: string): ImportSession | null {
  return getDb()
    .prepare('SELECT * FROM import_sessions WHERE id = ?')
    .get(id) as ImportSession | null;
}

export function listImportSessions(limit = 10): ImportSession[] {
  return getDb()
    .prepare('SELECT * FROM import_sessions ORDER BY started_at DESC LIMIT ?')
    .all(limit) as ImportSession[];
}

export function updateImportProgress(
  id: string, processed: number, created: number, skipped: number,
): void {
  getDb().prepare(`
    UPDATE import_sessions SET processed = ?, created = ?, skipped = ? WHERE id = ?
  `).run(processed, created, skipped, id);
}

export function finishImportSession(
  id: string,
  status: 'done' | 'failed' | 'cancelled',
  error?: string,
): void {
  getDb().prepare(`
    UPDATE import_sessions
    SET status = ?, error = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(status, error ?? null, id);
}

// ── CLI Tools ─────────────────────────────────────────────────────────────────

export interface CliToolRecord {
  id:              string;
  name:            string;
  slug:            string;
  description:     string | null;
  status:          string;
  install_command: string | null;
  features:        string;
  tool_order:      number;
  created_at:      string;
  updated_at:      string;
}

export function getCliTools(status?: string): CliToolRecord[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM cli_tools WHERE status = ? ORDER BY tool_order DESC').all(status) as CliToolRecord[];
  }
  return db.prepare("SELECT * FROM cli_tools WHERE status != 'archived' ORDER BY tool_order DESC").all() as CliToolRecord[];
}

export function getCliTool(id: string): CliToolRecord | undefined {
  return getDb().prepare('SELECT * FROM cli_tools WHERE id = ?').get(id) as CliToolRecord | undefined;
}

export function createCliTool(data: {
  name: string;
  slug: string;
  description?: string;
  status?: string;
  install_command?: string;
  features?: string[];
  tool_order?: number;
}): CliToolRecord {
  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO cli_tools (id, name, slug, description, status, install_command, features, tool_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.slug,
    data.description ?? null,
    data.status ?? 'planned',
    data.install_command ?? null,
    JSON.stringify(data.features ?? []),
    data.tool_order ?? 0,
  );
  return db.prepare('SELECT * FROM cli_tools WHERE id = ?').get(id) as CliToolRecord;
}

export function updateCliTool(
  id: string,
  fields: {
    name?: string;
    slug?: string;
    description?: string | null;
    status?: string;
    install_command?: string | null;
    features?: string[];
    tool_order?: number;
  },
): void {
  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"];
  const params: unknown[] = [];

  if (fields.name !== undefined)            { sets.push('name = ?');            params.push(fields.name); }
  if (fields.slug !== undefined)            { sets.push('slug = ?');            params.push(fields.slug); }
  if (fields.description !== undefined)     { sets.push('description = ?');     params.push(fields.description); }
  if (fields.status !== undefined)          { sets.push('status = ?');          params.push(fields.status); }
  if (fields.install_command !== undefined) { sets.push('install_command = ?'); params.push(fields.install_command); }
  if (fields.features !== undefined)        { sets.push('features = ?');        params.push(JSON.stringify(fields.features)); }
  if (fields.tool_order !== undefined)      { sets.push('tool_order = ?');      params.push(fields.tool_order); }

  if (sets.length === 0) return;
  params.push(id);
  getDb().prepare(`UPDATE cli_tools SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ── Durable chat attachments ────────────────────────────────────────────────
// Backing store for the in-memory attachment-registry. See chat_attachments
// table in initSchema(). The registry stays the hot path; these helpers make
// uploads + their parse survive a restart so Discord follow-up turns (and the
// dashboard) don't lose a document mid-conversation.

export interface ChatAttachmentRow {
  id:              string;
  session_id:      string;
  content_hash:    string;
  name:            string;
  mime:            string;
  size:            number;
  bytes:           Buffer | null;
  disk_path:       string | null;
  parsed_title:    string | null;
  parsed_markdown: string | null;
  parsed_stats:    string | null;
  parsed_at:       number | null;
  parse_error:     string | null;
  // spec: uploaded-document-handling-overhaul — raw/parsed lifecycle decouple.
  storage_bucket:  string | null;
  storage_path:    string | null;
  raw_expires_at:  number | null;
  parse_status:    string | null;   // pending | done | failed
  parse_attempts:  number;
  created_at:      number;
}

export function upsertChatAttachment(rec: {
  id: string; sessionId: string; contentHash: string; name: string; mime: string;
  size: number; bytes: Buffer; diskPath?: string | null; createdAt: number;
}): void {
  getDb().prepare(
    `INSERT INTO chat_attachments (id, session_id, content_hash, name, mime, size, bytes, disk_path, created_at)
     VALUES (@id, @sessionId, @contentHash, @name, @mime, @size, @bytes, @diskPath, @createdAt)
     ON CONFLICT(session_id, content_hash) DO UPDATE SET created_at = excluded.created_at`
  ).run({
    id: rec.id, sessionId: rec.sessionId, contentHash: rec.contentHash, name: rec.name,
    mime: rec.mime, size: rec.size, bytes: rec.bytes, diskPath: rec.diskPath ?? null, createdAt: rec.createdAt,
  });
}

export function getChatAttachmentById(id: string): ChatAttachmentRow | undefined {
  return getDb().prepare('SELECT * FROM chat_attachments WHERE id = ?').get(id) as ChatAttachmentRow | undefined;
}

export function getChatAttachmentBySessionHash(sessionId: string, contentHash: string): ChatAttachmentRow | undefined {
  return getDb()
    .prepare('SELECT * FROM chat_attachments WHERE session_id = ? AND content_hash = ?')
    .get(sessionId, contentHash) as ChatAttachmentRow | undefined;
}

export function listChatAttachmentsBySession(sessionId: string, sinceMs: number): ChatAttachmentRow[] {
  return getDb()
    .prepare('SELECT * FROM chat_attachments WHERE session_id = ? AND created_at >= ? ORDER BY created_at ASC')
    .all(sessionId, sinceMs) as ChatAttachmentRow[];
}

export function updateChatAttachmentParse(id: string, fields: {
  parsedTitle?: string; parsedMarkdown?: string; parsedStats?: string; parsedAt?: number; parseError?: string | null;
}): void {
  getDb().prepare(
    `UPDATE chat_attachments
        SET parsed_title = COALESCE(@parsedTitle, parsed_title),
            parsed_markdown = COALESCE(@parsedMarkdown, parsed_markdown),
            parsed_stats = COALESCE(@parsedStats, parsed_stats),
            parsed_at = COALESCE(@parsedAt, parsed_at),
            parse_error = @parseError
      WHERE id = @id`
  ).run({
    id,
    parsedTitle:    fields.parsedTitle    ?? null,
    parsedMarkdown: fields.parsedMarkdown ?? null,
    parsedStats:    fields.parsedStats    ?? null,
    parsedAt:       fields.parsedAt       ?? null,
    parseError:     fields.parseError     ?? null,
  });
}

export function refreshChatAttachmentCreatedAt(id: string, ts: number): void {
  getDb().prepare('UPDATE chat_attachments SET created_at = ? WHERE id = ?').run(ts, id);
}

// ── uploaded-document-handling-overhaul: raw/parsed lifecycle decouple ──────────

/** Record the Supabase bucket location + raw-file TTL for an attachment. */
export function updateChatAttachmentStorage(id: string, fields: {
  storageBucket?: string; storagePath?: string; rawExpiresAt?: number;
  parseStatus?: string; parseAttempts?: number;
}): void {
  getDb().prepare(
    `UPDATE chat_attachments
        SET storage_bucket = COALESCE(@storageBucket, storage_bucket),
            storage_path   = COALESCE(@storagePath,   storage_path),
            raw_expires_at = COALESCE(@rawExpiresAt,   raw_expires_at),
            parse_status   = COALESCE(@parseStatus,    parse_status),
            parse_attempts = COALESCE(@parseAttempts,  parse_attempts)
      WHERE id = @id`
  ).run({
    id,
    storageBucket: fields.storageBucket ?? null,
    storagePath:   fields.storagePath   ?? null,
    rawExpiresAt:  fields.rawExpiresAt   ?? null,
    parseStatus:   fields.parseStatus    ?? null,
    parseAttempts: fields.parseAttempts  ?? null,
  });
}

/** Touch a raw file's TTL — bump raw_expires_at forward on reference so active
 *  documents don't get swept while a conversation is still using them. */
export function touchChatAttachmentRawTtl(id: string, expiresAt: number): void {
  getDb().prepare('UPDATE chat_attachments SET raw_expires_at = ? WHERE id = ?').run(expiresAt, id);
}

/** Rows whose RAW file has expired but whose PARSED content is retained. The
 *  caller deletes the bucket object + clears raw-only columns; parsed_markdown
 *  and doc_chunks are left intact (the core no-data-loss guarantee). */
export function listExpiredRawAttachments(nowMs: number, limit = 200): Array<{ id: string; storage_bucket: string | null; storage_path: string | null }> {
  return getDb().prepare(
    `SELECT id, storage_bucket, storage_path
       FROM chat_attachments
      WHERE raw_expires_at IS NOT NULL AND raw_expires_at < ?
        AND (storage_path IS NOT NULL OR bytes IS NOT NULL)
      ORDER BY raw_expires_at ASC
      LIMIT ?`
  ).all(nowMs, limit) as Array<{ id: string; storage_bucket: string | null; storage_path: string | null }>;
}

/** Clear ONLY the raw-file columns (bucket object bytes) after the object is
 *  deleted from storage. Parsed markdown + parse metadata are preserved. */
export function clearChatAttachmentRaw(id: string): void {
  getDb().prepare(
    `UPDATE chat_attachments
        SET bytes = NULL, storage_path = NULL, raw_expires_at = NULL
      WHERE id = ?`
  ).run(id);
}

export function pruneChatAttachments(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  const r = getDb().prepare('DELETE FROM chat_attachments WHERE created_at < ?').run(cutoff);
  return r.changes ?? 0;
}

export function deleteChatAttachmentsBySession(sessionId: string): number {
  const r = getDb().prepare('DELETE FROM chat_attachments WHERE session_id = ?').run(sessionId);
  return r.changes ?? 0;
}

// ── session_uploads: universal inbound-upload manifest (see session-uploads.ts) ──

export interface SessionUploadRow {
  id:           string;
  session_id:   string;
  agent_id:     string | null;
  source:       string;
  name:         string;
  mime:         string | null;
  size:         number;
  kind:         string;
  rel_path:     string | null;
  content_hash: string | null;
  processed:    string | null;   // JSON
  created_at:   number;
}

export function insertSessionUpload(rec: {
  id: string; sessionId: string; agentId: string | null; source: string;
  name: string; mime: string | null; size: number; kind: string;
  relPath: string | null; contentHash: string | null; processed: string | null; createdAt: number;
}): void {
  getDb().prepare(
    `INSERT INTO session_uploads
       (id, session_id, agent_id, source, name, mime, size, kind, rel_path, content_hash, processed, created_at)
     VALUES
       (@id, @sessionId, @agentId, @source, @name, @mime, @size, @kind, @relPath, @contentHash, @processed, @createdAt)`
  ).run(rec);
}

export function getSessionUploads(sessionId: string): SessionUploadRow[] {
  return getDb()
    .prepare('SELECT * FROM session_uploads WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as SessionUploadRow[];
}

export function getSessionUpload(sessionId: string, id: string): SessionUploadRow | undefined {
  return getDb()
    .prepare('SELECT * FROM session_uploads WHERE session_id = ? AND id = ?')
    .get(sessionId, id) as SessionUploadRow | undefined;
}

export function getSessionUploadByHash(sessionId: string, hash: string): SessionUploadRow | undefined {
  return getDb()
    .prepare('SELECT * FROM session_uploads WHERE session_id = ? AND content_hash = ?')
    .get(sessionId, hash) as SessionUploadRow | undefined;
}

export function updateSessionUploadProcessed(id: string, processedJson: string): void {
  getDb().prepare('UPDATE session_uploads SET processed = ? WHERE id = ?').run(processedJson, id);
}

export function sumSessionUploadBytes(sessionId: string): number {
  const r = getDb()
    .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM session_uploads WHERE session_id = ? AND rel_path IS NOT NULL')
    .get(sessionId) as { total: number };
  return r.total ?? 0;
}

export function deleteSessionUploadsBySession(sessionId: string): number {
  const r = getDb().prepare('DELETE FROM session_uploads WHERE session_id = ?').run(sessionId);
  return r.changes ?? 0;
}

// ── Agent image archive (metadata index; bytes live in Supabase bucket) ───────

export interface AgentImageRecord {
  id:           string;
  bucket:       string;
  storage_path: string;
  prompt:       string;
  alt:          string;
  caption:      string | null;
  source_tool:  string;
  agent_id:     string | null;
  agent_name:   string;
  session_id:   string | null;
  run_id:       string | null;
  mime:         string;
  bytes:        number;
  created_at:   number;
  model:        string | null;
}

export function recordAgentImage(rec: Omit<AgentImageRecord, 'created_at' | 'model'> & { created_at?: number; model?: string | null }): void {
  getDb().prepare(`
    INSERT INTO agent_images
      (id, bucket, storage_path, prompt, alt, caption, source_tool,
       agent_id, agent_name, session_id, run_id, mime, bytes, created_at, model)
    VALUES
      (@id, @bucket, @storage_path, @prompt, @alt, @caption, @source_tool,
       @agent_id, @agent_name, @session_id, @run_id, @mime, @bytes, @created_at, @model)
  `).run({
    ...rec,
    caption:    rec.caption ?? null,
    agent_id:   rec.agent_id ?? null,
    session_id: rec.session_id ?? null,
    run_id:     rec.run_id ?? null,
    created_at: rec.created_at ?? Date.now(),
    model:      rec.model ?? null,
  });
}

export function listAgentImages(opts?: {
  limit?: number; offset?: number; agentId?: string; sessionId?: string;
}): AgentImageRecord[] {
  const limit  = Math.min(Math.max(opts?.limit ?? 60, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const where: string[] = [];
  const params: Record<string, unknown> = { limit, offset };
  if (opts?.agentId)   { where.push('agent_id = @agentId');     params.agentId = opts.agentId; }
  if (opts?.sessionId) { where.push('session_id = @sessionId'); params.sessionId = opts.sessionId; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb().prepare(`
    SELECT * FROM agent_images
    ${clause}
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params) as AgentImageRecord[];
}

export function countAgentImages(opts?: { agentId?: string; sessionId?: string }): number {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts?.agentId)   { where.push('agent_id = @agentId');     params.agentId = opts.agentId; }
  if (opts?.sessionId) { where.push('session_id = @sessionId'); params.sessionId = opts.sessionId; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM agent_images ${clause}`).get(params) as { n: number };
  return row?.n ?? 0;
}

export function getAgentImage(id: string): AgentImageRecord | null {
  const row = getDb().prepare(`SELECT * FROM agent_images WHERE id = ?`).get(id) as AgentImageRecord | undefined;
  return row ?? null;
}
