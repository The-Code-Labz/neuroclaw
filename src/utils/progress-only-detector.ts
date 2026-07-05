// Progress-only output classifier.
// Spec: /home/specs/progress-only-detector.md
//
// Intercepts sub-agent output containing progress-signalling phrases like
// "I'll look into it" or "Let me check on that" — text that is work-intent
// acknowledgement, not a final deliverable. Returns true when the output
// should be classified as `blocked` rather than `done`.

// Matches "I'll inspect", "I'm going to analyze", "I will check", etc.
const PROGRESS_ONLY_PATTERN =
  /^(?:i(?:'ll|'m| will| am| am going to|'m going to)\s+(?:now\s+)?(?:analyz|apply|check|continue|debug|follow\s+up|inspect|investigat|look|map|open|read|report\s+back|review|run|start|test|trac|try|update|verify|work))/i;

// Matches "Check the logs", "Review the code", bare imperatives
const BARE_PROGRESS_ONLY_PATTERN =
  /^(?:analyz|check|debug|inspect|investigat|look\s+into|map|read|report\s+back|review|run|test|trac|verify|work\s+on)\w*\b/i;

// Matches "Let me check on that", "Let me look into it"
const LET_ME_PROGRESS_ONLY_PATTERN =
  /^let\s+me\s+(?:analyz|check(?:\s+on)?|debug|inspect|investigat|look(?:\s+into)?|map|open|read|review|run|test|trac|try|update|verify|work\s+on)\w*\b/i;

// Matches "I need to review the code"
const NEED_TO_PROGRESS_ONLY_PATTERN =
  /^i\s+need\s+to\s+(?:analyz|check|debug|inspect|investigat|look(?:\s+into)?|map|open|read|review|run|test|trac|try|update|verify|work\s+on)\w*\b/i;

// Strips "Next, ...", "After that, ...", "Then ..." planning prefixes before matching
const FOLLOW_UP_PLANNING_PREFIX =
  /^(?:after(?:wards|ward)?|from\s+there|next|once\s+(?:done|that(?:'s)?\s+done)|then)[,.\s]+/i;

/**
 * Returns true when `value` looks like a progress-only acknowledgement —
 * work intent without a deliverable. False positives are avoided by:
 *   - Length guard: outputs > 800 chars are real answers
 *   - Substantive-rest guard: if a second sentence is NOT progress-only,
 *     the whole output is not blocked
 */
export function isProgressOnlyOutput(value: string | null | undefined): boolean {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (normalized.length > 800) return false; // long outputs are real answers

  // If a later sentence is substantive, do not block the whole output
  const boundary = /(?:[.!?:]|\s[-–—])\s+\S/.exec(normalized);
  if (boundary) {
    const rest = normalized.slice(boundary.index + boundary[0].length - 1).trim();
    if (!isProgressOnlyOutput(rest)) return false;
  }

  const withoutPrefix = normalized.replace(FOLLOW_UP_PLANNING_PREFIX, '').trim();

  return (
    PROGRESS_ONLY_PATTERN.test(normalized) ||
    BARE_PROGRESS_ONLY_PATTERN.test(normalized) ||
    LET_ME_PROGRESS_ONLY_PATTERN.test(normalized) ||
    NEED_TO_PROGRESS_ONLY_PATTERN.test(normalized) ||
    PROGRESS_ONLY_PATTERN.test(withoutPrefix) ||
    BARE_PROGRESS_ONLY_PATTERN.test(withoutPrefix) ||
    LET_ME_PROGRESS_ONLY_PATTERN.test(withoutPrefix) ||
    NEED_TO_PROGRESS_ONLY_PATTERN.test(withoutPrefix)
  );
}
