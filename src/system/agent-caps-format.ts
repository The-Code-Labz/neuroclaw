/**
 * Shared formatter for an agent's stored `capabilities` JSON when building the
 * routing / decomposition agent list.
 *
 * WHY THIS EXISTS
 * A capability-extraction pass wrote *negation tags* (e.g. `not-code-generation`,
 * `not-user-interface-design`) into many agents' `capabilities` arrays — meaning
 * "things this agent should NOT do". But the decomposer and router render the
 * capabilities bracket as a flat, comma-joined list of *positive* skills that the
 * routing LLM reads as abilities. Unfiltered, an agent tagged `not-code-generation`
 * reads as a CODE agent (substring match) — inverting the routing signal.
 *
 * This filters negation tags out of the routing bracket. The agent's
 * human-authored `description` remains the primary routing signal; the bracket
 * degrades to `general` when nothing positive remains, rather than lying.
 *
 * A negation tag is any capability whose (trimmed) value starts with `not-` or
 * `not_` (case-insensitive).
 */
/** True if a capability tag is a negation ("anti-capability") — `not-*` / `not_*`. */
export function isNegationTag(tag: string): boolean {
  return /^not[-_]/i.test(tag.trim());
}

/**
 * Strip negation tags from a parsed capability array, returning the positive
 * remainder (trimmed, empties dropped). Shared by the read-time formatter AND
 * the boot cleanup migration so the two can never drift.
 */
export function stripNegationTags(caps: string[]): string[] {
  return caps
    .filter((c): c is string => typeof c === 'string')
    .map(c => c.trim())
    .filter(c => c.length > 0 && !isNegationTag(c));
}

export function formatAgentCapabilities(capabilitiesJson: string | null | undefined): string {
  let caps: unknown;
  try { caps = JSON.parse(capabilitiesJson || '[]'); } catch { caps = []; }
  if (!Array.isArray(caps)) return 'general';

  return stripNegationTags(caps as string[]).join(', ') || 'general';
}
