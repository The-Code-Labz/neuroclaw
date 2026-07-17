// Self-heal: the loop orchestrator.
//
// Anchor scope (ASAGI): the ONLY live critical-path integration at launch is
// review→repair→re-review. The existing holdout loop ALREADY re-dispatches a
// failed task with the reviewer critique as feedback, then re-reviews. Self-heal
// layers three things on top of that existing loop WITHOUT changing its control
// flow in shadow mode:
//
//   1. OBSERVE — turn each review failure into a FailureEvent + failure-memory row.
//   2. LEARN   — when a task PASSES review after a prior critique, the re-review
//                IS the function-level Verify (it re-runs the original review
//                criteria on the new output). A pass ⇒ the fix held ⇒ record it.
//                This is why the review phase uniquely satisfies "Verify checks
//                function, not form" (ASAGI blocking #1) with no extra machinery.
//   3. STORM   — a run-level breaker: the same signature failing ≥ stormThreshold
//                times in one autonomous run is a SYSTEMIC blocker; stop feeding
//                the retry loop, escalate once, suppress the rest (ASAGI #8).
//
// PHASE 2 SPLIT GATE (default): SELF_HEAL_SHADOW=false leaves two independent
// sub-gates. SELF_HEAL_STORM_BREAKER=true (default ON) arms the runaway-retry
// storm-breaker immediately. SELF_HEAL_FIX_INJECTION=false (default OFF) keeps
// trusted-fix injection dark until a human reviews candidate fixes and flips it.

import { config } from '../../config';
import { logger } from '../../utils/logger';
import { logHive } from '../hive-mind';
import { buildFailureEvent, FailureEvent } from './failure-event';
import { recordObservation, recordVerify, getFix } from './failure-memory';
import type { ToolOutcome } from '../../tools/tool-result-class';


export interface ReviewFailureDecision {
  signature:   string;
  /** True ⇒ storm-breaker wants this suppressed (honored only when !shadowMode). */
  suppress:    boolean;
  /** Storm count of this signature within the run so far. */
  stormCount:  number;
  /** A confidence-gated stored fix to fold into the critique, if any. */
  injectFix:   string | null;
  fixKind:     'trusted' | 'prior' | 'none';
  /** Whether the loop is in shadow (observe/log-only) mode. */
  shadow:      boolean;
}

// ── run-level storm breaker (in-memory) ────────────────────────────────────
// runId → signature → count. In-process only, which is correct: a restart ends
// every run.
//
// TEARDOWN (F2) — why this is a bounded LRU, not just a clearRun() at run-end:
// the runId that keys a *tool*-phase failure is the per-turn `activeRunId`
// minted deep inside chatStream (job-worker dispatches with runId=undefined and
// never gets the minted id back). Review-phase failures key on task.session_id;
// autonomous-loop.finish() only knows its own `state.runId`. Those three
// id-spaces don't coincide, so an eager clearRun() can reclaim at most one of
// them and the tool buckets would otherwise leak one entry per turn forever.
// This bounded LRU is therefore the AUTHORITATIVE leak guard (not a stopgap):
// the outer map can never exceed STORM_MAX_RUNS live buckets, and no bucket can
// exceed STORM_MAX_SIGNATURES signatures — regardless of which id-space keyed
// it. clearRun() stays wired for eager reclaim where a caller DOES hold the
// matching id (autonomous-loop.finish()); it is now a fast-path, not the
// correctness boundary.
const stormCounts = new Map<string, Map<string, number>>();

const STORM_MAX_RUNS       = Math.max(16, parseInt(process.env.SELF_HEAL_STORM_MAX_RUNS ?? '256', 10));
const STORM_MAX_SIGNATURES = Math.max(16, parseInt(process.env.SELF_HEAL_STORM_MAX_SIGNATURES ?? '64', 10));

// Map iteration is insertion-order, so we model LRU by re-inserting a touched
// bucket at the most-recently-used end and evicting from the oldest end.
function touchAndBoundRuns(key: string, m: Map<string, number>): void {
  stormCounts.delete(key);
  stormCounts.set(key, m); // re-insert at the MRU end
  while (stormCounts.size > STORM_MAX_RUNS) {
    const oldest = stormCounts.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === key) break; // never evict what we just touched
    stormCounts.delete(oldest);
  }
}

