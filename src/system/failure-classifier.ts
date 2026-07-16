// Failure classification for Sentinel escalation (Archon-inspired).
//
// Sentinel's escalation ladder is uniform: every stalled task gets
// check-in → same-agent-retry → cross-agent-reassign → block, regardless of
// *why* it failed. For a provider-AGNOSTIC fatal cause (bad model name, missing
// secret, unknown tool) the same-agent retry and the cross-agent reassign both
// fail identically — burning up to two ≥cooldown escalation windows before the
// task finally blocks.
//
// classifyFailure lets Sentinel skip straight to `blocked` for fatal causes,
// while transient/unknown keep the full recoverable ladder.
//
// SCOPE / SAFETY: `tasks.last_error` is flattened free text (a single scalar —
// latest error only), so the fatal set is deliberately provider-agnostic and
// conservative. A false-fatal only parks a task at the recoverable, human-visible
// `blocked` state — never `failed`/deleted. Kill-switch: SENTINEL_FAILURE_CLASSIFY=false.

export type FailureClass = 'fatal' | 'transient' | 'unknown';

const FATAL_REPEAT_THRESHOLD = parseInt(process.env.SENTINEL_FATAL_REPEAT ?? '3', 10);

// Provider-agnostic FATAL signatures — the SAME failure for every agent, so
// neither same-agent retry nor cross-agent reassign can help.
// NOTE: bare 403/`unauthorized` deliberately EXCLUDED — last_error is free text
// and a bare 403 matches unrelated numerals / a transient scrape 403. Only 401
// (`invalid api key`) is treated as a hard auth-fatal.
const FATAL_PATTERNS: RegExp[] = [
  /model\s+name\s+not\s+supported/i,
  /no\s+such\s+model/i,
  /model_not_found/i,
  /invalid\s+api\s*key/i,
  /\b401\b/,
  /secret\s+.*\bnot\s+found/i,
  /unknown\s+tool/i,
  /no\s+such\s+tool/i,
  /permission\s+denied/i,
  /\bENOENT\b/,
];

// Recoverable-by-retry / by-reassignment signatures.
// NOTE: quota/billing lives HERE, not in fatal — it's `shouldFallback:true`, so
// a different provider/agent (i.e. reassignment) is exactly the correct fix.
const TRANSIENT_PATTERNS: RegExp[] = [
  /rate\s*limit/i,
  /\b429\b/,
  /timeout/i,
  /timed\s*out/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\b50[234]\b/,
  /overloaded/i,
  /stream\s+.*\baborted/i,
  /quota\s+exceeded/i,
  /insufficient\s+credits/i,
];

/**
 * Classify a task failure by its latest error + persistence count.
 * Transient is checked BEFORE fatal on ambiguous strings — we prefer keeping the
 * recoverable ladder over a false block.
 */
export function classifyFailure(lastError: string | null | undefined, failureCount = 0): FailureClass {
  const err = (lastError ?? '').trim();

  // Persistence heuristic: repeated failures on the SAME task = fatal-by-
  // persistence regardless of the string. `blocked` is recoverable, so the
  // higher false-fatal risk here is acceptable.
  if (failureCount >= FATAL_REPEAT_THRESHOLD) return 'fatal';

  if (!err) return 'unknown';

  if (TRANSIENT_PATTERNS.some(re => re.test(err))) return 'transient';
  if (FATAL_PATTERNS.some(re => re.test(err)))     return 'fatal';
  return 'unknown';
}
