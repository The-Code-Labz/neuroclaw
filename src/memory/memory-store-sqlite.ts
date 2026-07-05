// SQLite memory store — owns the prepared-statement SQL (extracted from the old
// synchronous memory-service.ts). This is the default backend and preserves
// existing behavior exactly. memory-service.ts delegates here; this module must
// NOT call back into memory-service (that would recurse).
import { randomUUID } from 'crypto';
import { getDb, logAudit, enqueueJob } from '../db';
import { unpackVector, cosine } from './embeddings';
import type {
  MemoryIndexRow, MemoryIndexInput, AttachGraphInput, MemoryRelationshipRow,
} from './memory-service';
import type { MemoryStore, EmbeddedMemoryRow, MemoryStats } from './memory-store';

/** FTS5 MATCH expression builder (copied from the old memory-service). */
function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .replace(/[\"\(\)\^\*\+\-\:]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

export const sqliteStore: MemoryStore = {
  async indexMemory(input: MemoryIndexInput): Promise<MemoryIndexRow> {
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

    const embedSource = (input.summary ?? input.title ?? '').trim();
    if (embedSource) {
      try { enqueueJob('embedding_generate', { memoryIndexId: id, text: embedSource }, 4); } catch { /* non-fatal */ }
    }
    return (await this.getMemoryIndexById(id))!;
  },

  async updateMemory(id, patch): Promise<void> {
    const fields: string[] = [];
    const args: unknown[] = [];
    for (const k of ['type', 'title', 'summary', 'salience', 'importance'] as const) {
      if (patch[k] !== undefined) { fields.push(`${k} = ?`); args.push(patch[k]); }
    }
    if (!fields.length) return;
    args.push(id);
    getDb().prepare(`UPDATE memory_index SET ${fields.join(', ')} WHERE id = ?`).run(...args);
  },

  async deleteMemory(id): Promise<void> {
    getDb().prepare('DELETE FROM memory_index WHERE id = ?').run(id);
  },

  async touchMemoryAccess(id): Promise<void> {
    getDb().prepare(`UPDATE memory_index SET last_accessed = datetime('now') WHERE id = ?`).run(id);
  },

  async detachSession(sessionId): Promise<void> {
    getDb().prepare('UPDATE memory_index SET session_id = NULL WHERE session_id = ?').run(sessionId);
  },

  async attachMemoryGraph(input: AttachGraphInput): Promise<{ entities: number; relationships: number }> {
    const db = getDb();
    let entCount = 0, relCount = 0;
    if (input.entities?.length) {
      const stmt = db.prepare('INSERT INTO memory_entities (id, memory_id, name, entity_type) VALUES (?, ?, ?, ?)');
      for (const e of input.entities) {
        if (!e?.name) continue;
        stmt.run(randomUUID(), input.memoryId, e.name, e.entity_type ?? null);
        entCount++;
      }
    }
    if (input.relationships?.length) {
      const stmt = db.prepare('INSERT INTO memory_relationships (id, memory_id, subject, verb, object, confidence) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of input.relationships) {
        if (!r?.subject || !r?.verb || !r?.object) continue;
        stmt.run(randomUUID(), input.memoryId, r.subject, r.verb, r.object, typeof r.confidence === 'number' ? r.confidence : 0.7);
        relCount++;
      }
    }
    return { entities: entCount, relationships: relCount };
  },

  async getMemoryIndexById(id): Promise<MemoryIndexRow | null> {
    return (getDb().prepare('SELECT * FROM memory_index WHERE id = ?').get(id) as MemoryIndexRow | undefined) ?? null;
  },

  async searchMemoryIndex(query, limit): Promise<MemoryIndexRow[]> {
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
      } catch { /* FTS5 missing — fall through */ }
    }
    return getDb().prepare(`
      SELECT * FROM memory_index
      WHERE title LIKE ? OR summary LIKE ? OR tags LIKE ?
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as MemoryIndexRow[];
  },

  async listEmbeddedMemoryIndex(opts): Promise<EmbeddedMemoryRow[]> {
    const rows = getDb().prepare(`
      SELECT * FROM memory_index
      WHERE embedding IS NOT NULL
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT ?
    `).all(opts.limit) as MemoryIndexRow[];
    return rows.flatMap((r) => {
      const vec = unpackVector(r.embedding ?? null);
      if (!vec) return [];
      const { embedding: _e, ...rest } = r;
      return [{ ...rest, embedding: Array.from(vec) }];
    });
  },

  async listMemoryIndex(opts): Promise<MemoryIndexRow[]> {
    const limit = opts.limit ?? 50;
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.type)      { where.push('type = ?');       args.push(opts.type); }
    if (opts.sessionId) { where.push('session_id = ?'); args.push(opts.sessionId); }
    args.push(limit);
    return getDb().prepare(`
      SELECT * FROM memory_index
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...args) as MemoryIndexRow[];
  },

  async matchByVector(queryVector, limit): Promise<Array<MemoryIndexRow & { similarity: number }>> {
    const q = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
    const rows = getDb().prepare(`
      SELECT * FROM memory_index
      WHERE embedding IS NOT NULL
      ORDER BY salience DESC, importance DESC, created_at DESC
      LIMIT 400
    `).all() as MemoryIndexRow[];
    const scored: Array<MemoryIndexRow & { similarity: number }> = [];
    for (const r of rows) {
      const vec = unpackVector(r.embedding ?? null);
      if (!vec) continue;
      const sim = cosine(q, vec);
      if (sim >= 0.30) scored.push({ ...r, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  },

  async findDuplicateId(opts): Promise<string | null> {
    const db = getDb();
    const cutoff = `-${Math.max(1, Math.round(opts.withinHours))} hours`;
    const agentClause = opts.agentId == null ? 'agent_id IS NULL' : 'agent_id = ?';
    const args: unknown[] = [opts.type, opts.title];
    if (opts.agentId != null) args.push(opts.agentId);
    const row = db.prepare(`
      SELECT id FROM memory_index
      WHERE type = ? AND title = ? AND ${agentClause}
        AND created_at > datetime('now', ?)
      LIMIT 1
    `).get(...args, cutoff) as { id: string } | undefined;
    return row?.id ?? null;
  },

  async getStats(): Promise<MemoryStats> {
    const db = getDb();
    const c = (q: string) => (db.prepare(q).get() as { n: number }).n;
    return {
      total:    c('SELECT COUNT(*) as n FROM memory_index'),
      lastHour: c("SELECT COUNT(*) as n FROM memory_index WHERE created_at > datetime('now','-1 hour')"),
      lastDay:  c("SELECT COUNT(*) as n FROM memory_index WHERE created_at > datetime('now','-1 day')"),
    };
  },

  async countByType(): Promise<Array<{ type: string; n: number }>> {
    return getDb().prepare('SELECT type, COUNT(*) as n FROM memory_index GROUP BY type ORDER BY n DESC').all() as Array<{ type: string; n: number }>;
  },

  async findMemoriesByEntity(name, limit): Promise<MemoryIndexRow[]> {
    return getDb().prepare(`
      SELECT mi.* FROM memory_index mi
      JOIN memory_entities e ON e.memory_id = mi.id
      WHERE e.name = ? COLLATE NOCASE
      ORDER BY mi.salience DESC, mi.importance DESC, mi.created_at DESC
      LIMIT ?
    `).all(name, limit) as MemoryIndexRow[];
  },

  async findRelationshipsForEntity(name, limit): Promise<MemoryRelationshipRow[]> {
    return getDb().prepare(`
      SELECT * FROM memory_relationships
      WHERE (subject = ? OR object = ?) COLLATE NOCASE
        AND valid_to IS NULL
      ORDER BY confidence DESC, created_at DESC
      LIMIT ?
    `).all(name, name, limit) as MemoryRelationshipRow[];
  },

  async topEntities(limit): Promise<Array<{ name: string; mentions: number; last_seen: string }>> {
    return getDb().prepare(`
      SELECT name, COUNT(*) as mentions, MAX(created_at) as last_seen
      FROM memory_entities
      GROUP BY name COLLATE NOCASE
      ORDER BY mentions DESC, last_seen DESC
      LIMIT ?
    `).all(limit) as Array<{ name: string; mentions: number; last_seen: string }>;
  },
};