function bumpStorm(runId: string | undefined, signature: string): number {
  const key = runId ?? '_ambient';
  const m = stormCounts.get(key) ?? new Map<string, number>();
  const n = (m.get(signature) ?? 0) + 1;
  m.set(signature, n);

  // Bound per-bucket signature diversity (evict the oldest signature). Applies
  // to EVERY bucket now, not just the ambient one.
  if (m.size > STORM_MAX_SIGNATURES) {
    const firstSig = m.keys().next().value as string | undefined;
    if (firstSig !== undefined) m.delete(firstSig);
  }

  touchAndBoundRuns(key, m);
  return n;
}

export function clearRun(runId: string | undefined): void {
  stormCounts.delete(runId ?? '_ambient');
}

// ── OBSERVE + STORM on a review failure ────────────────────────────────────
export function onReviewFailed(opts: {
  taskId:       string;
  title:        string;
  description?: string;
  feedback:     string;       // the reviewer critique (the failure symptom)
  runId?:       string;
}): ReviewFailureDecision {
  const shadow = config.selfHeal.shadowMode;
  const noop: ReviewFailureDecision = {
    signature: '', suppress: false, stormCount: 0, injectFix: null, fixKind: 'none', shadow,
  };
  if (!config.selfHeal.enabled) return noop;

  try {
    const ev: FailureEvent = buildFailureEvent({
      phase:       'review',
      rawError:    opts.feedback || `review-block: ${opts.title}`,
      taskId:      opts.taskId,
      artifactRef: opts.title,
      runId:       opts.runId,
    });

    recordObservation(ev);
    const stormCount = bumpStorm(opts.runId, ev.signature);
    const storm      = stormCount >= config.selfHeal.stormThreshold;

    // Confidence-gated stored fix (only 'trusted' would be injected live).
    const fix = getFix(ev);

    const decision: ReviewFailureDecision = {
      signature:  ev.signature,
      suppress:   storm && config.selfHeal.stormBreakerActive, // split-gate: storm-breaker
      stormCount,
      injectFix:  (config.selfHeal.fixInjectionActive && fix.kind === 'trusted') ? fix.fix : null, // split-gate: injection
      fixKind:    fix.kind,
      shadow,
    };

    if (storm) {
      logHive('self_heal_storm',
        `Self-heal${shadow ? ' [shadow]' : ''}: signature ${ev.signature} failed ${stormCount}× this run — systemic blocker${shadow ? ' (would suppress)' : ' — SUPPRESSED'}`,
        undefined,
        { signature: ev.signature, stormCount, phase: ev.phase, module: ev.moduleIdent, severity: 'high' },
        opts.runId);
    }
    logger.info(`self-heal: review failure observed${shadow ? ' [shadow]' : ''}`, {
      taskId: opts.taskId, signature: ev.signature, errorClass: ev.errorClass,
      module: ev.moduleIdent, stormCount, fixKind: fix.kind,
      wouldSuppress: storm, wouldInject: fix.kind === 'trusted',
    });
    return decision;
  } catch (err) {
    // Self-heal must NEVER break the review loop — fail-open to no-op.
    logger.warn('self-heal: onReviewFailed error (ignored)', { error: (err as Error).message });
    return noop;
  }
}

