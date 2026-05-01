// Heuristic model triage: classify task complexity from text → low | mid | high.
// Then resolve a concrete model_id from the live catalog for that tier.
//
// Pure heuristic — no extra LLM call. Optional LLM-based classifier can be
// added later as opt-in (see plan).

import { createHash } from 'crypto';
import { listCatalog, type ModelTier } from './model-catalog';
import { logger } from '../utils/logger';
import { config } from '../config';
import { spendForSession, spendLastHour } from './model-spend';
import { logHive } from './hive-mind';

// ── Decision cache (in-memory, LRU-bounded, TTL'd) ──────────────────────────
// At scale the same task descriptions recur (cron-style spawns, retries,
// multi-step plans that reuse phrasing). Hash → decision.

const CACHE_MAX = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const decisionCache = new Map<string, { decision: TriageDecision; expires: number }>();

function cacheKey(text: string): string {
  return createHash('sha1').update(text.slice(0, 4000)).digest('hex');
}

function cacheGet(text: string): TriageDecision | null {
  const k = cacheKey(text);
  const hit = decisionCache.get(k);
  if (!hit) return null;
  if (hit.expires < Date.now()) { decisionCache.delete(k); return null; }
  // Touch LRU order
  decisionCache.delete(k);
  decisionCache.set(k, hit);
  return hit.decision;
}

function cacheSet(text: string, decision: TriageDecision): void {
  const k = cacheKey(text);
  if (decisionCache.size >= CACHE_MAX) {
    const oldest = decisionCache.keys().next().value;
    if (oldest) decisionCache.delete(oldest);
  }
  decisionCache.set(k, { decision, expires: Date.now() + CACHE_TTL_MS });
}

export function getTriageCacheSize(): number { return decisionCache.size; }
export function clearTriageCache(): void { decisionCache.clear(); }

// ── Complexity classifier ───────────────────────────────────────────────────

export interface TriageReasons {
  length?:        number;
  hasCode?:       boolean;
  multiStep?:     boolean;
  toolUseSignals?: boolean;
  reasoningSignals?: boolean;
  longContext?:   boolean;
  forced?:        boolean;
}

export interface TriageDecision {
  tier:    ModelTier;
  score:   number;       // 0–1, where 1 = high complexity
  reasons: TriageReasons;
}

