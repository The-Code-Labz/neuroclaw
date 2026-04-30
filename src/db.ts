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
  ];
  for (const sql of alters) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }
  // Patch Alfred's role if it was seeded before this column existed
  database.exec("UPDATE agents SET role = 'orchestrator' WHERE name = 'Alfred' AND role = 'agent'");
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
  created_at:          string;
  updated_at:          string;
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
  } = {},
): AgentRecord {
  const id = randomUUID();
  const db = getDb();
  const provider = opts.provider ?? 'openai';
  const defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-6' : config.voidai.model;
  db.prepare(`
    INSERT INTO agents (id, name, description, system_prompt, model, role, capabilities, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    opts.description ?? null,
    opts.systemPrompt ?? null,
    opts.model ?? defaultModel,
    opts.role ?? 'agent',
    JSON.stringify(opts.capabilities ?? []),
    provider,
  );
  logAudit('agent_created', 'agent', id, { name, provider });
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
  return getDb()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
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
