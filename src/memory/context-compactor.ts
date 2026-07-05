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
import { bgChatCompletion } from '../agent/openai-client';
import { saveSessionSummaryTool } from './memory-tools';
import { retrieve } from './memory-retriever';
import { isTurnFinished } from '../agent/turn-state';

// ── Model context-window registry ───────────────────────────────────────────
// Maps model name prefixes → token capacity. Compaction fires at 75% so agents
// with large windows aren't cut off mid-thought.
// OpenRouter names arrive as "provider/model" — we strip the prefix before lookup.
const MODEL_CTX_WINDOWS: Record<string, number> = {
  // VoidAI / OpenAI
  'gpt-5.1':        1_000_000,
  'gpt-5.5':          272_000,
  'gpt-5.5-pro':      272_000,
  'gpt-5.4-mini':     400_000,
  'gpt-5.4':          272_000,
  'gpt-5.4-pro':      272_000,
  'gpt-5.2':          272_000,
  'gpt-5':            200_000,
  'gpt-4.1':          128_000,
  'gpt-4.1-mini':     128_000,
  'gpt-4.1-nano':      64_000,
  'gpt-4o':           128_000,
  'gpt-4o-mini':      128_000,
  'gpt-4-turbo':      128_000,
  'gpt-4':              8_192,
  'o1':               200_000,
  'o3':               200_000,
  'o4-mini':          200_000,
  // Anthropic
  'claude-opus-4':    200_000,
  'claude-sonnet-4':  200_000,
  'claude-haiku-4':   200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku':  200_000,
  'claude-3-opus':    200_000,
  'claude-3-sonnet':  200_000,
  'claude-3-haiku':   200_000,
  // Google Gemini
  'gemini-3.1-flash-lite': 1_000_000,
  'gemini-2.5-pro':        1_000_000,
  'gemini-2.5-flash':      1_000_000,
  'gemini-2.0-flash':      1_000_000,
  'gemini-1.5-pro':        1_000_000,
  'gemini-1.5-flash':      1_000_000,
  // Ollama / local
  'llama3':           128_000,
  'llama3.2':         128_000,
  'llama3.1':         128_000,
  'mistral':           32_000,
  'mixtral':           32_000,
  'deepseek':         128_000,
  'qwen':             128_000,
  'phi':              128_000,
  // xAI / Grok
  'grok-4':         256_000,
};

/**
 * Returns the context window size for a model, stripping OpenRouter-style
 * "provider/model-name" prefixes before lookup. Falls back to `fallback`.
 */
function resolveContextWindow(model: string | undefined, fallback: number): number {
  if (!model) return fallback;
  const bare  = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const lower = bare.toLowerCase();
  let best = '';
  for (const key of Object.keys(MODEL_CTX_WINDOWS)) {
    if (lower.startsWith(key) && key.length > best.length) best = key;
  }
  return best ? MODEL_CTX_WINDOWS[best] : fallback;
}

// ── Generic history slice (caller-provided projection) ──────────────────────

export interface HistoryTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
}

export interface CompactionPlan {
  /**
   * Indices into the caller's history array. Replace the inclusive range
   * [from, to] with `replacement`. `from` is always 1 (we never touch the
   * system prompt at index 0).
   */
  from:        number;
  to:          number;
  /** The single synthetic message to splice in. Caller wraps it in its own type. */
  replacement: { role: 'system'; text: string };
  /** What got persisted — for telemetry. */
  summaryWritten: { memory_id?: string; vault_path?: string };
  /** Tokens estimated to have been removed (rough). */
  tokensReclaimed: number;
  /** Tokens estimated to remain after compaction. */
  tokensRemaining: number;
}

// ── Public entry ────────────────────────────────────────────────────────────

export interface MaybeCompactInput {
  history:      HistoryTurn[];
  agentId?:     string | null;
  agentName?:   string | null;
  sessionId?:   string | null;
  /** The new user message about to be appended. Used to retrieve relevant memory. */
  newUserText?: string;
  /** The model being used — drives per-model context-window lookup. */
  model?:       string;
}

