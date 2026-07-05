// Memory storage backend abstraction. Two implementations — sqlite (local,
// default) and supabase (neuroclaw_kb pgvector) — selected by MEMORY_BACKEND.
// `memory-service.ts` delegates to the selected store; the store owns all SQL,
// so the service never recurses back into the store.
import type {
  MemoryIndexRow, MemoryIndexInput, AttachGraphInput, MemoryRelationshipRow,
} from './memory-service';

// MemoryIndexRow.embedding is `Buffer | null`; the recall path needs a plain
// number[]. Omit the buffer field and re-add it as number[].
export type EmbeddedMemoryRow = Omit<MemoryIndexRow, 'embedding'> & { embedding: number[] };

export interface MemoryStats { total: number; lastHour: number; lastDay: number; }

export interface MemoryStore {
  // ── writes ────────────────────────────────────────────────────────────────
  indexMemory(input: MemoryIndexInput): Promise<MemoryIndexRow>;
  updateMemory(id: string, patch: Partial<Pick<MemoryIndexRow, 'type' | 'title' | 'summary' | 'salience' | 'importance'>>): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  touchMemoryAccess(id: string): Promise<void>;
  detachSession(sessionId: string): Promise<void>;
  attachMemoryGraph(input: AttachGraphInput): Promise<{ entities: number; relationships: number }>;

  // ── reads ─────────────────────────────────────────────────────────────────
  getMemoryIndexById(id: string): Promise<MemoryIndexRow | null>;
  searchMemoryIndex(query: string, limit: number): Promise<MemoryIndexRow[]>;          // lexical / FTS
  listEmbeddedMemoryIndex(opts: { limit: number }): Promise<EmbeddedMemoryRow[]>;       // candidate set for cosine
  listMemoryIndex(opts: { limit?: number; type?: string; sessionId?: string }): Promise<MemoryIndexRow[]>;
  matchByVector(queryVector: number[], limit: number): Promise<Array<MemoryIndexRow & { similarity: number }>>; // vector recall (raw cosine ≥0.30)

  // ── dashboard / dedup helpers (replace raw memory_index SQL elsewhere) ──────
  findDuplicateId(opts: { type: string; title: string; agentId: string | null; withinHours: number }): Promise<string | null>;
  getStats(): Promise<MemoryStats>;
  countByType(): Promise<Array<{ type: string; n: number }>>;

  // ── graph queries ───────────────────────────────────────────────────────────
  findMemoriesByEntity(name: string, limit: number): Promise<MemoryIndexRow[]>;
  findRelationshipsForEntity(name: string, limit: number): Promise<MemoryRelationshipRow[]>;
  topEntities(limit: number): Promise<Array<{ name: string; mentions: number; last_seen: string }>>;
}

let cached: MemoryStore | null = null;

/** Resolve the active memory store (lazy, cached). */
export async function getMemoryStore(): Promise<MemoryStore> {
  if (cached) return cached;
  const { config } = await import('../config');
  cached = config.memory.backend === 'supabase'
    ? (await import('./memory-store-supabase')).supabaseStore
    : (await import('./memory-store-sqlite')).sqliteStore;
  return cached;
}

/** Test seam / config hot-reload: drop the cached store so the next call re-selects. */
export function resetMemoryStore(): void { cached = null; }
