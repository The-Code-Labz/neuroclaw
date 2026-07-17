// In-process tiered review service — replaces the MCP Reviewer Council sidecar.
//
// Pipeline:  deterministic pre-gate → Tier-1 cheap smell-test → Tier-2 deep review.
//
//   pre-gate (zero model cost): 'skip' | 'tier1' | 'tier2'
//   Tier-1 (VoidAI gpt-4.1-mini/nano): fast; biased escalate-on-doubt.
//   Tier-2 (OpenRouter Sonnet, VoidAI-strong fallback): gated, low-volume.
//
// Fail-open is a HARD invariant: any error/timeout at any layer resolves to
// "passed" so review can never block a response or wrongly fail a task.
//
// Tier-2 rides the OpenRouter lane (isolated, API-billed window; JSON-mode
// capable) rather than subscription Claude via the claude CLI, which would be a
// subprocess spawn sharing the interactive OAuth window with no concurrency
// gate — the exact window-bleed class we avoid elsewhere.

import { bgChatCompletion } from '../agent/openai-client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';
import {
  AggregateVerdict,
  ReviewerVerdict,
  coerceSeverity,
  coerceIssues,
  collectBlocking,
  formatFeedback,
} from './review-types';

const MAX_DIFF_CHARS     = 6000;
const MAX_LOGS_CHARS     = 6000;
const MAX_ARTIFACT_CHARS = 6000;

export interface ReviewInput {
  request:        string;
  artifact:       string;
  diff?:          string;
  changedFiles?:  string[];
  logs?:          string;
  artifactKind:   'code' | 'prose' | 'unknown';
  taskType?:      string;
  priorFeedback?: string;
  runId?:         string;
}

// ── tiny counting semaphore (bounds Tier-2 concurrency / cost) ─────────────
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.max) { this.active++; return () => this.release(); }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => { this.active++; resolve(() => this.release()); });
    });
  }
  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
const tier2Gate = new Semaphore(Math.max(1, config.review.tier2MaxConcurrent));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function cap(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(-n) : s;
}

function passVerdict(reviewer: ReviewerVerdict['reviewer'], summary: string): ReviewerVerdict {
  return { reviewer, passed: true, severity: 'none', issues: [], summary };
}

function aggregate(verdicts: ReviewerVerdict[]): AggregateVerdict {
  const blocking = collectBlocking(verdicts);
  const passed   = verdicts.every(v => v.passed) && blocking.length === 0;
  const feedback = passed ? '' : formatFeedback(verdicts);
  return { passed, verdicts, blocking, feedback };
}

function failOpen(reviewer: ReviewerVerdict['reviewer'], why: string): AggregateVerdict {
  return aggregate([passVerdict(reviewer, `${why} (fail-open)`)]);
}

// ── pre-gate ───────────────────────────────────────────────────────────────
type PreGate = { route: 'skip' | 'tier1' | 'tier2'; risky: boolean; reason: string };

function diffStats(diff: string): { lines: number; added: number; deleted: number } {
  let added = 0, deleted = 0, lines = 0;
  for (const ln of diff.split('\n')) {
    lines++;
    if (ln.startsWith('+') && !ln.startsWith('+++')) added++;
    else if (ln.startsWith('-') && !ln.startsWith('---')) deleted++;
  }
  return { lines, added, deleted };
}

function preGate(input: ReviewInput): PreGate {
  const { review } = config;
  const tt = (input.taskType ?? '').toLowerCase();
  if (tt && review.trivialTaskTypes.includes(tt)) {
    return { route: 'skip', risky: false, reason: `trivial task type '${tt}'` };
  }

  // Risky-file auto-escalation (depends on changedFiles being supplied).
  const files = (input.changedFiles ?? []).map(f => f.toLowerCase());
  const riskyHit = files.find(f => review.riskyGlobs.some(g => f.includes(g)));
  if (riskyHit) {
    return { route: 'tier2', risky: true, reason: `risky file '${riskyHit}'` };
  }

  if (input.diff) {
    const { lines, added, deleted } = diffStats(input.diff);
    if (lines > review.tier1MaxDiffLines) {
      return { route: 'tier2', risky: false, reason: `large diff (${lines} lines)` };
    }
    if (deleted > added && deleted > 50) {
      return { route: 'tier2', risky: false, reason: `net deletions (${deleted}-${added})` };
    }
  }

  return { route: 'tier1', risky: false, reason: 'default' };
}

