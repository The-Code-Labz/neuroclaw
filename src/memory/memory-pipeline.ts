import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';
import { enqueueJob } from '../db';
import {
  indexMemory, type MemoryIndexInput, type MemoryIndexRow,
} from './memory-service';
import { getMemoryStore } from './memory-store';
import { extract, type ExtractInput, type ExtractedMemory } from './memory-extractor';
import { initialSalience } from './memory-scorer';

// Orchestrates: extractor → dedupe → memory index (+ graph).
// Wrapped in try/catch — never throws into the chat path.

// ── Dedupe (same title + type + agent within last 7 days) ────────────────────

export async function isDuplicateMemory(memory: ExtractedMemory, agentId: string | null | undefined): Promise<boolean> {
  const dup = await (await getMemoryStore()).findDuplicateId({
    type:      memory.type,
    title:     memory.title,
    agentId:   agentId ?? null,
    withinHours: 7 * 24,
  });
  return !!dup;
}

// ── Public entry: ingest a chat exchange ─────────────────────────────────────

export interface IngestExchange {
  source:      'chat' | 'task' | 'agent_result';
  agent_id?:   string | null;
  agent_name?: string | null;
  session_id?: string | null;
  user_text?:  string;
  assistant_text: string;
  context_hint?: string;
}

export interface IngestResult {
  ok:        boolean;
  memory_id?: string;
  reason?:   string;
}

/**
 * Synchronous-style entry point. Most callers should NOT await this — the
 * `ingestExchangeAsync()` wrapper kicks it off as fire-and-forget.
 */
export async function ingestExchange(input: IngestExchange): Promise<IngestResult> {
  let extracted: ExtractedMemory | null = null;
  try {
    extracted = await extract(input);
  } catch (err) {
    logger.warn('memory-pipeline: extract threw', { error: (err as Error).message });
    return { ok: false, reason: 'extractor_error' };
  }
  if (!extracted) {
    try { logHive('memory_skipped', `memory-pipeline: extractor skipped (${input.source})`, input.agent_id ?? undefined, { source: input.source }); } catch { /* best-effort */ }
    return { ok: false, reason: 'not_memorable' };
  }
  if (await isDuplicateMemory(extracted, input.agent_id)) {
    try { logHive('memory_skipped', `memory-pipeline: duplicate within 7d: ${extracted.title}`, input.agent_id ?? undefined, { reason: 'duplicate', title: extracted.title }); } catch { /* best-effort */ }
    return { ok: false, reason: 'duplicate' };
  }

  // Insert into local index first (always — we don't lose data when capped).
  const indexInput: MemoryIndexInput = {
    type:       extracted.type,
    title:      extracted.title,
    summary:    extracted.summary,
    tags:       extracted.tags,
    importance: extracted.importance,
    salience:   initialSalience(extracted.importance),
    agent_id:   input.agent_id ?? null,
    session_id: input.session_id ?? null,
  };
  let row: MemoryIndexRow;
  try {
    row = await indexMemory(indexInput);
  } catch (err) {
    logger.warn('memory-pipeline: SQLite write failed', { error: (err as Error).message });
    return { ok: false, reason: 'index_error' };
  }

  // Graph-lite: persist entities + relationships extracted alongside the memory.
  // Gated on MEMORY_GRAPH_EXTRACT_ENABLED so users can disable without touching
  // the extractor prompt. Best-effort; never blocks the write path.
  if (config.memoryGraph.enabled && (extracted.entities?.length || extracted.relationships?.length)) {
    try {
      const { attachMemoryGraph } = await import('./memory-service');
      const counts = await attachMemoryGraph({
        memoryId:      row.id,
        entities:      extracted.entities,
        relationships: extracted.relationships,
      });
      if (counts.entities > 0 || counts.relationships > 0) {
        try { logHive('memory_graph_attached', `memory-pipeline: ${counts.entities} entities, ${counts.relationships} rels`, input.agent_id ?? undefined, { memory_id: row.id, entities: counts.entities, relationships: counts.relationships }); } catch { /* best-effort */ }
      }
    } catch (err) {
      logger.warn('memory-pipeline: graph attach failed', { memory_id: row.id, error: (err as Error).message });
    }
  }

  try { logHive('memory_extracted', `memory-pipeline: ${extracted.type}: ${extracted.title}`, input.agent_id ?? undefined, { memory_id: row.id, importance: extracted.importance }); } catch { /* best-effort */ }
  return { ok: true, memory_id: row.id };
}

/**
 * Queue-based fire-and-forget wrapper — call from chat completion. Never blocks,
 * never throws upstream. Memory extraction runs in the job queue worker so it
 * does not compete with active chat threads for LLM quota / event loop time.
 */
export function ingestExchangeAsync(input: IngestExchange): void {
  enqueueJob('memory_extract', {
    source: input.source,
    agent_id: input.agent_id,
    agent_name: input.agent_name,
    session_id: input.session_id,
    user_text: input.user_text,
    assistant_text: input.assistant_text,
    context_hint: input.context_hint,
  }, 4); // slightly lower priority than TTS so voice stays snappy
}

// Re-export for convenience.
export type { ExtractInput };
