// Agent-facing memory helpers — backing for the LLM tools registered in alfred.ts.
// All paths are wrapped so a vault outage cannot crash the chat loop.

import { config } from '../config';
import { logHive } from '../system/hive-mind';
import {
  indexMemory, listMemoryIndex, type MemoryIndexRow,
} from './memory-service';
import { initialSalience, clamp01 } from './memory-scorer';
import { retrieve, type CategorizedRetrieval } from './memory-retriever';

// ── In-memory prefetch cache for memory context blocks ───────────────────────
// Reduces time-to-first-chunk by caching retrieval results across turns.
// Key: agentId + query prefix; TTL: 45s.

interface MemoryCacheEntry {
  promise: Promise<string>;
  ts: number;
}

const _memoryCtxCache = new Map<string, MemoryCacheEntry>();
const MEMORY_CTX_TTL_MS = 45_000;

function _cacheKey(agentId: string | null | undefined, query: string): string {
  return `${agentId ?? 'none'}:${query.slice(0, 80).toLowerCase()}`;
}

function _pruneMemoryCache(): void {
  const cutoff = Date.now() - MEMORY_CTX_TTL_MS;
  for (const [k, v] of _memoryCtxCache) {
    if (v.ts < cutoff) _memoryCtxCache.delete(k);
  }
}

function _buildMemoryContextBlockInner(opts: {
  query:    string;
  agentId?: string | null;
  limit?:   number;
}): Promise<string> {
  const cfg = config.memory;
  if (!cfg.preinjectEnabled) return Promise.resolve('');
  const limit = opts.limit ?? cfg.preinjectMax;
  if (limit <= 0 || !opts.query.trim()) return Promise.resolve('');
  return retrieve({ query: opts.query, agentId: opts.agentId ?? null, limit })
    .then((result) => {
      if (result.total === 0) return '';
      const lines: string[] = ['', '---', '## Relevant long-term memory'];
      const groupBy: { label: string; key: keyof typeof result }[] = [
        { label: 'Procedures',  key: 'procedures' },
        { label: 'Insights',    key: 'insights' },
        { label: 'Preferences', key: 'preferences' },
        { label: 'Other',       key: 'memory' },
      ];
      for (const g of groupBy) {
        const arr = (result[g.key] as Array<{ title: string; summary: string; vault_path?: string | null }> | undefined) ?? [];
        if (arr.length === 0) continue;
        lines.push('');
        lines.push(`### ${g.label}`);
        for (const h of arr) {
          lines.push(`- **${h.title}** — ${(h.summary || '').slice(0, 160)}`);
        }
      }
      lines.push('');
      lines.push('Cite these by title when they apply. Prefer reusing existing procedures over re-deriving them. ' +
        'Call `search_memory` / `write_vault_note` for things this preview missed.');
      return lines.join('\n');
    })
    .catch(() => '');
}

/**
 * Prefetch memory context in the background so retrieval overlaps with
 * routing / setup work. Call this as early as possible (e.g. when the user
 * message arrives). The promise is cached for 45s so follow-up turns reuse it.
 */
export function prefetchMemoryContext(opts: {
  query:    string;
  agentId?: string | null;
  limit?:   number;
}): void {
  _pruneMemoryCache();
  const key = _cacheKey(opts.agentId, opts.query);
  if (_memoryCtxCache.has(key)) return;
  const promise = _buildMemoryContextBlockInner(opts);
  _memoryCtxCache.set(key, { promise, ts: Date.now() });
}

export async function buildMemoryContextBlock(opts: {
  query:    string;
  agentId?: string | null;
  limit?:   number;
}): Promise<string> {
  _pruneMemoryCache();
  const key = _cacheKey(opts.agentId, opts.query);
  const entry = _memoryCtxCache.get(key);
  if (entry) {
    return entry.promise;
  }
  const promise = _buildMemoryContextBlockInner(opts);
  _memoryCtxCache.set(key, { promise, ts: Date.now() });
  return promise;
}

// ── search_memory ────────────────────────────────────────────────────────────