// ── Tier-1 ───────────────────────────────────────────────────────────────
const TIER1_SYSTEM = `You are a fast TRIAGE reviewer. Your ONE job is to decide whether an \
artifact/diff is trivially safe or needs a deeper look — NOT to fully review it.

Rules:
- Set "escalate": true when you are UNSURE whether the change is safe, or when it changes a \
function signature, deletes code, alters control flow, touches security/data/config, or has \
non-trivial logic. When in doubt, ESCALATE.
- Set "escalate": false only for clearly-safe changes (comments, strings, added logging, \
isolated new code, docs) or output that clearly and completely satisfies the request.
- Only fail (passed=false) for an OBVIOUS, clear-cut defect you are confident about.

Return STRICT JSON only, no prose, no code fences:
{"escalate": boolean, "passed": boolean, "severity": "none"|"low"|"medium"|"high"|"critical",
 "issues": [{"location": string, "problem": string, "fix": string, "severity": string}],
 "summary": string}`;

async function runTier1(input: ReviewInput): Promise<{ escalate: boolean; verdict: ReviewerVerdict }> {
  // No diff → grade the narrative artifact with the non-code model regardless of
  // artifactKind (task.output is a summary, not literal code). (ASAGI #7)
  const isCode  = !!input.diff && input.artifactKind === 'code';
  const model   = isCode ? config.review.tier1CodeModel : config.review.tier1NonCodeModel;
  const subject = input.diff ? `DIFF:\n${cap(input.diff, MAX_DIFF_CHARS)}` : `OUTPUT:\n${cap(input.artifact, MAX_ARTIFACT_CHARS)}`;
  const logs    = input.logs ? `\n\nLOGS:\n${cap(input.logs, MAX_LOGS_CHARS)}` : '';
  const prior   = input.priorFeedback ? `\n\nPRIOR FEEDBACK:\n${input.priorFeedback}` : '';
  const user    = `REQUEST:\n${input.request}\n\n${subject}${logs}${prior}`;

  // MiniMax-prefixed model ids ride the native preferMinimax lane; anything else
  // (e.g. a VoidAI override like 'gpt-4.1-mini') keeps the original voidaiModel lane.
  const isMinimax = model.toLowerCase().startsWith('minimax');

  const resp = await withTimeout(
    bgChatCompletion({
      model:           model,           // ignored by bgChatCompletion, kept for clarity
      max_tokens:      1200,
      temperature:     0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: TIER1_SYSTEM },
        { role: 'user',   content: user },
      ],
    }, isMinimax
      ? { preferMinimax: true, minimaxModel: model, label: 'review-tier1' }
      : { voidaiModel: model, label: 'review-tier1' }),
    config.review.tierTimeoutMs, 'review-tier1',
  );

  const raw = resp.choices[0]?.message?.content ?? '';
  const obj = safeParse(raw);
  const verdict: ReviewerVerdict = {
    reviewer: 'tier1',
    passed:   obj.passed === true,
    severity: coerceSeverity(obj.severity),
    issues:   coerceIssues(obj.issues),
    summary:  typeof obj.summary === 'string' ? obj.summary : '',
  };
  return { escalate: obj.escalate === true, verdict };
}

// ── Tier-2 ───────────────────────────────────────────────────────────────
const TIER2_SYSTEM = `You are a SENIOR code/spec reviewer doing a careful pass. You did not \
write this. Judge whether the artifact/diff correctly and completely satisfies the request, \
and whether it introduces bugs, broken references, unsafe patterns, or regressions.

Return STRICT JSON only, no prose, no code fences:
{"passed": boolean, "severity": "none"|"low"|"medium"|"high"|"critical",
 "issues": [{"location": string, "problem": string, "fix": string, "severity": string}],
 "summary": string}
Set passed=false if any issue is severity high or critical.`;

