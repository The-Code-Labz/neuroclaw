import { randomUUID } from 'crypto';
import { getDb, logAudit } from '../db';
import { scrubForMemory } from '../broker/memoryScrub';
import { getMemoryStore, type EmbeddedMemoryRow } from './memory-store';

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
  // Broker scrubber pass: replace any literal/encoded secret values that
  // happen to be in `content` before it reaches disk. Fire-and-forget — the
  // sync API contract is preserved by writing the row first; the scrubber
  // updates it in-place if it finds anything (rare). For most callers the
  // content was already scrubbed at exec time, so this is a safety net.
  db.prepare(`
    INSERT INTO memories (id, session_id, content, type, importance)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sessionId ?? null, content, type, importance);
  logAudit('memory_saved', 'memory', id, { type });

  // Async post-write scrub: if the content contained any secret, rewrite the
  // row with the scrubbed version. We deliberately don't await this here so
  // the call site keeps its synchronous shape.
  scrubForMemory(content, { sessionId })
    .then((scrubbed) => {
      if (scrubbed !== content) {
        db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(scrubbed, id);
      }
    })
    .catch(() => { /* logged inside scrubForMemory */ });

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

// ── memory_index DAO — delegates to the active MemoryStore (sqlite|supabase) ──
// These hold NO SQL: the SQLite store owns the statements (memory-store-sqlite.ts),
// so a store can never recurse back through these exports.

export async function indexMemory(input: MemoryIndexInput): Promise<MemoryIndexRow> {
  return (await getMemoryStore()).indexMemory(input);
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

/** Persist entities + relationships extracted alongside a memory. */
export async function attachMemoryGraph(input: AttachGraphInput): Promise<{ entities: number; relationships: number }> {
  return (await getMemoryStore()).attachMemoryGraph(input);
}

/** All memories that mention an entity (case-insensitive). */
export async function findMemoriesByEntity(name: string, limit = 50): Promise<MemoryIndexRow[]> {
  return (await getMemoryStore()).findMemoriesByEntity(name, limit);
}

/** Relationships where this name appears as subject OR object. */
export async function findRelationshipsForEntity(name: string, limit = 50): Promise<MemoryRelationshipRow[]> {
  return (await getMemoryStore()).findRelationshipsForEntity(name, limit);
}

/** Aggregate entity name → mention count + most recent appearance. */
export async function topEntities(limit = 50): Promise<Array<{ name: string; mentions: number; last_seen: string }>> {
  return (await getMemoryStore()).topEntities(limit);
}

export async function getMemoryIndexById(id: string): Promise<MemoryIndexRow | null> {
  return (await getMemoryStore()).getMemoryIndexById(id);
}

/** Hybrid lexical pass (FTS5 on sqlite, Postgres FTS on supabase). */
export async function searchMemoryIndex(query: string, limit = 50): Promise<MemoryIndexRow[]> {
  return (await getMemoryStore()).searchMemoryIndex(query, limit);
}

/** Candidate set for vector ranking (embedding as number[]). */
export async function listEmbeddedMemoryIndex(opts: { limit?: number } = {}): Promise<EmbeddedMemoryRow[]> {
  return (await getMemoryStore()).listEmbeddedMemoryIndex({ limit: opts.limit ?? 400 });
}

export async function listMemoryIndex(opts: { limit?: number; type?: string; sessionId?: string } = {}): Promise<MemoryIndexRow[]> {
  return (await getMemoryStore()).listMemoryIndex(opts);
}

export async function touchMemoryAccess(id: string): Promise<void> {
  return (await getMemoryStore()).touchMemoryAccess(id);
}
