// Pure scoring helpers used by the extractor and pipeline.
// Stateful evolution (decay scheduler, dedup, promotion to semantic/procedural)
// lands in P2d.

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Combine the five signals from the extractor's importance components into a
 * single 0–1 score. Weighted sum so any one signal can't tip the balance alone.
 */
export interface ImportanceComponents {
  relevance?:        number;   // 0–1
  recurrence?:       number;   // 0–1 (caller boosts this when same-title-and-type already exists)
  usefulness?:       number;   // 0–1
  user_emphasis?:    number;   // 0–1 (boost when user explicitly says "remember this")
  correction_weight?: number;  // 0–1 (boost when assistant fixed a prior mistake)
}

export function combineImportance(c: ImportanceComponents): number {
  const r  = clamp01(c.relevance         ?? 0.5);
  const re = clamp01(c.recurrence        ?? 0);
  const u  = clamp01(c.usefulness        ?? 0.5);
  const e  = clamp01(c.user_emphasis     ?? 0);
  const co = clamp01(c.correction_weight ?? 0);
  // Weights sum to 1.0
  return clamp01(r * 0.30 + u * 0.30 + re * 0.15 + e * 0.15 + co * 0.10);
}

/**
 * Initial salience for a freshly extracted memory. Starts at importance, with a
 * small recency floor so brand-new memories aren't ranked below stale 0.3s.
 */
export function initialSalience(importance: number): number {
  return clamp01(Math.max(importance * 0.9, 0.4));
}

/**
 * Time-decay multiplier applied at retrieval time. Half-life ≈ 14 days.
 * Memories that are touched (last_accessed bumps) recover salience.
 */
export function timeDecayMultiplier(lastAccessedIso: string | null, createdAtIso: string): number {
  const ref = new Date(lastAccessedIso ?? createdAtIso).getTime();
  if (!Number.isFinite(ref)) return 1;
  const ageDays = (Date.now() - ref) / 86_400_000;
  if (ageDays <= 0) return 1;
  // 0.5 ** (ageDays / 14) — gentle half-life
  return Math.pow(0.5, ageDays / 14);
}

/**
 * Effective rank score combining stored salience/importance with decay.
 */
export function rankScore(opts: {
  salience:      number;
  importance:    number;
  created_at:    string;
  last_accessed: string | null;
}): number {
  const decay = timeDecayMultiplier(opts.last_accessed, opts.created_at);
  return clamp01(opts.salience * 0.6 * decay + opts.importance * 0.4);
}
