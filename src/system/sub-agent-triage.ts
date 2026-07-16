// src/system/sub-agent-triage.ts
// Sub-agent model triage — two-provider system (NATIVE gateways):
//
//   code tasks  → kimi     (Kimi for Coding, Moonshot — OpenAI-compatible)
//   everything  → minimax  (MiniMax direct  — OpenAI-compatible)
//
// Both reuse the existing main-agent keys (KIMI_ANTHROPIC_KEY / MINIMAX_ANTHROPIC_KEY).
// This replaces the prior ollama (Kimi K2.6 cloud) + litellm (MiniMax via proxy)
// routing: native is fewer hops, more reliable tool-calling, and trackable via the
// Kimi/MiniMax 5h/weekly usage panels. Trade-off: coding sub-agents now share the
// Moonshot quota with the main Kimi agents (Jarvis/FRIDAY) — watch the Kimi window.

import { logger } from '../utils/logger';
import { getDb } from '../db';
import { resolveFamilyModel } from './subagent-providers-store';

export type SubAgentProvider  = 'kimi' | 'minimax';
export type SubAgentComplexity = 'simple' | 'complex' | 'frontier';

export interface SubAgentTriage {
  provider:   SubAgentProvider;
  model:      string;
  complexity: SubAgentComplexity;
  family:     string;   // provider family for quota-fallback routing
  codeScore:  number;   // 0 when kindOverride bypassed scoring
  proseScore: number;   // 0 when kindOverride bypassed scoring
}

// Strong code signals — explicit programming/devops terminology.
// NOTE: multi-word tokens rely on substring matching via taskText.includes(kw).
//       Do NOT add bare 'yaml' (dual-use: "explain the YAML config") or bare
//       'migration' (dual-use: "discuss the migration strategy") — both are
//       false-positive magnets. Use 'schema migration' / 'database migration' instead.
const CODE_KEYWORDS = [
  'typescript', 'javascript', 'python', 'rust', 'golang',
  'npm', 'pnpm', 'yarn', 'pip', 'cargo',
  'git commit', 'git push', 'git rebase', 'merge conflict',
  'lint', 'eslint', 'prettier', 'tsc', 'mypy',
  'dockerfile', 'docker-compose', 'kubernetes',
  'ci pipeline', 'github actions', 'workflow yml',
  'endpoint', 'api route', 'middleware', 'handler',
  'schema migration', 'database migration', 'sqlite', 'postgres',
  'regex', 'stack trace', 'exception', 'null pointer',
  'compile error', 'type error', 'syntax error',
  'refactor', 'unit test', 'integration test',
  'function signature', 'class method', 'interface',
];

// Strong prose signals — research / planning / writing terminology.
const PROSE_KEYWORDS = [
  'summarize', 'summary', 'overview',
  'analyze', 'analysis', 'evaluate', 'assess',
  'research', 'investigate', 'survey',
  'compare', 'comparison', 'contrast',
  'outline', 'plan', 'strategy', 'roadmap',
  'report', 'findings', 'conclusion', 'recommendation',
  'breakdown', 'walkthrough', 'explanation',
  'narrative', 'draft', 'rewrite',
  'pros and cons', 'tradeoff', 'rationale',
  'document', 'documentation', 'readme',
];

// Pass 2 — complexity (retained for future per-tier pricing signals)
const SIMPLE_KEYWORDS   = ['quick', 'brief', 'check', 'lookup', 'list', 'short'];
const COMPLEX_KEYWORDS  = ['deep', 'thorough', 'full', 'complete', 'comprehensive', 'detailed', 'multi-step', 'architecture'];
const FRONTIER_KEYWORDS = ['critical', 'production', 'novel', 'groundbreaking', 'mission', 'enterprise', 'best possible', 'highest quality'];

function score(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
}

function resolveComplexity(text: string, override?: string): SubAgentComplexity {
  if (override === 'simple' || override === 'complex' || override === 'frontier') return override;
  if (score(text, FRONTIER_KEYWORDS) > 0) return 'frontier';
  if (score(text, COMPLEX_KEYWORDS) > score(text, SIMPLE_KEYWORDS)) return 'complex';
  return 'simple';
}

/**
 * MiniMax model string — also used as the quota-fallback model when the Kimi
 * sub-agent route is exhausted.
 */
export function getMinimaxFallbackModel(_complexity?: SubAgentComplexity): string {
  return resolveFamilyModel('minimax');
}

/**
 * Returns true if the given model has an explicit chat_capable=0 entry in
 * model_catalog. Defaults to true (capable) when no entry exists.
 */
function isChatCapableModel(model: string): boolean {
  try {
    const row = getDb()
      .prepare(`SELECT chat_capable FROM model_catalog WHERE model_id = ? LIMIT 1`)
      .get(model) as { chat_capable: number } | undefined;
    return row === undefined ? true : row.chat_capable !== 0;
  } catch {
    return true; // fail-open: assume capable if DB unavailable
  }
}

export function triageSubAgentModel(
  taskText:          string,
  priorityOverride?: string,
  kindOverride?:     'code' | 'prose',  // explicit routing override — skips keyword scoring
): SubAgentTriage {
  // ⚠ CORRECTNESS: complexity MUST be computed first — both kindOverride branches
  // reference it in their return object. Moving this below the override block
  // throws ReferenceError at runtime.
  const complexity = resolveComplexity(taskText, priorityOverride);

  // If caller supplied kind, skip keyword scoring entirely — caller's intent wins.
  if (kindOverride === 'code') {
    return {
      provider:   'kimi',
      model:      resolveFamilyModel('kimi'),
      complexity,
      family:     'kimi',
      codeScore:  0,
      proseScore: 0,
    };
  }
  if (kindOverride === 'prose') {
    return {
      provider:   'minimax',
      model:      resolveFamilyModel('minimax'),
      complexity,
      family:     'minimax',
      codeScore:  0,
      proseScore: 0,
    };
  }

  // No override — dual-score keyword routing.
  // Tie (including both-zero) → minimax: broader, safer default.
  const codeScore  = score(taskText, CODE_KEYWORDS);
  const proseScore = score(taskText, PROSE_KEYWORDS);

  let provider: SubAgentProvider;
  let model: string;
  if (codeScore > proseScore) {
    provider = 'kimi';
    model    = resolveFamilyModel('kimi');
  } else {
    provider = 'minimax';
    model    = resolveFamilyModel('minimax');
  }

  // Guard: if model_catalog explicitly marks this model as non-chat, fall back
  // to minimax rather than sending a request that will fail at the API layer.
  if (!isChatCapableModel(model)) {
    logger.warn('sub-agent-triage: selected model is not chat_capable — falling back to minimax', { model, provider });
    provider = 'minimax';
    model    = resolveFamilyModel('minimax');
  }

  logger.debug('sub-agent triage', { provider, model, complexity, codeScore, proseScore });

  return { provider, model, complexity, family: provider, codeScore, proseScore };
}
