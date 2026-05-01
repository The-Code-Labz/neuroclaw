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
  id:            string;
  type:          string;
  title:         string;
  summary:       string | null;
  tags:          string | null;
  importance:    number;
  salience:      number;
  agent_id:      string | null;
  session_id:    string | null;
  vault_note_id: string | null;
  vault_path:    string | null;
  created_at:    string;
  last_accessed: string | null;
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
  return getMemoryIndexById(id)!;
}

export function getMemoryIndexById(id: string): MemoryIndexRow | null {
  const row = getDb().prepare('SELECT * FROM memory_index WHERE id = ?').get(id) as MemoryIndexRow | undefined;
  return row ?? null;
}

export function searchMemoryIndex(query: string, limit = 20): MemoryIndexRow[] {
  return getDb().prepare(`
    SELECT * FROM memory_index
    WHERE title LIKE ? OR summary LIKE ? OR tags LIKE ?
    ORDER BY salience DESC, importance DESC, created_at DESC
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as MemoryIndexRow[];
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
