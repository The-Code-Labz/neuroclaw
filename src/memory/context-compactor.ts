// Auto context compaction.
// Path-agnostic core: caller passes in a generic { role, text } slice of their
// history; we compute whether to compact, summarize the cold range, retrieve
// relevant memories, and return a splice plan + a synthetic replacement string.
//
// Each chat path (OpenAI / Anthropic API / Claude CLI) wraps this with its
// own typed message shapes — see usage in src/agent/alfred.ts.

import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';
import { estimateTokens } from '../system/langfuse';
import { getClient } from '../agent/openai-client';
import { saveSessionSummaryTool } from './memory-tools';
import { retrieve } from './memory-retriever';

// ── Generic history slice (caller-provided projection) ──────────────────────

export interface HistoryTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
}

export interface CompactionPlan {
  /**
   * Indices into the caller's history array. Replace the inclusive range
   * [from, to] with `replacement`. `from` is always 1 (we never touch the
   * system prompt at index 0). `to` is `history.length - 1 - keepRecent`.
   */
  from:        number;
  to:          number;
  /** The single synthetic message to splice in. Caller wraps it in its own type. */
  replacement: { role: 'system'; text: string };
  /** What got persisted — for telemetry. */
  summaryWritten: { memory_id?: string; vault_path?: string };
  /** Tokens estimated to have been removed (rough). */
  tokensReclaimed: number;
}

// ── Public entry ────────────────────────────────────────────────────────────

export interface MaybeCompactInput {
  history:      HistoryTurn[];
  agentId?:     string | null;
  agentName?:   string | null;
  sessionId?:   string | null;
  /** The new user message about to be appended. Used to retrieve relevant memory. */
  newUserText?: string;
}

/**
 * Returns null when no compaction is needed. Otherwise runs the LLM
 * summarizer + memory retrieval and returns a splice plan.
 */
export async function maybeCompactHistory(input: MaybeCompactInput): Promise<CompactionPlan | null> {
  if (!config.compaction.enabled) return null;
  const { history } = input;
  if (history.length < 2) return null;

  const totalTokens = estimateHistoryTokens(history);
  if (
    history.length          < config.compaction.turnThreshold &&
    totalTokens             < config.compaction.tokenThreshold
  ) {
    return null;
  }

  const keep = Math.max(2, config.compaction.keepRecent);
  // Skip system prompt at index 0; keep tail of size `keep`.
  const from = 1;
  const to   = history.length - 1 - keep;
  if (to < from) return null;  // history too short to compact meaningfully

  const cold = history.slice(from, to + 1);
  const summary = await summarizeRange(cold);
  if (!summary || summary.trim().length < 20) {
    logger.warn('compactor: summarizer returned too little content; skipping');
    return null;
  }

  const relevantBlock = await buildRelevantMemoryBlock(input.newUserText ?? '', input.agentId ?? null);

  // Persist the summary as a session_summary memory (also goes to vault).
  let summaryRef: { memory_id?: string; vault_path?: string } = {};
  try {
    const wrote = await saveSessionSummaryTool({
      summary,
      title:      `Compacted context — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      tags:       ['auto_compact', 'session_summary'],
      importance: 0.6,
      agent_id:   input.agentId ?? null,
      agent_name: input.agentName ?? null,
      session_id: input.sessionId ?? null,
    });
    summaryRef = { memory_id: wrote.memory_id, vault_path: wrote.vault_path };
  } catch (err) {
    logger.warn('compactor: saveSessionSummaryTool failed', { error: (err as Error).message });
  }

  const replacementText =
    `[Prior context (auto-compacted ${cold.length} turns, ~${estimateRangeTokens(cold)} tokens)]\n` +
    summary +
    relevantBlock;

  try {
    logHive('memory_extracted',
      `auto-compacted ${cold.length} turns into a summary`,
      input.agentId ?? undefined,
      {
        source:        'auto_compact',
        turns:         cold.length,
        tokens_before: totalTokens,
        memory_id:     summaryRef.memory_id,
        vault_path:    summaryRef.vault_path,
        session_id:    input.sessionId ?? null,
      });
  } catch { /* hive logging is best-effort */ }

  return {
    from,
    to,
    replacement:     { role: 'system', text: replacementText },
    summaryWritten:  summaryRef,
    tokensReclaimed: estimateRangeTokens(cold),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function estimateHistoryTokens(history: HistoryTurn[]): number {
  let total = 0;
  for (const t of history) total += estimateTokens(t.text);
  return total;
}

function estimateRangeTokens(slice: HistoryTurn[]): number {
  return estimateHistoryTokens(slice);
}

async function summarizeRange(turns: HistoryTurn[]): Promise<string> {
  const transcript = turns
    .map(t => `[${t.role}] ${t.text}`)
    .join('\n\n')
    .slice(0, 24000);  // hard cap to keep the summarizer call bounded

  const model = config.compaction.model ?? config.memory.extractModel ?? config.voidai.model;
  try {
    const resp = await getClient().chat.completions.create({
      model,
      max_tokens:  600,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are compressing a long conversation so an agent can keep working with reduced context. ' +
            'Output a tight Markdown summary that preserves: open questions, unresolved decisions, established preferences, ' +
            'concrete commitments / TODOs, and any constraints or rules the user stated. Skip greetings, repetition, and resolved chitchat. ' +
            'Use short bulleted sections. Aim for 200-400 words. Do not invent.',
        },
        { role: 'user', content: transcript },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    logger.warn('compactor: summarizer LLM failed', { error: (err as Error).message });
    return '';
  }
}

async function buildRelevantMemoryBlock(query: string, agentId: string | null): Promise<string> {
  const limit = Math.max(0, config.compaction.reinjectMemories);
  if (limit === 0 || !query.trim()) return '';
  try {
    const result = await retrieve({ query, agentId, limit });
    if (result.total === 0) return '';
    const lines: string[] = ['', '', '[Relevant memories]'];
    for (const h of result.raw.slice(0, limit)) {
      const tag = h.type ? `[${h.type}]` : '';
      const where = h.vault_path ? ` (${h.vault_path})` : '';
      lines.push(`- ${tag} ${h.title}${where} — ${h.summary.slice(0, 200)}`);
    }
    return lines.join('\n');
  } catch (err) {
    logger.warn('compactor: relevant-memory retrieve failed', { error: (err as Error).message });
    return '';
  }
}
