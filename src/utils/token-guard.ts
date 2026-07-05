/**
 * token-guard.ts — Unified token estimation and budget enforcement
 *
 * Centralises all pre-call token logic that was previously copy-pasted into
 * each provider function in alfred.ts.  Every LLM call site should call
 * `enforceTokenBudget` before dispatching to the provider, and
 * `logTokenBudgetHeader` to emit a structured INFO log line.
 *
 * Environment variables
 * ─────────────────────
 * MAX_INPUT_TOKENS            — global hard ceiling (default 300 000)
 * TOKEN_TRUNCATE_STRATEGY     — 'throw' | 'truncate_oldest' | 'truncate_tools'
 *                               (default 'truncate_oldest')
 * AGENT_TOKEN_BUDGET_<NAME>   — per-agent override, e.g.
 *                               AGENT_TOKEN_BUDGET_ORACLE=200000
 */

import { logger } from './logger';

// ─── Estimation ──────────────────────────────────────────────────────────────

/**
 * Rough token estimate: ~4 chars per token (no external dep).
 * Identical to the function already in src/system/langfuse.ts so both can
 * coexist without diverging.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Stringify any value to a token-countable string. */
function toText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

export interface MessageTokenBreakdown {
  histTokens:   number;
  toolTokens:   number;
  systemTokens: number;
  totalEst:     number;
}

/**
 * Estimate tokens for an entire message history plus optional tool schemas.
 * Handles string content, content arrays (vision / tool_calls), and raw
 * objects (Anthropic-style tool_use / tool_result blocks).
 */
export function estimateMessagesTokens(
  messages: Array<{ role?: string; content: unknown }>,
  tools?: unknown[],
  systemPrompt?: string,
): MessageTokenBreakdown {
  let histTokens   = 0;
  let systemTokens = 0;

  for (const m of messages) {
    const text = toText(m.content);
    const est  = estimateTokens(text);
    if (m.role === 'system') {
      systemTokens += est;
    } else {
      histTokens += est;
    }
  }

  // Explicit system prompt (e.g. Anthropic `system` param) counted separately
  if (systemPrompt) {
    systemTokens += estimateTokens(systemPrompt);
  }

  const toolTokens = tools && tools.length > 0
    ? Math.round(JSON.stringify(tools).length / 4)
    : 0;

  return {
    histTokens,
    toolTokens,
    systemTokens,
    totalEst: histTokens + toolTokens + systemTokens,
  };
}

// ─── Budget resolution ───────────────────────────────────────────────────────

const DEFAULT_BUDGET = 300_000;

/**
 * Resolve the token budget for an agent.
 * Resolution order:
 *   1. AGENT_TOKEN_BUDGET_<NAME_UPPERCASE>  (per-agent env var)
 *   2. MAX_INPUT_TOKENS                     (global env var)
 *   3. DEFAULT_BUDGET (300 000)
 */
