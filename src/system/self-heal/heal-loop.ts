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

// ── run-level storm breaker (in-memory, per autonomous run) ────────────────
// runId → signature → count. Cleared when a run ends (clearRun) so counts do not
// leak across runs. In-process only, which is correct: a restart ends the run.
const stormCounts = new Map<string, Map<string, number>>();

function bumpStorm(runId: string | undefined, signature: string): number {
  const key = runId ?? '_ambient';
  let m = stormCounts.get(key);
  if (!m) { m = new Map(); stormCounts.set(key, m); }
  const n = (m.get(signature) ?? 0) + 1;
  m.set(signature, n);
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