/**
 * Returns null when no compaction is needed. Otherwise runs the LLM
 * summarizer + memory retrieval and returns a splice plan.
 *
 * Ratio-based logic (default):
 *   trigger  = contextWindow * triggerRatio  (e.g. 200k * 0.70 = 140k)
 *   target   = contextWindow * targetRatio   (e.g. 200k * 0.75 = 150k)
 *
 * We remove the oldest possible turns so that remaining tokens ≈ target,
 * but we always keep at least `keepRecentMin` turns and never compact
 * more than `maxCompactTurns` in a single pass.
 */
export async function maybeCompactHistory(input: MaybeCompactInput): Promise<CompactionPlan | null> {
  if (!config.compaction.enabled) return null;
  // v3.2: never compact mid-turn. The agent loop bumps turn-state on each
  // iteration; isTurnFinished() returns true only when the loop has marked
  // done/paused/stopped (or no turn is registered at all — e.g. when the
  // post-turn scheduled callback runs after the loop has cleared its entry).
  if (input.sessionId && !isTurnFinished(input.sessionId)) {
    logger.debug('compactor: skipped, turn still in progress', { sessionId: input.sessionId });
    return null;
  }
  const { history } = input;
  if (history.length < 2) return null;

  const totalTokens = estimateHistoryTokens(history);
  const cw = resolveContextWindow(input.model, config.compaction.contextWindow);

  let shouldCompact: boolean;
  let targetTokens: number;
  let keepRecent: number;

  if (cw > 0) {
    // Ratio-based mode
    const triggerTokens = Math.floor(cw * config.compaction.triggerRatio);
    targetTokens = Math.floor(cw * config.compaction.targetRatio);
    shouldCompact = totalTokens > triggerTokens;
    keepRecent = Math.max(config.compaction.keepRecentMin, config.compaction.keepRecent);
  } else {
    // Legacy absolute-threshold fallback
    shouldCompact =
      history.length >= config.compaction.turnThreshold ||
      totalTokens >= config.compaction.tokenThreshold;
    targetTokens = config.compaction.tokenThreshold;
    keepRecent = Math.max(2, config.compaction.keepRecent);
  }

  if (!shouldCompact) return null;

  // Skip system prompt at index 0; keep tail of size `keepRecent`.
  const from = 1;

  // Determine how many turns we need to cut to get under targetTokens.
  let to = history.length - 1 - keepRecent;
  if (to < from) {
    // History too short to compact meaningfully; but we're over threshold,
    // so force a minimal compaction (keep only system + last user/assistant).
    to = from;
  }

  // Ratio mode: walk backwards from `to` to find the cut that lands us
  // closest to `targetTokens` without going under `keepRecentMin`.
  if (cw > 0) {
    let removed = 0;
    for (let i = from; i <= to; i++) {
      removed += estimateTokens(history[i].text);
    }
    // If removing [from..to] still leaves us above target, we need to eat
    // into the keepRecent buffer (up to keepRecentMin).
    let remaining = totalTokens - removed;
    if (remaining > targetTokens) {
      const overage = remaining - targetTokens;
      // Try to reclaim more from the keepRecent zone, but never below keepRecentMin.
      let extraRemoved = 0;
      let extraIdx = to + 1;
      while (
        extraIdx < history.length - config.compaction.keepRecentMin &&
        (history.length - extraIdx) > config.compaction.keepRecentMin &&
        extraRemoved < overage
      ) {
        extraRemoved += estimateTokens(history[extraIdx].text);
        extraIdx++;
      }
      to = extraIdx - 1;
      remaining = totalTokens - removed - extraRemoved;
    }

    // Cap single-pass compaction to maxCompactTurns.
    const maxCompact = config.compaction.maxCompactTurns;
    if (to - from + 1 > maxCompact) {
      to = from + maxCompact - 1;
      remaining = totalTokens - estimateRangeTokens(history.slice(from, to + 1));
    }

    // If after all that we're still above target, we'll compact what we can
    // and let the next turn trigger again. This avoids giant summarizer calls.
    targetTokens = remaining;
  }

  const cold = history.slice(from, to + 1);
  if (cold.length === 0) return null;

  const summary = await summarizeRange(cold);
  if (!summary || summary.trim().length < 20) {
    logger.warn('compactor: summarizer returned too little content; skipping');
    return null;
  }

  const [workingState, relevantBlock] = await Promise.all([
    extractWorkingState(history, keepRecent),
    buildRelevantMemoryBlock(input.newUserText ?? '', input.agentId ?? null),
  ]);

  // Persist the summary as a session_summary memory (also goes to vault).
  let summaryRef: { memory_id?: string; vault_path?: string } = {};
  try {
    const wrote = await saveSessionSummaryTool({
      summary,
      title:      `Compacted context — ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
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

  const tokensReclaimed = estimateRangeTokens(cold);
  const tokensRemaining = totalTokens - tokensReclaimed;

  const replacementText =
    (workingState ? workingState + '\n' : '') +
    `[Prior context (auto-compacted ${cold.length} turns, ~${tokensReclaimed} tokens)]\n` +
    summary +
    relevantBlock;

  try {
    logHive('memory_extracted',
      `auto-compacted ${cold.length} turns into a summary`,
      input.agentId ?? undefined,
      {
        source:                  'auto_compact',
        turns:                   cold.length,
        tokens_before:           totalTokens,
        tokens_reclaimed:        tokensReclaimed,
        tokens_remaining:        tokensRemaining,
        memory_id:               summaryRef.memory_id,
        vault_path:              summaryRef.vault_path,
        session_id:              input.sessionId ?? null,
        working_state_extracted: workingState.length > 0,
      });
  } catch { /* hive logging is best-effort */ }

  return {
    from,
    to,
    replacement:     { role: 'system', text: replacementText },
    summaryWritten:  summaryRef,
    tokensReclaimed,
    tokensRemaining,
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
    .slice(0, 64000);  // hard cap to keep the summarizer call bounded

  const model = config.compaction.model ?? config.background.model ?? config.voidai.model;
  try {
    const resp = await bgChatCompletion({
      model,
      max_tokens:  2000,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are compressing a long conversation so an agent can keep working with reduced context. ' +
            'Output a tight Markdown summary that preserves: open questions, unresolved decisions, established preferences, ' +
            'concrete commitments / TODOs, and any constraints or rules the user stated. Skip greetings, repetition, and resolved chitchat. ' +
            'Use short bulleted sections. Aim for 400-800 words. Do not invent.',
        },
        { role: 'user', content: transcript },
      ],
    }, { label: 'compactor:summarize' });
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
      const where = h.memory_id ? ` (${h.memory_id})` : '';
      lines.push(`- ${tag} ${h.title}${where} — ${h.summary.slice(0, 200)}`);
    }
    return lines.join('\n');
  } catch (err) {
    logger.warn('compactor: relevant-memory retrieve failed', { error: (err as Error).message });
    return '';
  }
}

async function extractWorkingState(history: HistoryTurn[], keep: number): Promise<string> {
  if (!config.compaction.extractWorkingState) return '';

  // Warm tail + 4 turns before the splice point — where current state lives.
  const to          = history.length - 1 - keep;
  const windowStart = Math.max(1, to - 3);
  const window      = history.slice(windowStart);
  if (window.length === 0) return '';

  const transcript = window
    .map(t => `[${t.role}] ${t.text}`)
    .join('\n\n')
    .slice(0, 16000);

  const model = config.compaction.model ?? config.background.model ?? config.voidai.model;
  try {
    const resp = await bgChatCompletion({
      model,
      max_tokens:  300,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are extracting the active working state from a conversation so an agent can ' +
            'resume without losing its place. Output ONLY this block (no prose, no explanation):\n\n' +
            'Task: <what the agent is currently working on — one sentence>\n' +
            'Last completed: <most recent step finished — one sentence, or "none">\n' +
            'Next action: <the immediate next step — one sentence>\n' +
            'Blockers: <anything blocking progress, or "none">\n\n' +
            'If there is no active task in progress, output exactly: NO_ACTIVE_TASK',
        },
        { role: 'user', content: transcript },
      ],
    }, { label: 'compactor:working-state' });
    const raw = resp.choices[0]?.message?.content?.trim() ?? '';
    if (!raw || raw === 'NO_ACTIVE_TASK') return '';
    return `[Active Task — resumption state]\n${raw}\nContext: A summary of all prior work in this session is in [Prior context] immediately below — review it before continuing.`;
  } catch (err) {
    logger.warn('compactor: extractWorkingState failed', { error: (err as Error).message });
    return '';
  }
}
