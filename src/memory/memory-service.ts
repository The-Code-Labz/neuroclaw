import { randomUUID } from 'crypto';
import { getDb, logAudit } from '../db';

// ── Legacy memories table (kept for the dashboard memory tab) ────────────────

export interface Memory {
  id:         string;
  session_id: string | null;
  content:    string;
  type:       string;
  importance: number;
  created_at: string;
}

export function saveMemory(content: string, type = 'general', sessionId?: string, importance = 5): Memory {
  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO memories (id, session_id, content, type, importance)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sessionId ?? null, content, type, importance);
  logAudit('memory_saved', 'memory', id, { type });
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory;
}

export function getMemories(limit = 50): Memory[] {
  return getDb()
    .prepare('SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?')
    .all(limit) as Memory[];
}

export function searchMemories(query: string): Memory[] {
  return getDb()
    .prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY importance DESC LIMIT 20')
    .all(`%${query}%`) as Memory[];
}

// ── memory_index (v1.4 long-term memory, mirrors NeuroVault) ─────────────────

export type MemoryType =
  | 'working'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'preference'
  | 'session_summary'
  | 'insight'
  | 'project'
  | 'agent';

export interface MemoryIndexRow {
  id:              string;
  type:            string;
  title:           string;
  summary:         string | null;
  tags:            string | null;
  importance:      number;
  salience:        number;
  agent_id:        string | null;
  session_id:      string | null;
  vault_note_id:   string | null;
  vault_path:      string | null;
  created_at:      string;
  last_accessed:   string | null;
  embedding?:       Buffer | null;
  embedding_model?: string | null;
}

export interface MemoryIndexInput {
  type:          MemoryType | string;
  title:         string;
  summary?:      string;
  tags?:         string[];
  importance?:   number;
  salience?:     number;
  agent_id?:     string | null;
  session_id?:   string | null;
  vault_note_id?: string | null;
  vault_path?:   string | null;
}

export function indexMemory(input: MemoryIndexInput): MemoryIndexRow {
  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO memory_index (id, type, title, summary, tags, importance, salience,
                              agent_id, session_id, vault_note_id, vault_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type,
    input.title,
    input.summary ?? null,
    input.tags ? JSON.stringify(input.tags) : null,
    input.importance ?? 0.5,
    input.salience   ?? 0.5,
    input.agent_id      ?? null,
    input.session_id    ?? null,
    input.vault_note_id ?? null,
    input.vault_path    ?? null,
  );
  logAudit('memory_indexed', 'memory_index', id, { type: input.type, title: input.title });

  // Generate + persist the embedding lazily — never blocks the write path.
  // The summary is the right text to embed: it's the distilled lesson, already
  // optimised for high signal-per-token. If the embedder is disabled or fails,
  // the row simply has no embedding and falls back to the Jaccard path on read.
  const embedSource = (input.summary ?? input.title ?? '').trim();
  if (embedSource) embedAndStoreAsync(id, embedSource);

  return getMemoryIndexById(id)!;
}

function embedAndStoreAsync(id: string, text: string): void {
  // Fire-and-forget; the indexMemory caller doesn't wait. Errors are logged
  // inside embedText() and do not propagate.
  void (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { embedText, packVector } = await import('./embeddings');
    const result = await embedText(text);
    if (!result) return;
    try {
      getDb().prepare('UPDATE memory_index SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(packVector(result.vector), result.model, id);
    } catch (err) {
      // Non-fatal: the row just stays without an embedding.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (await import('../utils/logger')).logger.warn('memory embedding persist failed', { id, err: (err as Error).message });
    }
  })();
}

// ── Graph-lite (entities + relationships, FK to memory_index) ───────────────

export interface MemoryEntityRow {
  id:           string;
  memory_id:    string;
  name:         string;
  entity_type:  string | null;
  created_at:   string;
}

export interface MemoryRelationshipRow {
  id:          string;
  memory_id:   string;
  subject:     string;
  verb:        string;
  object:      string;
  confidence:  number;
  valid_from:  string;
  valid_to:    string | null;
  created_at:  string;
}

