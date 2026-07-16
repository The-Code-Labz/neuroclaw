// Shared review types + permissive coercion helpers.
//
// Extracted from the old MCP review-council.ts so they survive the removal of
// the Pydantic sidecar. Both the in-process review-service and the holdout
// adapter import from here.

export type IssueSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface ReviewerIssue {
  location: string;
  problem:  string;
  fix:      string;
  severity: IssueSeverity;
}

export type ReviewerName = 'code_quality' | 'runtime' | 'completion' | 'tier1' | 'tier2';

export interface ReviewerVerdict {
  reviewer: ReviewerName;
  passed:   boolean;
  severity: IssueSeverity;
  issues:   ReviewerIssue[];
  summary:  string;
}

export interface AggregateVerdict {
  /** True iff the review passed AND no issue is severity high or critical. */
  passed:   boolean;
  verdicts: ReviewerVerdict[];
  /** Issues at severity high or critical, flattened across reviewers. */
  blocking: ReviewerIssue[];
  /** Pre-formatted feedback block ready to splice back into a re-dispatch prompt. */
  feedback: string;
}

export function coerceSeverity(v: unknown): IssueSeverity {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low' || s === 'none') return s;
  return 'none';
}

export function coerceIssues(v: unknown): ReviewerIssue[] {
  if (!Array.isArray(v)) return [];
  return v.map(raw => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      location: typeof o.location === 'string' ? o.location : '',
      problem:  typeof o.problem  === 'string' ? o.problem  : '',
      fix:      typeof o.fix      === 'string' ? o.fix      : '',
      severity: coerceSeverity(o.severity),
    };
  });
}

/** Flatten high/critical issues across verdicts (the blocking set). */
export function collectBlocking(verdicts: ReviewerVerdict[]): ReviewerIssue[] {
  return verdicts.flatMap(v =>
    v.issues.filter(i => i.severity === 'high' || i.severity === 'critical'),
  );
}

/** Render a re-dispatch-ready feedback block from failing verdicts. */
export function formatFeedback(verdicts: ReviewerVerdict[]): string {
  return verdicts
    .filter(v => !v.passed || v.issues.length > 0)
    .map(v => {
      const head = `### ${v.reviewer} (${v.severity})\n${v.summary}`;
      const body = v.issues
        .map(i => `- [${i.severity}] ${i.location || '(unspecified)'}: ${i.problem}\n  Fix: ${i.fix}`)
        .join('\n');
      return body ? `${head}\n${body}` : head;
    })
    .join('\n\n');
}
