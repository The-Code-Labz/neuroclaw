import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';
import { getDb } from '../db';
import {
  indexMemory, attachVaultNote, type MemoryIndexInput, type MemoryIndexRow,
} from './memory-service';
import { extract, type ExtractInput, type ExtractedMemory } from './memory-extractor';
import { initialSalience } from './memory-scorer';
import {
  vaultCreateNote, formatVaultNoteContent, type VaultNoteSpec,
} from './vault-client';

// Orchestrates: extractor → dedupe → SQLite index → vault mirror.
// Wrapped in try/catch — never throws into the chat path.

// ── Caps (per session, per rolling hour) ─────────────────────────────────────

function vaultMirrorAllowed(sessionId: string | null): { ok: true } | { ok: false; reason: 'session' | 'hour'; current: number; limit: number } {
  const db = getDb();
  if (sessionId) {
    const sessionCount = (db.prepare(`
      SELECT COUNT(*) as n FROM memory_index
      WHERE session_id = ? AND vault_note_id IS NOT NULL
    `).get(sessionId) as { n: number }).n;
    if (sessionCount >= config.memory.perSessionMax) {
      return { ok: false, reason: 'session', current: sessionCount, limit: config.memory.perSessionMax };
    }
  }
  const hourCount = (db.prepare(`
    SELECT COUNT(*) as n FROM memory_index
    WHERE vault_note_id IS NOT NULL
      AND created_at > datetime('now', '-1 hour')
  `).get() as { n: number }).n;
  if (hourCount >= config.memory.perHourMax) {
    return { ok: false, reason: 'hour', current: hourCount, limit: config.memory.perHourMax };
  }
  return { ok: true };
}

// ── Dedupe (same title + type + agent within last 7 days) ────────────────────

function isDuplicate(memory: ExtractedMemory, agentId: string | null | undefined): boolean {
  const row = getDb().prepare(`
    SELECT id FROM memory_index
    WHERE LOWER(title) = LOWER(?)
      AND type = ?
      AND COALESCE(agent_id,'') = COALESCE(?, '')
      AND created_at > datetime('now', '-7 day')
    LIMIT 1
  `).get(memory.title, memory.type, agentId ?? null);
  return !!row;
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
  vault_path?: string;
  reason?:   string;
  capped?:   { reason: 'session' | 'hour'; current: number; limit: number };
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
    try { logHive('memory_skipped', `extractor skipped (${input.source})`, input.agent_id ?? undefined, { source: input.source }); } catch { /* best-effort */ }
    return { ok: false, reason: 'not_memorable' };
  }
  if (isDuplicate(extracted, input.agent_id)) {
    try { logHive('memory_skipped', `duplicate within 7d: ${extracted.title}`, input.agent_id ?? undefined, { reason: 'duplicate', title: extracted.title }); } catch { /* best-effort */ }
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
    row = indexMemory(indexInput);
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
      const counts = attachMemoryGraph({
        memoryId:      row.id,
        entities:      extracted.entities,
        relationships: extracted.relationships,
      });
      if (counts.entities > 0 || counts.relationships > 0) {
        try { logHive('memory_graph_attached', `${counts.entities} entities, ${counts.relationships} rels`, input.agent_id ?? undefined, { memory_id: row.id, entities: counts.entities, relationships: counts.relationships }); } catch { /* best-effort */ }
      }
    } catch (err) {
      logger.warn('memory-pipeline: graph attach failed', { memory_id: row.id, error: (err as Error).message });
    }
  }

  // Decide whether to mirror to NeuroVault.
  const allowed = vaultMirrorAllowed(input.session_id ?? null);
  if (!allowed.ok) {
    try {
      logHive('memory_capped',
        `vault mirror skipped: ${allowed.reason} cap (${allowed.current}/${allowed.limit})`,
        input.agent_id ?? undefined,
        { reason: allowed.reason, current: allowed.current, limit: allowed.limit, memory_id: row.id });
    } catch { /* best-effort */ }
    return { ok: true, memory_id: row.id, capped: allowed };
  }

  // Mirror to NeuroVault if MCP is enabled. Failure here doesn't fail the row.
  if (config.mcp.enabled && config.mcp.neurovaultUrl) {
    try {
      const noteSpec: VaultNoteSpec = {
        title:      extracted.title,
        type:       extracted.type,
        agent:      input.agent_name ?? undefined,
        importance: extracted.importance,
        tags:       extracted.tags,
        summary:    extracted.summary,
        details:    extracted.content,
        source:     `${input.source}${input.session_id ? ` (session ${input.session_id})` : ''}`,
      };
      const ref = await vaultCreateNote({
        title:     extracted.title,
        type:      extracted.type,
        content:   formatVaultNoteContent(noteSpec),
        agent:     input.agent_name ?? undefined,
        sessionId: input.session_id ?? undefined,
      });
      attachVaultNote(row.id, ref.note_id, ref.note_id);
      try { logHive('memory_extracted', `${extracted.type}: ${extracted.title}`, input.agent_id ?? undefined, { memory_id: row.id, vault_path: ref.note_id, importance: extracted.importance }); } catch { /* best-effort */ }
      return { ok: true, memory_id: row.id, vault_path: ref.note_id };
    } catch (err) {
      logger.warn('memory-pipeline: vault mirror failed', { error: (err as Error).message });
      try { logHive('memory_extracted', `${extracted.type}: ${extracted.title} (vault mirror failed)`, input.agent_id ?? undefined, { memory_id: row.id, importance: extracted.importance, vault_error: (err as Error).message }); } catch { /* best-effort */ }
      return { ok: true, memory_id: row.id, reason: 'vault_mirror_failed' };
    }
  } else {
    try { logHive('memory_extracted', `${extracted.type}: ${extracted.title} (local-only, MCP disabled)`, input.agent_id ?? undefined, { memory_id: row.id, importance: extracted.importance }); } catch { /* best-effort */ }
    return { ok: true, memory_id: row.id };
  }
}

/**
 * Fire-and-forget wrapper — call from chat completion. Never blocks, never
 * throws upstream.
 */
export function ingestExchangeAsync(input: IngestExchange): void {
  ingestExchange(input).catch(err => {
    logger.warn('memory-pipeline: async ingest crashed', { error: (err as Error).message });
  });
}

// Re-export for convenience.
export type { ExtractInput };