export async function searchMemoryTool(opts: {
  query:    string;
  limit?:   number;
  agentId?: string | null;
}): Promise<CategorizedRetrieval> {
  return retrieve({ query: opts.query, limit: opts.limit, agentId: opts.agentId });
}

// ── write_vault_note ─────────────────────────────────────────────────────────

export interface WriteVaultNoteInput {
  title:       string;
  type:        string;            // procedural | insight | episodic | preference | semantic | project | …
  summary:     string;             // 1-2 sentences
  content?:    string;             // optional richer body
  tags?:       string[];
  importance?: number;             // 0–1, defaults to 0.7
  agent_id?:   string | null;
  agent_name?: string | null;
  session_id?: string | null;
  source?:     string;
  vault?:      string;
}

export async function writeVaultNoteTool(input: WriteVaultNoteInput): Promise<{ ok: boolean; memory_id?: string; vault_path?: string; error?: string }> {
  if (!input.title || !input.type || !input.summary) {
    return { ok: false, error: 'title, type, summary are required' };
  }
  const importance = clamp01(input.importance ?? 0.7);

  // Local index
  let row: MemoryIndexRow;
  try {
    row = await indexMemory({
      type:       input.type,
      title:      input.title,
      summary:    input.summary,
      tags:       input.tags ?? [],
      importance,
      salience:   initialSalience(importance),
      agent_id:   input.agent_id ?? null,
      session_id: input.session_id ?? null,
    });
  } catch (err) {
    return { ok: false, error: `index_error: ${(err as Error).message}` };
  }

  try { logHive('memory_extracted', `agent wrote ${input.type}: ${input.title}`, input.agent_id ?? undefined, { memory_id: row.id, source: 'agent_tool' }); } catch { /* best-effort */ }
  return { ok: true, memory_id: row.id };
}

// ── save_session_summary ─────────────────────────────────────────────────────

export async function saveSessionSummaryTool(input: {
  summary:     string;
  title?:      string;
  tags?:       string[];
  importance?: number;
  agent_id?:   string | null;
  agent_name?: string | null;
  session_id?: string | null;
}): Promise<{ ok: boolean; memory_id?: string; vault_path?: string; error?: string }> {
  const title = input.title?.trim() || `Session summary — ${new Date().toISOString().slice(0, 10)}`;
  return writeVaultNoteTool({
    title,
    type:       'session_summary',
    summary:    input.summary,
    tags:       input.tags ?? ['session', 'summary'],
    importance: input.importance ?? 0.65,
    agent_id:   input.agent_id,
    agent_name: input.agent_name,
    session_id: input.session_id,
    source:     `session_summary${input.session_id ? ` (session ${input.session_id})` : ''}`,
  });
}

// ── compact_context (P2c will add auto-trigger; this is the manual entry) ────

export async function compactContextTool(input: {
  conversation: string;        // serialized recent turns the agent wants to compact
  agent_id?:    string | null;
  agent_name?:  string | null;
  session_id?:  string | null;
}): Promise<{ ok: boolean; summary?: string; memory_id?: string; vault_path?: string; error?: string }> {
  // For P2b we do a structural compact: caller provides the summary; P2c will
  // run the LLM-based summarizer + auto-trigger when context exceeds threshold.
  if (!input.conversation || input.conversation.trim().length < 100) {
    return { ok: false, error: 'conversation too short to compact' };
  }
  const summary = input.conversation.length > 1500
    ? input.conversation.slice(0, 1500) + '…'
    : input.conversation;
  const wrote = await saveSessionSummaryTool({
    summary,
    agent_id:   input.agent_id,
    agent_name: input.agent_name,
    session_id: input.session_id,
  });
  return { ...wrote, summary };
}

// ── retrieve_relevant_memory (alias of search_memory; explicit name) ─────────

export async function retrieveRelevantMemoryTool(opts: {
  query:    string;
  limit?:   number;
  agentId?: string | null;
}): Promise<CategorizedRetrieval> {
  return searchMemoryTool(opts);
}

// ── list (used by dashboard panel + agent prompt context) ────────────────────

export function listRecentMemoriesTool(opts: { limit?: number; type?: string; sessionId?: string } = {}): Promise<MemoryIndexRow[]> {
  return listMemoryIndex(opts);
}