async function runTier2(input: ReviewInput): Promise<ReviewerVerdict> {
  const subject = input.diff ? `DIFF:\n${cap(input.diff, MAX_DIFF_CHARS)}` : `OUTPUT:\n${cap(input.artifact, MAX_ARTIFACT_CHARS)}`;
  const files   = input.changedFiles?.length ? `\n\nCHANGED FILES:\n${input.changedFiles.join('\n')}` : '';
  const logs    = input.logs ? `\n\nLOGS:\n${cap(input.logs, MAX_LOGS_CHARS)}` : '';
  const prior   = input.priorFeedback ? `\n\nPRIOR FEEDBACK:\n${input.priorFeedback}` : '';
  const user    = `REQUEST:\n${input.request}\n\n${subject}${files}${logs}${prior}`;
  const messages = [
    { role: 'system' as const, content: TIER2_SYSTEM },
    { role: 'user'   as const, content: user },
  ];

  const release = await tier2Gate.acquire();
  try {
    let raw: string;
    try {
      // Primary: OpenRouter lane (Sonnet) — isolated window, JSON-mode capable.
      const resp = await withTimeout(
        bgChatCompletion({
          model: config.review.tier2Model, max_tokens: 3000, temperature: 0.1,
          response_format: { type: 'json_object' }, messages,
        }, { preferGemini: true, openrouterModel: config.review.tier2Model, label: 'review-tier2' }),
        config.review.tierTimeoutMs, 'review-tier2',
      );
      raw = resp.choices[0]?.message?.content ?? '';
    } catch (primaryErr) {
      logger.warn('review-tier2: primary failed, trying fallback', { error: (primaryErr as Error).message });
      // Fallback: native MiniMax-M3 lane — off VoidAI's flaky proxy path
      // (was voidaiModel: config.review.tier2Fallback, which just landed back
      // on the same unstable provider the primary was falling back away from).
      const resp = await withTimeout(
        bgChatCompletion({
          model: config.review.tier2Fallback, max_tokens: 3000, temperature: 0.1,
          response_format: { type: 'json_object' }, messages,
        }, { preferMinimax: true, label: 'review-tier2-fallback' }),
        config.review.tierTimeoutMs, 'review-tier2-fallback',
      );
      raw = resp.choices[0]?.message?.content ?? '';
    }
    const obj = safeParse(raw);
    return {
      reviewer: 'tier2',
      passed:   obj.passed === true,
      severity: coerceSeverity(obj.severity),
      issues:   coerceIssues(obj.issues),
      summary:  typeof obj.summary === 'string' ? obj.summary : '',
    };
  } finally {
    release();
  }
}

function safeParse(raw: string): Record<string, unknown> {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  }
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object') ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Core review entry. Runs pre-gate → Tier-1 → Tier-2 as needed and returns an
 * AggregateVerdict. Never throws — every failure resolves fail-open.
 */
export async function reviewInput(input: ReviewInput): Promise<AggregateVerdict> {
  if (!config.review.enabled) return failOpen('tier1', 'review disabled');

  const gate  = preGate(input);
  const start = Date.now();

  try {
    if (gate.route === 'skip') {
      return aggregate([passVerdict('tier1', `pre-gate: ${gate.reason}, skipped`)]);
    }

    let verdict: ReviewerVerdict;
    let usedTier2 = false;

    if (gate.route === 'tier2') {
      // Risky escalation but no diff to actually inspect → note the degradation.
      if (gate.risky && !input.diff) {
        logHive('review_degraded_no_diff',
          `Review: risky-file escalation with no diff available — degrading to artifact grade (${gate.reason})`,
          undefined, { reason: gate.reason }, input.runId);
      }
      try {
        verdict = await runTier2(input);
        usedTier2 = true;
      } catch (err) {
        // Highest blast-radius failure: a risky change silently rubber-stamped.
        if (gate.risky) {
          logHive('review_failopen_risky',
            `Review FAIL-OPEN on RISKY change (${gate.reason}) — human spot-check advised`,
            undefined, { reason: gate.reason, error: (err as Error).message, severity: 'high' }, input.runId);
        }
        logger.warn('review: tier2 failed (fail-open)', { reason: gate.reason, error: (err as Error).message });
        return failOpen('tier2', `tier2 error: ${gate.reason}`);
      }
    } else {
      // tier1, possibly escalating to tier2.
      let t1: { escalate: boolean; verdict: ReviewerVerdict };
      try {
        t1 = await runTier1(input);
      } catch (err) {
        logger.warn('review: tier1 failed (fail-open)', { error: (err as Error).message });
        return failOpen('tier1', 'tier1 error');
      }
      if (t1.escalate) {
        try {
          verdict = await runTier2(input);
          usedTier2 = true;
        } catch (err) {
          logger.warn('review: tier2 (escalated) failed (fail-open)', { error: (err as Error).message });
          return failOpen('tier2', 'tier2 escalated error');
        }
      } else {
        verdict = t1.verdict;
      }
    }

    const result = aggregate([verdict]);
    logHive(result.passed ? 'review_passed' : 'review_failed',
      `Review: ${result.passed ? 'PASSED' : `FAILED (${verdict.severity})`} via ${usedTier2 ? 'tier2' : 'tier1'} [${gate.reason}] in ${Date.now() - start}ms`,
      undefined,
      { route: gate.route, risky: gate.risky, tier2: usedTier2, passed: result.passed, severity: verdict.severity, issues: verdict.issues.length },
      input.runId);
    return result;
  } catch (err) {
    logger.warn('review: unexpected error (fail-open)', { error: (err as Error).message });
    return failOpen('tier1', 'unexpected error');
  }
}