const STEP_VERBS = /\b(plan|design|architect|refactor|migrate|orchestrate|implement|integrate|coordinate|analyze|investigate|evaluate|compare|synthesize|prove|verify|reason|deduce|optimize|benchmark)\b/i;
const REASONING_SIGNALS = /\b(why|prove|derive|tradeoff|tradeoffs|rationale|step[- ]by[- ]step|root cause|pros and cons|edge cases|invariants|complexity)\b/i;
const TOOL_USE_SIGNALS = /\b(run|execute|fetch|deploy|build|install|migrate|apply|commit|push|merge|search|query)\b/i;
const CODE_VERBS = /\b(refactor|implement|edit|patch|debug|fix|test|review)\b/i;
const CODE_BLOCK = /```|`{1,2}[a-z_][\w.]*`{1,2}|^\s*(class|def|function|const|let|var|import|export|return|if|else|for|while|switch|try)\b|src\/[\w./]+|\.(ts|js|py|go|rb|rs|java|cpp|c|h)\b/m;

export function classifyComplexity(text: string, opts: { skipCache?: boolean } = {}): TriageDecision {
  if (!opts.skipCache) {
    const cached = cacheGet(text);
    if (cached) return cached;
  }
  const len = text.length;
  const hasCode = CODE_BLOCK.test(text) || CODE_VERBS.test(text);
  const stepHits = (text.match(STEP_VERBS) || []).length;
  const reasoning = REASONING_SIGNALS.test(text);
  const toolUse = TOOL_USE_SIGNALS.test(text);
  const longContext = len > 4000;

  // Score components — keep under 1.0 in aggregate. Tuned to bias toward
  // upgrading on code/multi-step work, which is where cheap models miss.
  let score = 0;
  if (len > 200)     score += 0.10;
  if (len > 800)     score += 0.15;
  if (longContext)   score += 0.15;
  if (hasCode)       score += 0.25;
  if (stepHits >= 1) score += 0.20;
  if (stepHits >= 3) score += 0.10;
  if (reasoning)     score += 0.25;
  if (toolUse)       score += 0.05;

  let tier: ModelTier;
  if (score >= 0.50) tier = 'high';
  else if (score >= 0.25) tier = 'mid';
  else tier = 'low';

  const decision: TriageDecision = {
    tier,
    score: Math.min(1, score),
    reasons: { length: len, hasCode, multiStep: stepHits >= 1, toolUseSignals: toolUse, reasoningSignals: reasoning, longContext },
  };
  if (!opts.skipCache) cacheSet(text, decision);
  return decision;
}

// ── Tier → model resolver ───────────────────────────────────────────────────

export interface ResolveOpts {
  provider?:  string;
  preferred?: string;     // user-pinned model on the agent (if model_tier='pinned')
}

/**
 * Pick a concrete model id for a tier from the live catalog.
 * Strategy: prefer non-overridden auto-classified models in the requested tier;
 * deterministic ordering (alphabetical) so the same task always picks the same
 * model unless catalog changes.
 */
export function resolveModelForTier(tier: ModelTier, opts: ResolveOpts = {}): string | null {
  const provider = opts.provider ?? 'voidai';
  const candidates = listCatalog({ provider, tier });
  if (candidates.length === 0) {
    // Fallback: if requested tier is empty, walk down (high → mid → low) then up
    const order: ModelTier[] = tier === 'high' ? ['high', 'mid', 'low']
                              : tier === 'mid'  ? ['mid', 'low', 'high']
                              :                   ['low', 'mid', 'high'];
    for (const t of order) {
      const fallback = listCatalog({ provider, tier: t });
      if (fallback.length > 0) {
        logger.warn('triage: requested tier empty, using fallback', { requested: tier, used: t, model: fallback[0].model_id });
        return fallback[0].model_id;
      }
    }
    return opts.preferred ?? null;
  }
  // Prefer the alphabetically-first; deterministic and stable.
  return candidates[0].model_id;
}

// ── Combined entry point ────────────────────────────────────────────────────

export interface PickModelOpts {
  text:       string;
  provider?:  string;
  agentTier?: string;     // 'pinned' | 'low' | 'mid' | 'high' | 'auto' from the agent record
  pinnedModel?: string;   // agent.model when model_tier === 'pinned'
  spawnDepth?: number;    // 0 = top-level agent, 1 = first sub-agent, ...
  sessionId?: string;     // for budget guard
  agentId?:   string;     // for telemetry
}

/**
 * Tier downgrade chain used by the budget guard.
 *   high → mid → low (no further)
 */
function downgradeTier(tier: ModelTier): ModelTier {
  if (tier === 'high') return 'mid';
  if (tier === 'mid')  return 'low';
  return 'low';
}

export interface BudgetCheck {
  ok:         boolean;
  reason?:    string;
  current?:   number;
  limit?:     number;
}

export function checkBudget(sessionId: string | undefined): BudgetCheck {
  const sessionLimit = config.triage.budgetSession;
  const hourLimit    = config.triage.budgetHour;
  if (sessionId && sessionLimit > 0) {
    const s = spendForSession(sessionId);
    if (s.total_tokens >= sessionLimit) {
      return { ok: false, reason: 'session', current: s.total_tokens, limit: sessionLimit };
    }
  }
  if (hourLimit > 0) {
    const h = spendLastHour();
    if (h.total_tokens >= hourLimit) {
      return { ok: false, reason: 'hour', current: h.total_tokens, limit: hourLimit };
    }
  }
  return { ok: true };
}

export interface PickModelResult {
  model:           string | null;
  tier:            ModelTier | 'pinned';
  triaged:         boolean;       // true when we ran the heuristic classifier
  decision?:       TriageDecision;
  depthPenalty?:   { from: ModelTier; to: ModelTier; depth: number };
}

/**
 * Cascade-depth penalty: deep sub-agents are forced to cheaper tiers to
 * avoid runaway spawn pyramids burning Opus calls.
 *   depth 0 → no penalty
 *   depth 1 → no penalty (first-level spawn)
 *   depth 2 → cap at mid
 *   depth ≥ 3 → cap at low
 */
export function applyDepthPenalty(tier: ModelTier, spawnDepth: number): { tier: ModelTier; capped: boolean } {
  if (spawnDepth >= 3) {
    return { tier: 'low', capped: tier !== 'low' };
  }
  if (spawnDepth >= 2 && tier === 'high') {
    return { tier: 'mid', capped: true };
  }
  return { tier, capped: false };
}

export interface PickModelResultExtended extends PickModelResult {
  llmEscalated?: boolean;
  budgetDowngrade?: { from: ModelTier; to: ModelTier; reason: string };
}

export function pickModel(opts: PickModelOpts): PickModelResult {
  if (!opts.agentTier || opts.agentTier === 'pinned') {
    return { model: opts.pinnedModel ?? null, tier: 'pinned', triaged: false };
  }
  let tier: ModelTier;
  let decision: TriageDecision | undefined;
  if (opts.agentTier === 'auto') {
    decision = classifyComplexity(opts.text);
    tier = decision.tier;
  } else if (opts.agentTier === 'low' || opts.agentTier === 'mid' || opts.agentTier === 'high') {
    tier = opts.agentTier as ModelTier;
  } else {
    return { model: opts.pinnedModel ?? null, tier: 'pinned', triaged: false };
  }

  // Cascade-depth penalty for deep sub-agents.
  let depthPenalty: PickModelResult['depthPenalty'] | undefined;
  if (typeof opts.spawnDepth === 'number') {
    const capped = applyDepthPenalty(tier, opts.spawnDepth);
    if (capped.capped) {
      depthPenalty = { from: tier, to: capped.tier, depth: opts.spawnDepth };
      tier = capped.tier;
    }
  }

  const model = resolveModelForTier(tier, { provider: opts.provider, preferred: opts.pinnedModel });
  return { model, tier, triaged: opts.agentTier === 'auto', decision, depthPenalty };
}

/**
 * Async variant — runs the borderline LLM classifier when the heuristic score
 * lands in the configured grey zone. Use this from spawn/chat paths that can
 * afford the extra (cheap) round-trip; fall back to pickModel() when latency-sensitive.
 */
export async function pickModelAsync(opts: PickModelOpts): Promise<PickModelResultExtended> {
  // Fast path: pinned or fixed tier never escalates.
  if (!opts.agentTier || opts.agentTier === 'pinned' || opts.agentTier !== 'auto') {
    return pickModel(opts) as PickModelResultExtended;
  }

  const decision = classifyComplexity(opts.text);
  const { shouldEscalateToLlm, llmClassify } = await import('./model-triage-llm');
  let tier = decision.tier;
  let llmEscalated = false;
  if (shouldEscalateToLlm(decision)) {
    const llm = await llmClassify(opts.text);
    if (llm) {
      tier = llm.tier;
      llmEscalated = true;
    }
  }

  let depthPenalty: PickModelResult['depthPenalty'] | undefined;
  if (typeof opts.spawnDepth === 'number') {
    const capped = applyDepthPenalty(tier, opts.spawnDepth);
    if (capped.capped) {
      depthPenalty = { from: tier, to: capped.tier, depth: opts.spawnDepth };
      tier = capped.tier;
    }
  }

  // Budget guard — downgrade if we're over the per-session or per-hour cap.
  let budgetDowngrade: PickModelResultExtended['budgetDowngrade'] | undefined;
  const budget = checkBudget(opts.sessionId);
  if (!budget.ok && tier !== 'low') {
    const newTier = downgradeTier(tier);
    budgetDowngrade = {
      from:   tier,
      to:     newTier,
      reason: `${budget.reason} budget exceeded (${budget.current}/${budget.limit} tokens)`,
    };
    try {
      logHive('triage_budget_downgrade',
        `${tier} → ${newTier} (${budget.reason} budget ${budget.current}/${budget.limit})`,
        opts.agentId,
        { from: tier, to: newTier, ...budget });
    } catch { /* best-effort */ }
    tier = newTier;
  }

  const model = resolveModelForTier(tier, { provider: opts.provider, preferred: opts.pinnedModel });
  return { model, tier, triaged: true, decision, depthPenalty, llmEscalated, budgetDowngrade };
}
