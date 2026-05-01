// Agent-facing memory helpers — backing for the LLM tools registered in alfred.ts.
// All paths are wrapped so a vault outage cannot crash the chat loop.

import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';
import {
  indexMemory, attachVaultNote, listMemoryIndex, type MemoryIndexRow,
} from './memory-service';
import { initialSalience, clamp01 } from './memory-scorer';
import { retrieve, type CategorizedRetrieval } from './memory-retriever';
import {
  vaultSearch, vaultCreateNote, formatVaultNoteContent, type VaultNoteSpec,
} from './vault-client';

// ── search_memory ────────────────────────────────────────────────────────────

export async function searchMemoryTool(opts: {
  query:    string;
  limit?:   number;
  agentId?: string | null;
}): Promise<CategorizedRetrieval> {
  return retrieve({ query: opts.query, limit: opts.limit, agentId: opts.agentId });
}

// ── search_vault (vault-only) ────────────────────────────────────────────────

export async function searchVaultTool(opts: {
  query:  string;
  limit?: number;
  vault?: string;
}): Promise<unknown[]> {
  if (!config.mcp.enabled) return [];
  return vaultSearch({ query: opts.query, limit: opts.limit, vault: opts.vault });
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

  // 1. Local index
  let row: MemoryIndexRow;
  try {
    row = indexMemory({
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

  // 2. Vault mirror (best-effort)
  if (config.mcp.enabled && config.mcp.neurovaultUrl) {
    try {
      const noteSpec: VaultNoteSpec = {
        title:      input.title,
        type:       input.type,
        agent:      input.agent_name ?? undefined,
        importance,
        tags:       input.tags ?? [],
        summary:    input.summary,
        details:    input.content,
        source:     input.source ?? `agent_write${input.session_id ? ` (session ${input.session_id})` : ''}`,
      };
      const ref = await vaultCreateNote({
        title:   input.title,
        type:    input.type,
        content: formatVaultNoteContent(noteSpec),
        vault:   input.vault,
      });
      attachVaultNote(row.id, ref.note_id, ref.note_id);
      try { logHive('memory_extracted', `agent wrote ${input.type}: ${input.title}`, input.agent_id ?? undefined, { memory_id: row.id, vault_path: ref.note_id, source: 'agent_tool' }); } catch { /* best-effort */ }
      return { ok: true, memory_id: row.id, vault_path: ref.note_id };
    } catch (err) {
      logger.warn('write_vault_note: vault mirror failed', { error: (err as Error).message });
      return { ok: true, memory_id: row.id, error: `vault_mirror_failed: ${(err as Error).message}` };
    }
  }
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

export function listRecentMemoriesTool(opts: { limit?: number; type?: string; sessionId?: string } = {}): MemoryIndexRow[] {
  return listMemoryIndex(opts);
}
