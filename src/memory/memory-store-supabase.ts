// Supabase memory store — backs memory onto neuroclaw_kb pgvector. Reuses the
// KB's lazy getSupabase() client (same schema). Fail-soft: every method catches
// and returns empty/no-op so a Supabase blip can't crash a chat turn. Owns its
// SQL-equivalent supabase-js calls; does NOT call memory-service.
import { randomUUID } from 'crypto';
import { getSupabase } from '../db/supabase';
import { enqueueJob } from '../db';
import { logger } from '../utils/logger';
import type {
  MemoryIndexRow, MemoryIndexInput, AttachGraphInput, MemoryRelationshipRow,
} from './memory-service';
import type { MemoryStore, EmbeddedMemoryRow, MemoryStats } from './memory-store';

// Supabase rows: tags is jsonb (array), timestamps are ISO strings, and there
// are no vault_* columns. Coerce to the MemoryIndexRow shape callers expect
// (tags as a JSON STRING, vault fields null).
function toRow(r: Record<string, unknown>): MemoryIndexRow {
  return {
    id:            r.id as string,
    type:          r.type as string,
    title:         r.title as string,
    summary:       (r.summary as string | null) ?? null,
    tags:          r.tags == null ? null : JSON.stringify(r.tags),
    importance:    Number(r.importance ?? 0.5),
    salience:      Number(r.salience ?? 0.5),
    agent_id:      (r.agent_id as string | null) ?? null,
    session_id:    (r.session_id as string | null) ?? null,
    vault_note_id: null,
    vault_path:    null,
    created_at:    (r.created_at as string | null) ?? '',
    last_accessed: (r.last_accessed as string | null) ?? null,
    embedding_model: (r.embedding_model as string | null) ?? null,
  };
}

const COLS = 'id, type, title, summary, tags, importance, salience, agent_id, session_id, created_at, last_accessed, embedding_model';

