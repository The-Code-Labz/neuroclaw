// Reviewer Council aggregator.
//
// Fans out three narrow reviewers (code_quality, runtime, completion) running
// as Pydantic AI agents on the reviewer-council MCP server, parses their JSON
// verdicts in parallel, and aggregates into a single AggregateVerdict.
//
// Fail-open: if a reviewer is unreachable, that voice is treated as "passed"
// so a missing reviewer can never block a response on its own.

import { callTool } from '../mcp/mcp-client';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';
import { config } from '../config';

export type IssueSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface ReviewerIssue {
  location: string;
  problem:  string;
  fix:      string;
  severity: IssueSeverity;
}

export type ReviewerName = 'code_quality' | 'runtime' | 'completion';

export interface ReviewerVerdict {
  reviewer: ReviewerName;
  passed:   boolean;
  severity: IssueSeverity;
  issues:   ReviewerIssue[];
  summary:  string;
}

export interface AggregateVerdict {
  /** True iff every reviewer passed AND no issue is severity high or critical. */
  passed:   boolean;
  verdicts: ReviewerVerdict[];
  /** Issues at severity high or critical, flattened across reviewers. */
  blocking: ReviewerIssue[];
  /** Pre-formatted feedback block ready to splice back into a re-merge prompt. */
  feedback: string;
}

const REVIEWER_TOOLS: Array<{ tool: string; name: ReviewerName }> = [
  { tool: 'review_code_quality', name: 'code_quality' },
  { tool: 'review_runtime',      name: 'runtime'      },
  { tool: 'review_completion',   name: 'completion'   },
];

interface RawVerdict {
  passed?:   unknown;
  severity?: unknown;
  issues?:   unknown;
  summary?:  unknown;
}

function coerceSeverity(v: unknown): IssueSeverity {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low' || s === 'none') return s;
  return 'none';
}

function coerceIssues(v: unknown): ReviewerIssue[] {
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

function parseVerdict(name: ReviewerName, raw: unknown): ReviewerVerdict {
  // callTool already parses JSON-as-text into an object; tolerate string fallback too.
  let obj: RawVerdict = {};
  if (raw && typeof raw === 'object') {
    obj = raw as RawVerdict;
  } else if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) as RawVerdict; } catch { obj = {}; }
  }
  return {
    reviewer: name,
    passed:   obj.passed === true,
    severity: coerceSeverity(obj.severity),
    issues:   coerceIssues(obj.issues),
    summary:  typeof obj.summary === 'string' ? obj.summary : '',
  };
}

async function callReviewer(
  url:      string,
  toolName: string,
  name:     ReviewerName,
  args:     Record<string, unknown>,
): Promise<ReviewerVerdict> {
  const raw = await callTool(url, toolName, args, undefined, 'auto');
  return parseVerdict(name, raw);
}

/**
 * Run all three reviewers in parallel against an artifact and aggregate.
 *
 * @param request   The original user request (what the artifact is supposed to deliver).
 * @param artifact  The merged response / draft / code under review.
 * @param opts.logs Optional runtime logs (errors, build output) for the runtime reviewer.
 * @param opts.runId Run id for hive_mind correlation.
 */
export async function reviewArtifact(
  request:  string,
  artifact: string,
  opts?: { logs?: string; runId?: string },
): Promise<AggregateVerdict> {
  const url   = config.review.councilUrl;
  const start = Date.now();

  const settled = await Promise.allSettled([
    callReviewer(url, 'review_code_quality', 'code_quality', { request, artifact }),
    callReviewer(url, 'review_runtime',      'runtime',      { request, artifact, logs: opts?.logs ?? '' }),
    callReviewer(url, 'review_completion',   'completion',   { request, artifact }),
  ]);

  const verdicts: ReviewerVerdict[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const name = REVIEWER_TOOLS[i].name;
    logger.warn('reviewer call failed (fail-open)', {
      reviewer: name,
      error:    (s.reason as Error)?.message ?? String(s.reason),
    });
    // Fail-open: a broken reviewer cannot block a response.
    return {
      reviewer: name,
      passed:   true,
      severity: 'none',
      issues:   [],
      summary:  'reviewer unavailable (fail-open)',
    };
  });

  const blocking = verdicts.flatMap(v =>
    v.issues.filter(i => i.severity === 'high' || i.severity === 'critical'),
  );
  const passed = verdicts.every(v => v.passed) && blocking.length === 0;

  const feedback = passed
    ? ''
    : verdicts
        .filter(v => !v.passed || v.issues.length > 0)
        .map(v => {
          const head = `### ${v.reviewer} (${v.severity})\n${v.summary}`;
          const body = v.issues
            .map(i => `- [${i.severity}] ${i.location || '(unspecified)'}: ${i.problem}\n  Fix: ${i.fix}`)
            .join('\n');
          return body ? `${head}\n${body}` : head;
        })
        .join('\n\n');

  logHive(
    passed ? 'review_passed' : 'review_failed',
    `Reviewer council: ${verdicts.filter(v => v.passed).length}/${verdicts.length} passed in ${Date.now() - start}ms`,
    undefined,
    {
      verdicts: verdicts.map(v => ({
        r:        v.reviewer,
        passed:   v.passed,
        severity: v.severity,
        issues:   v.issues.length,
      })),
      blocking: blocking.length,
    },
    opts?.runId,
  );

  return { passed, verdicts, blocking, feedback };
}
