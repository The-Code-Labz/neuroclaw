import { touchMemoryAccess, type MemoryIndexRow } from './memory-service';
import { getMemoryStore } from './memory-store';
import { embedText } from './embeddings';
import { rankScore } from './memory-scorer';

// ── Types ────────────────────────────────────────────────────────────────────

export type RetrievalSource = 'sqlite';

export interface RetrievalHit {
  source:   RetrievalSource;
  type:     string;
  title:    string;
  summary:  string;
  score:    number;             // composite 0–1
  agent_id?: string | null;
  memory_id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw:      any;
}

export interface RetrieveOptions {
  query:     string;
  limit?:    number;            // overall cap, default 20
  agentId?:  string | null;
  sessionId?: string | null;
}

export interface CategorizedRetrieval {
  query:       string;
  total:       number;
  memory:      RetrievalHit[];     // episodic + semantic + working
  procedures:  RetrievalHit[];     // procedural
  insights:    RetrievalHit[];     // insight + semantic-as-rule
  preferences: RetrievalHit[];     // preference
  raw:         RetrievalHit[];     // full ranked list
}

// ── Source: the active MemoryStore (sqlite or supabase) ──────────────────────

function rowToHit(r: MemoryIndexRow & { similarity?: number }, scoreOverride?: number): RetrievalHit {
  // Strip the raw embedding vector if present — cosine was already computed.
  const { embedding: _emb, ...safeRow } = r as MemoryIndexRow & { embedding?: unknown };
  return {
    source:    'sqlite',
    type:      r.type,
    title:     r.title,
    summary:   r.summary ?? '',
    score:     scoreOverride ?? rankScore({
      salience:      r.salience,
      importance:    r.importance,
      created_at:    r.created_at,
      last_accessed: r.last_accessed,
    }),
    agent_id:   r.agent_id,
    memory_id:  r.id,
    raw:        safeRow,
  };
}

/**
 * Two-pass recall over the active store:
 *   1. Vector pass — `store.matchByVector` returns rows with raw cosine ≥ 0.30;
 *      each is blended with the salience/importance/recency baseline (0.6/0.4).
 *   2. Lexical pass — `store.searchMemoryIndex` (FTS) adds exact/legacy hits.
 * Merged + de-duplicated by memory id, sorted by composite score.
 */
async function searchStore(query: string, limit: number): Promise<RetrievalHit[]> {
  const store = await getMemoryStore();
  const merged = new Map<string, RetrievalHit>();

  const queryEmb = await embedText(query);
  if (queryEmb) {
    const hits = await store.matchByVector(Array.from(queryEmb.vector), limit);
    for (const row of hits) {
      const baseline = rankScore({ salience: row.salience, importance: row.importance, created_at: row.created_at, last_accessed: row.last_accessed });
      const blended  = 0.6 * row.similarity + 0.4 * baseline;
      merged.set(row.id, rowToHit(row, blended));
    }
  }

  const lexical = await store.searchMemoryIndex(query, limit);
  for (const r of lexical) {
    if (!merged.has(r.id)) merged.set(r.id, rowToHit(r));
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Public retrieve() ────────────────────────────────────────────────────────

export async function retrieve(opts: RetrieveOptions): Promise<CategorizedRetrieval> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const ranked = await searchStore(opts.query, limit);

  // Bump salience for the hits we're returning — fire-and-forget so a
  // (possibly networked) write never blocks recall.
  for (const hit of ranked) {
    if (hit.memory_id) void touchMemoryAccess(hit.memory_id).catch(() => { /* best-effort */ });
  }

  return categorize(opts.query, ranked);
}

function categorize(query: string, ranked: RetrievalHit[]): CategorizedRetrieval {
  const memory:      RetrievalHit[] = [];
  const procedures:  RetrievalHit[] = [];
  const insights:    RetrievalHit[] = [];
  const preferences: RetrievalHit[] = [];
  for (const h of ranked) {
    switch (h.type) {
      case 'procedural':
      case 'procedure':
        procedures.push(h); break;
      case 'insight':
      case 'semantic':
        insights.push(h); break;
      case 'preference':
        preferences.push(h); break;
      default:
        memory.push(h);
    }
  }
  return { query, total: ranked.length, memory, procedures, insights, preferences, raw: ranked };
}