// ── OBSERVE + STORM on a tool failure ───────────────────────────────────────
// Called from invokeTool() only for permanent/rate_limited outcomes or for a
// transient that exhausted its retry budget — never for a single transient.
export function onToolFailed(opts: {
  toolName: string;
  error:    string;
  outcome:  ToolOutcome;
  runId?:   string;
}): ReviewFailureDecision {
  const shadow = config.selfHeal.shadowMode;
  const noop: ReviewFailureDecision = {
    signature: '', suppress: false, stormCount: 0, injectFix: null, fixKind: 'none', shadow,
  };
  if (!config.selfHeal.enabled) return noop;

  try {
    const rawError = `${opts.toolName}: ${opts.outcome} — ${opts.error}`;
    const ev: FailureEvent = buildFailureEvent({
      phase:       'tool',
      rawError,
      artifactRef: opts.toolName,
      runId:       opts.runId,
    });

    recordObservation(ev);
    const stormCount = bumpStorm(opts.runId, ev.signature);
    // rate_limited is a WINDOWED transient the tool boundary already spaced-
    // retried (honoring Retry-After). A burst of rate-limits is not a systemic
    // blocker the way a repeating `permanent` failure is — gate it behind a
    // higher count so a busy-upstream window doesn't trip the permanent-blocker
    // suppression at the normal threshold and hand back a hard error instead of
    // letting the next call space-and-retry. (permanent / retry-exhausted
    // transient keep the normal threshold.)
    const threshold  = opts.outcome === 'rate_limited'
      ? config.selfHeal.rateLimitStormThreshold
      : config.selfHeal.stormThreshold;
    const storm      = stormCount >= threshold;
    const fix        = getFix(ev);

    const decision: ReviewFailureDecision = {
      signature:  ev.signature,
      suppress:   storm && config.selfHeal.stormBreakerActive,
      stormCount,
      injectFix:  (config.selfHeal.fixInjectionActive && fix.kind === 'trusted') ? fix.fix : null,
      fixKind:    fix.kind,
      shadow,
    };

    if (storm) {
      logHive('self_heal_storm',
        `Self-heal${shadow ? ' [shadow]' : ''}: tool signature ${ev.signature} failed ${stormCount}×/${threshold} (${opts.outcome}) this run — systemic blocker${shadow ? ' (would suppress)' : ' — SUPPRESSED'}`,
        undefined,
        { signature: ev.signature, stormCount, threshold, outcome: opts.outcome, phase: ev.phase, module: ev.moduleIdent, severity: 'high' },
        opts.runId);
    }
    logger.info(`self-heal: tool failure observed${shadow ? ' [shadow]' : ''}`, {
      toolName: opts.toolName, signature: ev.signature, errorClass: ev.errorClass,
      module: ev.moduleIdent, stormCount, threshold, fixKind: fix.kind, outcome: opts.outcome,
      wouldSuppress: storm,
    });
    return decision;
  } catch (err) {
    logger.warn('self-heal: onToolFailed error (ignored)', { error: (err as Error).message });
    return noop;
  }
}

// ── LEARN on a review pass (Verify = the re-review itself) ──────────────────
// Called when a task passes review. If it carried a prior critique, that critique
// is the symptom the passing attempt just resolved — and the re-review IS the
// function-level verification that it is gone. Credit the fix.
export function onReviewPassed(opts: {
  taskId:        string;
  title:         string;
  priorFeedback?: string;      // critique the successful attempt addressed
  runId?:        string;
}): void {
  if (!config.selfHeal.enabled || !config.selfHeal.learnEnabled) return;
  if (!opts.priorFeedback || !opts.priorFeedback.trim()) return; // clean first-pass, nothing to learn

  try {
    // Signature MUST match the one recorded on the failure that produced this
    // critique — so derive it from the SAME prior critique text.
    const ev = buildFailureEvent({
      phase:       'review',
      rawError:    opts.priorFeedback,
      taskId:      opts.taskId,
      artifactRef: opts.title,
      runId:       opts.runId,
    });
    const fixGuidance =
      `When "${ev.errorClass}" recurs in ${ev.moduleIdent}, the corrective feedback that made re-review pass was:\n${opts.priorFeedback.slice(0, 800)}`;

    void recordVerify(ev, true, fixGuidance);
    logger.info('self-heal: review re-pass — fix verified & learned', {
      taskId: opts.taskId, signature: ev.signature, phase: ev.phase,
    });
    logHive('self_heal_learned',
      `Self-heal: verified fix learned for ${ev.errorClass} in ${ev.moduleIdent} (re-review passed)`,
      undefined, { signature: ev.signature, phase: ev.phase }, opts.runId);
  } catch (err) {
    logger.warn('self-heal: onReviewPassed error (ignored)', { error: (err as Error).message });
  }
}

export { healMemoryStats, candidateFixes } from './failure-memory';
