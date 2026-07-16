// Shared classification for the deterministic reconcile gate.
//
// Single source of truth for the two regexes used by BOTH task creation
// (task-manager.createTask, which stores verification_mode) AND review
// (holdout-reviewer, which reads it). Keeping them here — a dependency-free leaf
// module — guarantees the creation-time and review-time logic can never drift.

// Gate-relevant reconcile/merge detector: a reconcile/merge verb PLUS a
// git-context noun (worktree/branch/main/…), or an explicit worktree-policy /
// "merge all" phrasing. Only tasks matching this are subject to the gate.
export const RECONCILE_RE =
  /\b(reconcile|merge)\b[^.\n]*\b(worktree|worktrees|branch|branches|git tree|main|approved work)\b|worktree[- ]policy|merge all/i;

// Broader review/audit/gate marker. A gate-relevant task whose text ALSO reads as
// a review/audit/gate is supposed to leave main untouched → bypass the HEAD-moved
// assertion.
export const REVIEW_MARKER_RE =
  /\breview\b|re-review|\bgate\b|\baudit\b|\bverif(y|ication)\b|do[\s-]?not[\s-]?merge|review[\s-]?only/i;

export type VerificationMode = 'reconcile' | 'review';

/**
 * Classify a task for the reconcile gate.
 *
 * Returns the mode to STORE at creation, or `null` when the gate does not apply
 * (the task is not a reconcile/merge at all — most tasks). Order is load-bearing:
 * confirm reconcile-relevance first, then a review-marker downgrades to `'review'`
 * so e.g. "review the merge gate" → 'review', not 'reconcile'.
 */
export function classifyVerificationMode(
  title: string,
  description?: string | null,
): VerificationMode | null {
  const text = `${title} ${description ?? ''}`;
  if (!RECONCILE_RE.test(text)) return null;        // gate does not apply
  if (REVIEW_MARKER_RE.test(text)) return 'review'; // review/audit/gate → bypass
  return 'reconcile';                               // genuine merge → assert HEAD moved
}

/**
 * Does the CURRENT task text read as a review/audit/gate?
 *
 * Used at review time as the authoritative bypass signal — independent of the
 * stored mode — so a task retitled to review-only after creation is honored
 * (ASAGI v2 correction: the current reading wins, not a stale stored 'reconcile').
 */
export function textReadsAsReview(title: string, description?: string | null): boolean {
  return REVIEW_MARKER_RE.test(`${title} ${description ?? ''}`);
}
