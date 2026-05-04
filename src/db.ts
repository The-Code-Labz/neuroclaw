import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { config } from './config';
import { logger } from './utils/logger';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    runMigrations(db);
    seedDefaultData(db);
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
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      title         TEXT,
      status        TEXT DEFAULT 'active',
      agent_id      TEXT REFERENCES agents(id),
      message_count INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content     TEXT NOT NULL,
      agent_id    TEXT REFERENCES agents(id),
      tokens_used INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'doing', 'review', 'done')),
      priority    INTEGER DEFAULT 50,
      session_id  TEXT REFERENCES sessions(id),
      agent_id    TEXT REFERENCES agents(id),
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      content    TEXT NOT NULL,
      type       TEXT DEFAULT 'general',
      importance INTEGER DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          TEXT PRIMARY KEY,
      action      TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      details     TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS analytics_events (
      id         TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      data       TEXT,
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config_items (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      description TEXT,
      is_secret   INTEGER DEFAULT 0,
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hive_mind (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT REFERENCES agents(id),
      action     TEXT NOT NULL,
      summary    TEXT NOT NULL,
      metadata   TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

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
      created_at    TEXT DEFAULT (datetime('now')),
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
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
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
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_model_spend_session ON model_spend(session_id);
    CREATE INDEX IF NOT EXISTS idx_model_spend_recent  ON model_spend(created_at DESC);

    -- v1.5: PARA areas. Used by the dashboard's PARA Map page to organize
    -- agents into themed rooms (Lifestyle, Finance, Health, Work, Learning).
    CREATE TABLE IF NOT EXISTS areas (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      icon_glyph  TEXT NOT NULL DEFAULT '◈',
      color_token TEXT NOT NULL DEFAULT 'neon',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
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
    "ALTER TABLE agents ADD COLUMN model_tier TEXT DEFAULT 'pinned'",
    'ALTER TABLE model_catalog ADD COLUMN cost_per_1k_input REAL',
    'ALTER TABLE model_catalog ADD COLUMN cost_per_1k_output REAL',
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
      created_at   TEXT DEFAULT (datetime('now'))
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
      valid_from   TEXT DEFAULT (datetime('now')),
      valid_to     TEXT,                       -- nullable; null = still true
      created_at   TEXT DEFAULT (datetime('now'))
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
      created_at          TEXT DEFAULT (datetime('now')),
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
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE (bot_id, channel_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_discord_routes_bot ON discord_channel_routes(bot_id)',
    // v1.7: per-agent vision mode. 'auto' lets us decide based on the model's
    // known vision capability + provider. 'native' forces the multi-modal
    // path; 'preprocess' always routes images through VISION_MODEL first
    // (described as text), then sends the description to the agent.
    "ALTER TABLE agents ADD COLUMN vision_mode TEXT DEFAULT 'auto'",

    // v1.8: per-agent voice (TTS). When tts_enabled=1, the dashboard exposes a
    // speaker button on the agent's messages and the Discord bot can attach a
    // synthesized .mp3 to replies (gated additionally by discord_bots.voice_enabled).
    'ALTER TABLE agents ADD COLUMN tts_enabled INTEGER DEFAULT 0',
    "ALTER TABLE agents ADD COLUMN tts_provider TEXT DEFAULT 'voidai'",
    'ALTER TABLE agents ADD COLUMN tts_voice TEXT',
    // v1.8: per-bot voice toggle. Lets a bot ignore its agents' tts_enabled
    // (e.g. a text-only support channel) without flipping every agent.
    'ALTER TABLE discord_bots ADD COLUMN voice_enabled INTEGER DEFAULT 0',

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
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
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
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
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
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled)',
  ];
  for (const sql of alters) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }
  // Patch Alfred's role if it was seeded before this column existed
  database.exec("UPDATE agents SET role = 'orchestrator' WHERE name = 'Alfred' AND role = 'agent'");

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
}

// ── Seed ────────────────────────────────────────────────────────────────────

const SPAWN_GUIDANCE =
  '\n\nYou may create temporary sub-agents when:\n' +
  '- the task is complex and requires deep specialization\n' +
  '- parallel work would significantly improve performance\n' +
  'Prefer delegation before spawning. Do NOT spawn agents unnecessarily.';

const SUB_AGENTS = [
  {
    name: 'Researcher',
    description: 'Deep research, synthesis, and knowledge retrieval specialist',
    role: 'specialist',
    capabilities: ['research', 'summarize', 'fact-check'],
    systemPrompt:
      'You are Researcher, a specialist AI agent focused on deep research and knowledge synthesis.\n\n' +
      'You:\n' +
      '- Find and synthesize information thoroughly\n' +
      '- Cite sources and distinguish fact from inference\n' +
      '- Break down complex topics into clear explanations\n' +
      '- Flag uncertainty when your knowledge is incomplete\n\n' +
      'You are a sub-agent working under Alfred\'s orchestration. Stay focused on your research specialty.' +
      SPAWN_GUIDANCE,
  },
  {
    name: 'Coder',
    description: 'Code generation, debugging, and technical implementation specialist',
    role: 'specialist',
    capabilities: ['code', 'debug', 'refactor', 'review'],
    systemPrompt:
      'You are Coder, a specialist AI agent focused on code generation and technical implementation.\n\n' +
      'You:\n' +
      '- Write clean, efficient, well-structured code\n' +
      '- Debug and explain technical problems precisely\n' +
      '- Suggest idiomatic improvements and best practices\n' +
      '- Adapt to the user\'s language, framework, and context\n\n' +
      'You are a sub-agent working under Alfred\'s orchestration. Stay focused on technical and coding tasks.' +
      SPAWN_GUIDANCE,
  },
  {
    name: 'Planner',
    description: 'Project planning, task breakdown, and strategic roadmapping specialist',
    role: 'specialist',
    capabilities: ['plan', 'tasks', 'roadmap', 'prioritize'],
    systemPrompt:
      'You are Planner, a specialist AI agent focused on project planning and strategic thinking.\n\n' +
      'You:\n' +
      '- Break down complex goals into concrete, actionable tasks\n' +
      '- Identify dependencies, risks, and critical paths\n' +
      '- Prioritize work by impact, urgency, and effort\n' +
      '- Create clear timelines, milestones, and success criteria\n\n' +
      'You are a sub-agent working under Alfred\'s orchestration. Stay focused on planning and coordination tasks.' +
      SPAWN_GUIDANCE,
  },
];

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
      buildAlfredPrompt(),
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

  // Always keep seeded agent prompts current (idempotent update)
  database.exec("UPDATE agents SET role = 'orchestrator' WHERE name = 'Alfred'");
  database.prepare('UPDATE agents SET system_prompt = ? WHERE name = ?').run(buildAlfredPrompt(), 'Alfred');

  for (const agent of SUB_AGENTS) {
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
      // Keep system prompt current
      database.prepare('UPDATE agents SET system_prompt = ?, description = ? WHERE id = ?')
        .run(agent.systemPrompt, agent.description, row.id);
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
  model_tier:          string;
  area_id:             string | null;
  skills:              string;            // JSON array of skill names
  last_heartbeat_at:   string | null;
  heartbeat_status:    string;            // 'ok' | 'fail' | 'skipped' | 'never'
  heartbeat_latency_ms: number | null;
  composio_enabled:    number;            // 0/1
  composio_user_id:    string | null;     // Composio user id (per-agent identity)
  composio_toolkits:   string | null;     // JSON array; null = all toolkits
  vision_mode:         string;            // 'auto' | 'native' | 'preprocess'
  tts_enabled:         number;            // 0/1
  tts_provider:        string;            // 'voidai' | 'elevenlabs'
  tts_voice:           string | null;     // provider-specific voice id (e.g. 'alloy' or an ElevenLabs voice_id)
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
  voice_enabled:        number;            // 0/1; gates whether replies attach synthesized audio
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
  require_mention:  number;       // 0 or 1; overrides bot's auto_reply for this channel
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
  voice_enabled:      boolean;
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

export function upsertDiscordRoute(botId: string, channelId: string, agentId: string, requireMention?: boolean): DiscordChannelRouteRow {
  const existing = getDb().prepare('SELECT * FROM discord_channel_routes WHERE bot_id = ? AND channel_id = ?').get(botId, channelId) as DiscordChannelRouteRow | undefined;
  if (existing) {
    if (requireMention === undefined) {
      getDb().prepare('UPDATE discord_channel_routes SET agent_id = ? WHERE id = ?').run(agentId, existing.id);
    } else {
      getDb().prepare('UPDATE discord_channel_routes SET agent_id = ?, require_mention = ? WHERE id = ?').run(agentId, requireMention ? 1 : 0, existing.id);
    }
    return getDb().prepare('SELECT * FROM discord_channel_routes WHERE id = ?').get(existing.id) as DiscordChannelRouteRow;
  }
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO discord_channel_routes (id, bot_id, channel_id, agent_id, require_mention)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, botId, channelId, agentId, requireMention ? 1 : 0);
  return getDb().prepare('SELECT * FROM discord_channel_routes WHERE id = ?').get(id) as DiscordChannelRouteRow;
}

export function setDiscordRouteRequireMention(routeId: string, requireMention: boolean): void {
  getDb().prepare('UPDATE discord_channel_routes SET require_mention = ? WHERE id = ?').run(requireMention ? 1 : 0, routeId);
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
    VALUES (?, ?, ?, ?, datetime('now'))
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
  const sets: string[] = ["updated_at = datetime('now')"];
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
  getDb().prepare(`UPDATE agents SET area_id = ?, updated_at = datetime('now') WHERE id = ?`).run(areaId, agentId);
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
  const sets: string[] = ["updated_at = datetime('now')"];
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

export function getAllAgents(): AgentRecord[] {
  return getDb()
    .prepare('SELECT * FROM agents ORDER BY role DESC, name ASC')
    .all() as AgentRecord[];
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
    model_tier?: string;
    skills?: string[];
  } = {},
): AgentRecord {
  const id = randomUUID();
  const db = getDb();
  const provider = opts.provider ?? 'openai';
  const defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-6' : config.voidai.model;
  db.prepare(`
    INSERT INTO agents (id, name, description, system_prompt, model, role, capabilities, provider, exec_enabled, model_tier, skills)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    opts.model_tier ?? 'pinned',
    JSON.stringify(opts.skills ?? []),
  );
  logAudit('agent_created', 'agent', id, { name, provider, exec_enabled: !!opts.exec_enabled });
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
    model_tier?: string;
    skills?: string[];
    vision_mode?: string;
    composio_enabled?:  boolean;
    composio_user_id?:  string | null;
    composio_toolkits?: string[] | null;
    tts_enabled?:  boolean;
    tts_provider?: string;
    tts_voice?:    string | null;
  },
): void {
  const sets: string[] = ["updated_at = datetime('now')"];
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
  if (fields.model_tier    !== undefined) { sets.push('model_tier = ?');    params.push(fields.model_tier); }
  if (fields.skills        !== undefined) { sets.push('skills = ?');        params.push(JSON.stringify(fields.skills)); }
  if (fields.vision_mode   !== undefined) {
    const v = fields.vision_mode === 'native' || fields.vision_mode === 'preprocess' ? fields.vision_mode : 'auto';
    sets.push('vision_mode = ?'); params.push(v);
  }
  if (fields.composio_enabled  !== undefined) { sets.push('composio_enabled = ?');  params.push(fields.composio_enabled ? 1 : 0); }
  if (fields.composio_user_id  !== undefined) { sets.push('composio_user_id = ?');  params.push(fields.composio_user_id); }
  if (fields.composio_toolkits !== undefined) {
    sets.push('composio_toolkits = ?');
    params.push(fields.composio_toolkits === null || fields.composio_toolkits.length === 0 ? null : JSON.stringify(fields.composio_toolkits));
  }
  if (fields.tts_enabled  !== undefined) { sets.push('tts_enabled = ?');  params.push(fields.tts_enabled ? 1 : 0); }
  if (fields.tts_provider !== undefined) {
    const p = fields.tts_provider === 'elevenlabs' ? 'elevenlabs' : 'voidai';
    sets.push('tts_provider = ?'); params.push(p);
  }
  if (fields.tts_voice    !== undefined) { sets.push('tts_voice = ?');    params.push(fields.tts_voice); }

  if (sets.length === 1) return;
  params.push(id);
  getDb().prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logAudit('agent_updated', 'agent', id, fields);
}

export function deactivateAgent(id: string): { ok: boolean; reason?: string } {
  const agent = getAgentById(id);
  if (!agent) return { ok: false, reason: 'not found' };
  if (agent.name === 'Alfred') return { ok: false, reason: 'Alfred cannot be deactivated' };
  updateAgentRecord(id, { status: 'inactive' });
  return { ok: true };
}

export function activateAgent(id: string): void {
  updateAgentRecord(id, { status: 'active' });
}

/**
 * Permanently delete an agent. Alfred is protected. NULLs out the agent_id on
 * tasks / messages / agent_messages so history isn't lost — we just orphan the
 * references. Use deactivateAgent() for the soft-delete (status='inactive').
 */
export function deleteAgentHard(id: string): { ok: boolean; reason?: string; cleared?: { tasks: number; messages: number; agentMessagesFrom: number; agentMessagesTo: number } } {
  const agent = getAgentById(id);
  if (!agent) return { ok: false, reason: 'not found' };
  if (agent.name === 'Alfred') return { ok: false, reason: 'Alfred is protected from hard delete' };

  const db = getDb();
  // NULL out FK references so we keep historical context but drop the agent.
  const tasksUpd            = db.prepare('UPDATE tasks SET agent_id = NULL WHERE agent_id = ?').run(id);
  const messagesUpd         = db.prepare('UPDATE messages SET agent_id = NULL WHERE agent_id = ?').run(id);
  const agentMessagesFromUpd= db.prepare('UPDATE agent_messages SET from_agent_id = NULL WHERE from_agent_id = ?').run(id);
  const agentMessagesToUpd  = db.prepare('UPDATE agent_messages SET to_agent_id = NULL WHERE to_agent_id = ?').run(id);
  // Drop spawned-by references too so child temp agents aren't orphaned with a dangling parent_agent_id.
  db.prepare('UPDATE agents SET parent_agent_id = NULL, created_by_agent_id = NULL WHERE parent_agent_id = ? OR created_by_agent_id = ?').run(id, id);
  // memory_index keeps agent_id for attribution; we leave it alone — the row is harmless and history-preserving.
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  logAudit('agent_deleted_hard', 'agent', id, { name: agent.name });
  return {
    ok: true,
    cleared: {
      tasks:                tasksUpd.changes,
      messages:             messagesUpd.changes,
      agentMessagesFrom:    agentMessagesFromUpd.changes,
      agentMessagesTo:      agentMessagesToUpd.changes,
    },
  };
}

// ── Session helpers ───────────────────────────────────────────────────────────

export interface SessionRecord {
  id:            string;
  title:         string | null;
  status:        string;
  agent_id:      string | null;
  message_count: number;
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

export function createSession(agentId: string, title?: string): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO sessions (id, title, agent_id) VALUES (?, ?, ?)
  `).run(id, title ?? `Chat ${new Date().toLocaleString()}`, agentId);
  return id;
}

export function getSessionById(id: string): SessionRecord | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRecord | undefined;
}

export function getSessions(limit = 50): SessionRecord[] {
  return getDb()
    .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as SessionRecord[];
}

export function getSessionMessages(sessionId: string): MessageRecord[] {
  // LEFT JOIN agents so the dashboard can render @AgentName on cold-loaded messages
  // (live SSE streams already include the name; this fills the gap on history reloads).
  return getDb()
    .prepare(`
      SELECT m.*, a.name AS agent_name
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.session_id = ?
      ORDER BY m.created_at ASC
    `)
    .all(sessionId) as MessageRecord[];
}

export function updateSessionTitle(sessionId: string, title: string): void {
  getDb().prepare(`UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(title, sessionId);
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  logAudit('session_deleted', 'session', sessionId);
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
    UPDATE sessions SET message_count = message_count + 1, updated_at = datetime('now') WHERE id = ?
  `).run(sessionId);
}

export function getAlfredAgent(): AgentRecord | undefined {
  return getAgentByName('Alfred');
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
  fromAgentId: string,
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
  `).run(id, fromAgentId, fromName, toAgentId, toName, content, sessionId ?? null);
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
    SET response = ?, status = ?, task_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(response, status, taskId ?? null, id);
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
  const sets: string[] = ["updated_at = datetime('now')"];
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