export interface AttachGraphInput {
  memoryId:      string;
  entities?:     Array<{ name: string; entity_type?: string }>;
  relationships?: Array<{ subject: string; verb: string; object: string; confidence?: number }>;
}

/** Persist entities + relationships extracted alongside a memory. Idempotent
 *  per memory_id is the caller's responsibility — `attachMemoryGraph` will
 *  insert duplicates if called twice. */
export function attachMemoryGraph(input: AttachGraphInput): { entities: number; relationships: number } {
  const db = getDb();
  let entCount = 0;
  let relCount = 0;

  if (input.entities && input.entities.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO memory_entities (id, memory_id, name, entity_type)
      VALUES (?, ?, ?, ?)
    `);
    for (const e of input.entities) {
      if (!e?.name) continue;
      stmt.run(randomUUID(), input.memoryId, e.name, e.entity_type ?? null);
      entCount++;
    }
  }

  if (input.relationships && input.relationships.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO memory_relationships (id, memory_id, subject, verb, object, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const r of input.relationships) {
      if (!r?.subject || !r?.verb || !r?.object) continue;
      stmt.run(randomUUID(), input.memoryId, r.subject, r.verb, r.object, typeof r.confidence === 'number' ? r.confidence : 0.7);
      relCount++;
    }
  }

  return { entities: entCount, relationships: relCount };
}

/** All memories that mention an entity (case-insensitive). Joins back to
 *  memory_index so callers can rank/render alongside other retrieval hits. */
export function findMemoriesByEntity(name: string, limit = 20): MemoryIndexRow[] {
  return getDb().prepare(`
    SELECT mi.* FROM memory_index mi
    JOIN memory_entities e ON e.memory_id = mi.id
    WHERE e.name = ? COLLATE NOCASE
    ORDER BY mi.salience DESC, mi.importance DESC, mi.created_at DESC
    LIMIT ?
  `).all(name, limit) as MemoryIndexRow[];
}

/** Relationships where this name appears as subject OR object. Use to answer
 *  "what does NeuroClaw use?", "what depends on Composio?", etc. */
export function findRelationshipsForEntity(name: string, limit = 50): MemoryRelationshipRow[] {
  return getDb().prepare(`
    SELECT * FROM memory_relationships
    WHERE (subject = ? OR object = ?) COLLATE NOCASE
      AND valid_to IS NULL
    ORDER BY confidence DESC, created_at DESC
    LIMIT ?
  `).all(name, name, limit) as MemoryRelationshipRow[];
}

/** Aggregate entity name → mention count + most recent appearance. Powers
 *  the dashboard's "what does the system know?" view and dream-cycle dedupe. */
export function topEntities(limit = 50): Array<{ name: string; mentions: number; last_seen: string }> {
  return getDb().prepare(`
    SELECT name, COUNT(*) as mentions, MAX(created_at) as last_seen
    FROM memory_entities
    GROUP BY name COLLATE NOCASE
    ORDER BY mentions DESC, last_seen DESC
    LIMIT ?
  `).all(limit) as Array<{ name: string; mentions: number; last_seen: string }>;
}

export function getMemoryIndexById(id: string): MemoryIndexRow | null {
  const row = getDb().prepare('SELECT * FROM memory_index WHERE id = ?').get(id) as MemoryIndexRow | undefined;
  return row ?? null;
}

/**
 * Tokenize a user query into an FTS5 MATCH expression. We:
 *   - strip FTS5 special characters (quotes, parens, AND/OR/NOT/NEAR operators
 *     get treated as literal terms, never as syntax)
 *   - split on whitespace, drop tokens shorter than 2 chars
 *   - quote each token (so "5.5" doesn't get parsed as a column reference)
 *   - join with OR (recall-friendly; ranking sorts the precision back in)
 *   - append a prefix match (`*`) so partial-word queries hit ("compos" → "Composio")
 *
 * Returns null when the query has nothing meaningful to search for; callers
 * should fall back to the recency/importance ordering in that case.
 */
function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .replace(/[\"\(\)\^\*\+\-\:]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

/**
 * Hybrid-search-friendly lexical pass. Uses SQLite FTS5 with porter stemming
 * + BM25 ranking. Falls back silently to the legacy LIKE path when FTS5 is
 * unavailable or returns nothing usable (e.g. very short queries).
 *
 * The ORDER BY blends FTS5's BM25 rank with our existing salience/importance
 * signals so semantically-strong-but-stale memories don't always beat fresher
 * ones. BM25 in SQLite is *negative* (lower = better) so we negate it.
 */
export function searchMemoryIndex(query: string, limit = 20): MemoryIndexRow[] {
  const ftsExpr = buildFtsQuery(query);
  if (ftsExpr) {
    try {
      const rows = getDb().prepare(`
        SELECT mi.*
        FROM   memory_index_fts fts
        JOIN   memory_index    mi ON mi.id = fts.memory_id
        WHERE  fts.memory_index_fts MATCH ?
        ORDER BY (-bm25(memory_index_fts)) * 1.0
               + mi.salience   * 0.5
               + mi.importance * 0.3
               DESC
        LIMIT ?
      `).all(ftsExpr, limit) as MemoryIndexRow[];
      if (rows.length > 0) return rows;
    } catch {
      // FTS5 not compiled in / extension missing — fall through to LIKE path.
    }
  }
  // Legacy fallback: substring LIKE search. Kept for short queries and as a
  // safety net for environments without FTS5.
  return getDb().prepare(`
    SELECT * FROM memory_index
    WHERE title LIKE ? OR summary LIKE ? OR tags LIKE ?
    ORDER BY salience DESC, importance DESC, created_at DESC
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as MemoryIndexRow[];
}

/**
 * Pull a candidate set for vector ranking. We don't filter on the query text
 * here — the embedding cosine ranker is what decides relevance. Type/agent/
 * recency filters narrow the candidate set so we don't compute cosine over
 * the entire table.
 *
 * Returns ALL rows (with embeddings present) up to `limit` ordered by
 * importance/salience/recency as a coarse pre-filter; the caller computes
 * cosine and resorts.
 */
export function listEmbeddedMemoryIndex(opts: {
  limit?:     number;
  type?:      string;
  agentId?:   string | null;
  sessionId?: string | null;
} = {}): MemoryIndexRow[] {
  const limit = opts.limit ?? 200;
  const where: string[] = ['embedding IS NOT NULL'];
  const args:  unknown[] = [];
  if (opts.type)      { where.push('type = ?');       args.push(opts.type); }
  if (opts.agentId)   { where.push('agent_id = ?');   args.push(opts.agentId); }
  if (opts.sessionId) { where.push('session_id = ?'); args.push(opts.sessionId); }
  return getDb().prepare(`
    SELECT * FROM memory_index
    WHERE ${where.join(' AND ')}
    ORDER BY salience DESC, importance DESC, created_at DESC
    LIMIT ?
  `).all(...args, limit) as MemoryIndexRow[];
}

export function listMemoryIndex(opts: { limit?: number; type?: string; sessionId?: string } = {}): MemoryIndexRow[] {
  const limit = opts.limit ?? 50;
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.type)      { where.push('type = ?');       args.push(opts.type); }
  if (opts.sessionId) { where.push('session_id = ?'); args.push(opts.sessionId); }
  const sql = `
    SELECT * FROM memory_index
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  args.push(limit);
  return getDb().prepare(sql).all(...args) as MemoryIndexRow[];
}

export function touchMemoryAccess(id: string): void {
  getDb().prepare(`UPDATE memory_index SET last_accessed = datetime('now') WHERE id = ?`).run(id);
}

export function attachVaultNote(id: string, vaultNoteId: string, vaultPath?: string): void {
  getDb().prepare(`
    UPDATE memory_index SET vault_note_id = ?, vault_path = ? WHERE id = ?
  `).run(vaultNoteId, vaultPath ?? null, id);
}