export function getAgentTokenBudget(agentId?: string, agentName?: string): number {
  if (agentName) {
    const key = `AGENT_TOKEN_BUDGET_${agentName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const v = process.env[key];
    if (v) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const global = process.env.MAX_INPUT_TOKENS;
  if (global) {
    const n = parseInt(global, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_BUDGET;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

/**
 * Emit a structured INFO log line before every LLM call.
 * Format (structured JSON via logger):
 *   [TOKEN BUDGET] agent=<name> provider=<p> model=<m>
 *                  est=<n>/<budget> (<pct>%) hist=<msgs> tools=<n>
 */
export function logTokenBudgetHeader(
  provider:   string,
  agentId:    string | undefined,
  agentName:  string | undefined,
  totalEst:   number,
  budget:     number,
  model:      string,
  historyLen: number,
  toolCount:  number,
): void {
  const pct = budget > 0 ? Math.round((totalEst / budget) * 100) : 0;
  const label = agentName ?? agentId ?? 'unknown';
  logger.info(
    `[TOKEN BUDGET] agent=${label} provider=${provider} model=${model} est=${totalEst}/${budget} (${pct}%) hist=${historyLen} tools=${toolCount}`,
    {
      event:      'token_budget',
      agent:      label,
      agentId,
      provider,
      model,
      estimated:  totalEst,
      budget,
      pct,
      historyLen,
      toolCount,
    },
  );
}

// ─── Truncation strategies ───────────────────────────────────────────────────

export type TruncateStrategy = 'throw' | 'truncate_oldest' | 'truncate_tools';

/**
 * Drop oldest non-system messages until the total estimated token count
 * falls below budget, always preserving:
 *   - message[0] if it is the system message
 *   - the 2 most recent turns (so the agent never loses its last exchange)
 *
 * Returns the (possibly shortened) history and whether truncation occurred.
 */
function truncateOldest(
  messages: Array<{ role?: string; content: unknown }>,
  tools:     unknown[],
  systemPrompt: string | undefined,
  budget:    number,
): { history: Array<{ role?: string; content: unknown }>; truncated: boolean } {
  let working = [...messages];
  let truncated = false;

  // Identify the floor index: never drop below 3 messages total
  //   index 0  → system message (if present)
  //   index -2 → second-to-last message (preserve last 2 turns)
  const minLen = Math.min(3, working.length);

  while (working.length > minLen) {
    const { totalEst } = estimateMessagesTokens(working, tools, systemPrompt);
    if (totalEst <= budget) break;

    // Find the oldest droppable message: skip role=system at index 0
    const dropIdx = working[0]?.role === 'system' ? 1 : 0;
    if (dropIdx >= working.length - 2) break; // protect last 2

    working.splice(dropIdx, 1);
    truncated = true;
  }

  return { history: working, truncated };
}

/**
 * Drop tool schema objects from the tools array one-by-one (cheapest first
 * by JSON size) until under budget, then fall back to truncate_oldest if
 * still over.
 */
function truncateTools(
  messages: Array<{ role?: string; content: unknown }>,
  tools:     unknown[],
  systemPrompt: string | undefined,
  budget:    number,
): { history: Array<{ role?: string; content: unknown }>; tools: unknown[]; truncated: boolean } {
  let workingTools = [...tools];
  let truncated = false;

  // Sort tools by schema size descending so we drop biggest first
  workingTools.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);

  while (workingTools.length > 0) {
    const { totalEst } = estimateMessagesTokens(messages, workingTools, systemPrompt);
    if (totalEst <= budget) break;
    workingTools.pop();
    truncated = true;
  }

  // If still over budget after all tools dropped, truncate history
  const { totalEst } = estimateMessagesTokens(messages, workingTools, systemPrompt);
  if (totalEst > budget) {
    const r = truncateOldest(messages, workingTools, systemPrompt, budget);
    return { history: r.history, tools: workingTools, truncated: r.truncated || truncated };
  }

  return { history: messages, tools: workingTools, truncated };
}

// ─── Main API ────────────────────────────────────────────────────────────────

export interface EnforceTokenBudgetOpts {
  provider:         string;
  agentId?:         string;
  agentName?:       string;
  model:            string;
  history:          Array<{ role?: string; content: unknown }>;
  tools?:           unknown[];
  systemPrompt?:    string;
  truncateStrategy?: TruncateStrategy;
}

export interface EnforceTokenBudgetResult extends MessageTokenBreakdown {
  budget:    number;
  truncated: boolean;
  history:   Array<{ role?: string; content: unknown }>;
  tools:     unknown[];
}

/**
 * Compute token estimates, apply the configured strategy if over budget,
 * and return the (possibly mutated) history and tools.
 *
 * Callers must replace their history/tools arrays with the returned values
 * when `truncated === true`.
 */
export function enforceTokenBudget(opts: EnforceTokenBudgetOpts): EnforceTokenBudgetResult {
  const {
    provider,
    agentId,
    agentName,
    model,
    systemPrompt,
  } = opts;

  const tools    = opts.tools   ?? [];
  const strategy = opts.truncateStrategy
    ?? ((process.env.TOKEN_TRUNCATE_STRATEGY as TruncateStrategy | undefined) ?? 'truncate_oldest');

  const budget = getAgentTokenBudget(agentId, agentName);
  const breakdown = estimateMessagesTokens(opts.history, tools, systemPrompt);

  if (breakdown.totalEst <= budget) {
    return { ...breakdown, budget, truncated: false, history: opts.history, tools };
  }

  // Over budget — apply strategy
  if (strategy === 'throw') {
    const label = agentName ?? agentId ?? 'unknown';
    logger.error(
      `Token hard limit exceeded — aborting ${provider} turn`,
      { estimated: breakdown.totalEst, budget, agentId, model, historyMessages: opts.history.length, toolCount: tools.length },
    );
    throw new Error(
      `[${label}] Token budget exceeded on ${provider}: ~${breakdown.totalEst} tokens (limit: ${budget}). ` +
      `Use compact_context or start a fresh session.`,
    );
  }

  if (strategy === 'truncate_tools') {
    const r = truncateTools(opts.history, tools, systemPrompt, budget);
    const final = estimateMessagesTokens(r.history, r.tools, systemPrompt);
    if (r.truncated) {
      logger.warn(
        `[TOKEN BUDGET] Over budget — truncated tools/history for ${provider}`,
        { provider, agentId, agentName, model, before: breakdown.totalEst, after: final.totalEst, budget },
      );
    }
    return { ...final, budget, truncated: r.truncated, history: r.history, tools: r.tools };
  }

  // Default: truncate_oldest
  const r = truncateOldest(opts.history, tools, systemPrompt, budget);
  const final = estimateMessagesTokens(r.history, tools, systemPrompt);
  if (r.truncated) {
    logger.warn(
      `[TOKEN BUDGET] Over budget — oldest messages dropped for ${provider}`,
      { provider, agentId, agentName, model, before: breakdown.totalEst, after: final.totalEst, budget, remaining: r.history.length },
    );
  }
  return { ...final, budget, truncated: r.truncated, history: r.history, tools };
}