export const supabaseStore: MemoryStore = {
  async indexMemory(input: MemoryIndexInput): Promise<MemoryIndexRow> {
    const id = randomUUID();
    const sb = getSupabase();
    const insert = {
      id, type: input.type, title: input.title, summary: input.summary ?? null,
      tags: input.tags ?? [],                       // jsonb array
      importance: input.importance ?? 0.5, salience: input.salience ?? 0.5,
      agent_id: input.agent_id ?? null, session_id: input.session_id ?? null,
    };
    const { data, error } = await sb.from('memory_index').insert(insert).select(COLS).single();
    if (error) throw new Error(`mem insert: ${error.message}`);
    // Lazy embedding via the job queue (target=memory → pinned 1536 vector).
    const embedSource = (input.summary ?? input.title ?? '').trim();
    if (embedSource) {
      try { enqueueJob('embedding_generate', { target: 'memory', rowId: id, text: embedSource }, 4); } catch { /* non-fatal */ }
    }
    return toRow(data as Record<string, unknown>);
  },

  async updateMemory(id, patch): Promise<void> {
    const upd: Record<string, unknown> = {};
    for (const k of ['type', 'title', 'summary', 'salience', 'importance'] as const) {
      if (patch[k] !== undefined) upd[k] = patch[k];
    }
    if (!Object.keys(upd).length) return;
    const { error } = await getSupabase().from('memory_index').update(upd).eq('id', id);
    if (error) logger.warn('mem: updateMemory failed', { id, err: error.message });
  },

  async deleteMemory(id): Promise<void> {
    const { error } = await getSupabase().from('memory_index').delete().eq('id', id);
    if (error) logger.warn('mem: deleteMemory failed', { id, err: error.message });
  },

  async touchMemoryAccess(id): Promise<void> {
    const { error } = await getSupabase().from('memory_index').update({ last_accessed: new Date().toISOString() }).eq('id', id);
    if (error) logger.warn('mem: touchMemoryAccess failed', { id, err: error.message });
  },

  async detachSession(sessionId): Promise<void> {
    const { error } = await getSupabase().from('memory_index').update({ session_id: null }).eq('session_id', sessionId);
    if (error) logger.warn('mem: detachSession failed', { sessionId, err: error.message });
  },

  async attachMemoryGraph(input: AttachGraphInput): Promise<{ entities: number; relationships: number }> {
    const sb = getSupabase();
    const ents = (input.entities ?? []).filter(e => e?.name)
      .map(e => ({ id: randomUUID(), memory_id: input.memoryId, name: e.name, entity_type: e.entity_type ?? null }));
    const rels = (input.relationships ?? []).filter(r => r?.subject && r?.verb && r?.object)
      .map(r => ({ id: randomUUID(), memory_id: input.memoryId, subject: r.subject, verb: r.verb, object: r.object, confidence: typeof r.confidence === 'number' ? r.confidence : 0.7 }));
    try {
      if (ents.length) { const { error } = await sb.from('memory_entities').insert(ents); if (error) throw error; }
      if (rels.length) { const { error } = await sb.from('memory_relationships').insert(rels); if (error) throw error; }
    } catch (err) {
      logger.warn('mem: attachMemoryGraph failed', { err: (err as Error).message });
    }
    return { entities: ents.length, relationships: rels.length };
  },

  async getMemoryIndexById(id): Promise<MemoryIndexRow | null> {
    const { data, error } = await getSupabase().from('memory_index').select(COLS).eq('id', id).maybeSingle();
    if (error) { logger.warn('mem: getMemoryIndexById failed', { id, err: error.message }); return null; }
    return data ? toRow(data as Record<string, unknown>) : null;
  },

  async searchMemoryIndex(query, limit): Promise<MemoryIndexRow[]> {
    const q = (query ?? '').trim();
    if (!q) return [];
    try {
      const { data, error } = await getSupabase().from('memory_index')
        .select(COLS).textSearch('content_search', q, { type: 'websearch' })
        .order('salience', { ascending: false }).limit(limit);
      if (error) { logger.warn('mem: searchMemoryIndex failed', { err: error.message }); return []; }
      return (data ?? []).map(r => toRow(r as Record<string, unknown>));
    } catch (err) { logger.warn('mem: searchMemoryIndex threw', { err: (err as Error).message }); return []; }
  },

  // Not used on the supabase recall path (matchByVector goes through the RPC),
  // but implemented for interface completeness. Embeddings aren't selected here.
  async listEmbeddedMemoryIndex(opts): Promise<EmbeddedMemoryRow[]> {
    void opts;
    return [];
  },

  async listMemoryIndex(opts): Promise<MemoryIndexRow[]> {
    let q = getSupabase().from('memory_index').select(COLS).order('created_at', { ascending: false }).limit(opts.limit ?? 50);
    if (opts.type)      q = q.eq('type', opts.type);
    if (opts.sessionId) q = q.eq('session_id', opts.sessionId);
    const { data, error } = await q;
    if (error) { logger.warn('mem: listMemoryIndex failed', { err: error.message }); return []; }
    return (data ?? []).map(r => toRow(r as Record<string, unknown>));
  },

  async matchByVector(queryVector, limit): Promise<Array<MemoryIndexRow & { similarity: number }>> {
    try {
      const { data, error } = await getSupabase().rpc('match_memories', {
        query_embedding: Array.from(queryVector),
        match_count: Math.max(limit, 20),
      });
      if (error) { logger.warn('mem: match_memories failed', { err: error.message }); return []; }
      return (data ?? [])
        .map((r: Record<string, unknown>) => ({ ...toRow(r), similarity: Number(r.similarity ?? 0) }))
        .filter((r: { similarity: number }) => r.similarity >= 0.30)   // parity with sqlite cosine threshold
        .slice(0, limit);
    } catch (err) { logger.warn('mem: matchByVector threw', { err: (err as Error).message }); return []; }
  },

  async findDuplicateId(opts): Promise<string | null> {
    const cutoff = new Date(Date.now() - Math.max(1, opts.withinHours) * 3600_000).toISOString();
    let q = getSupabase().from('memory_index').select('id').eq('type', opts.type).eq('title', opts.title).gte('created_at', cutoff).limit(1);
    q = opts.agentId == null ? q.is('agent_id', null) : q.eq('agent_id', opts.agentId);
    const { data, error } = await q;
    if (error) { logger.warn('mem: findDuplicateId failed', { err: error.message }); return null; }
    return (data && data[0]?.id) ? (data[0].id as string) : null;
  },

  async getStats(): Promise<MemoryStats> {
    const sb = getSupabase();
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const dayAgo  = new Date(Date.now() - 86_400_000).toISOString();
    const head = async (build: (b: any) => any) => {
      const { count, error } = await build(sb.from('memory_index').select('*', { count: 'exact', head: true }));
      return error ? 0 : (count ?? 0);
    };
    const [total, lastHour, lastDay] = await Promise.all([
      head((b: any) => b),
      head((b: any) => b.gte('created_at', hourAgo)),
      head((b: any) => b.gte('created_at', dayAgo)),
    ]);
    return { total, lastHour, lastDay };
  },

  async countByType(): Promise<Array<{ type: string; n: number }>> {
    const { data, error } = await getSupabase().rpc('memory_count_by_type');
    if (error) { logger.warn('mem: countByType failed', { err: error.message }); return []; }
    return (data ?? []).map((r: Record<string, unknown>) => ({ type: r.type as string, n: Number(r.n ?? 0) }));
  },

  async findMemoriesByEntity(name, limit): Promise<MemoryIndexRow[]> {
    const sb = getSupabase();
    const { data: ents, error: e1 } = await sb.from('memory_entities').select('memory_id').ilike('name', name).limit(limit);
    if (e1 || !ents?.length) return [];
    const ids = [...new Set(ents.map((e: Record<string, unknown>) => e.memory_id as string))];
    const { data, error } = await sb.from('memory_index').select(COLS).in('id', ids)
      .order('salience', { ascending: false }).limit(limit);
    if (error) { logger.warn('mem: findMemoriesByEntity failed', { err: error.message }); return []; }
    return (data ?? []).map(r => toRow(r as Record<string, unknown>));
  },

  async findRelationshipsForEntity(name, limit): Promise<MemoryRelationshipRow[]> {
    const { data, error } = await getSupabase().from('memory_relationships')
      .select('*').or(`subject.ilike.${name},object.ilike.${name}`).is('valid_to', null)
      .order('confidence', { ascending: false }).limit(limit);
    if (error) { logger.warn('mem: findRelationshipsForEntity failed', { err: error.message }); return []; }
    return (data ?? []) as MemoryRelationshipRow[];
  },

  async topEntities(limit): Promise<Array<{ name: string; mentions: number; last_seen: string }>> {
    const { data, error } = await getSupabase().rpc('memory_top_entities', { match_count: limit });
    if (error) { logger.warn('mem: topEntities failed', { err: error.message }); return []; }
    return (data ?? []).map((r: Record<string, unknown>) => ({ name: r.name as string, mentions: Number(r.mentions ?? 0), last_seen: (r.last_seen as string) ?? '' }));
  },
};
