// Loop Engineering — adversarial build → verify → loop-until-gate.
//
// A generic iterative-refinement orchestrator: a BUILDER produces an artifact,
// a VERIFIER grades it against the goal, and if it fails the critique is fed
// back to the builder for a revised attempt — repeating until the gate passes
// or a bound is hit. This is the same shape as the review→repair→re-review loop
// already on main, generalized into a reusable primitive and wired to the
// tier-2 review service as its default verifier.
//
// DESIGN — builder + verifier are INJECTED (LoopDeps), so:
//   • the loop core is pure, synchronous-composable, and unit-testable with fakes;
//   • the loop_run tool wires the real deps (a tool-less LLM builder + reviewInput).
//
// The default builder is a single-shot LLM completion with NO tool access. That
// is a structural property, not a convention: a tool-less builder CANNOT call
// loop_run, so recursive self-invocation is impossible by construction (ASAGI #4).
//
// ASAGI blocking fixes baked in:
//   #1 time bounds, not just round-count  → perRoundTimeoutMs + totalBudgetMs
//   #2 hard synchronous verifier timeout  → verify wrapped in its own withTimeout
//   #3 numeric stall + repeat-critique hash → oscillation/no-progress → 'stalled'
//   #4 recursion guard                    → tool-less builder (structural, above)
//   #5 pre-round cost gate                → projected token spend checked BEFORE a round

import { createHash } from 'crypto';
import { scrubSecrets } from './self-heal/failure-event';

export interface LoopVerdict {
  passed:   boolean;
  feedback: string;               // critique text (empty on pass)
}

export interface LoopBuildCtx {
  goal:          string;
  priorArtifact: string | null;   // null on the first round
  priorFeedback: string | null;   // the critique the current attempt must address
  round:         number;          // 1-based
}

export interface LoopVerifyCtx {
  goal:     string;
  artifact: string;
  round:    number;
}

export interface LoopDeps {
  build:  (ctx: LoopBuildCtx)  => Promise<string>;
  verify: (ctx: LoopVerifyCtx) => Promise<LoopVerdict>;
}

export type LoopStopReason =
  | 'passed'        // gate satisfied
  | 'max_rounds'    // round budget exhausted
  | 'wall_clock'    // total time budget exceeded
  | 'stalled'       // repeat/oscillating critique — no progress
  | 'cost_budget'   // projected token spend would exceed budget
  | 'build_error'   // builder threw / timed out
  | 'verify_error'; // verifier threw / timed out

export interface LoopRound {
  round:        number;
  artifact:     string;
  passed:       boolean;
  feedback:     string;
  critiqueHash: string;
  buildMs:      number;
  verifyMs:     number;
  estTokens:    number;
}

export interface LoopResult {
  passed:        boolean;
  rounds:        number;
  finalArtifact: string;
  finalFeedback: string;
  stopReason:    LoopStopReason;
  history:       LoopRound[];
  elapsedMs:     number;
}

export interface LoopOptions {
  goal:              string;
  maxRounds?:        number;
  perRoundTimeoutMs?: number;
  verifyTimeoutMs?:  number;
  totalBudgetMs?:    number;
  stallLimit?:       number;   // consecutive repeat/oscillating critiques ⇒ stalled
  maxTotalTokens?:   number;   // cost gate (est.)
  runId?:            string;
  onRound?:          (r: LoopRound) => void;
}

// ── helpers ────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  // Clear the pending timer whichever side wins so we never leave a dangling
  // handle keeping the event loop alive.
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Normalized, secret-scrubbed hash of a critique — the stall/oscillation key (ASAGI #3). */
function critiqueHash(feedback: string): string {
  const norm = scrubSecrets(feedback)
    .toLowerCase()
    .replace(/[0-9a-f]{7,40}\b/gi, '')  // shas
    .replace(/:\d+:\d+/g, '')           // line:col
    .replace(/\b\d+\b/g, '')            // bare numbers
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** Rough token estimate (chars/4) for the cost gate — deterministic, no API call. */
function estTokens(...parts: (string | null | undefined)[]): number {
  const chars = parts.reduce((n, p) => n + (p ? p.length : 0), 0);
  return Math.ceil(chars / 4);
}

// ── core loop ────────────────────────────────────────────────────────────────

/**
 * Run the build→verify→loop until the gate passes or a bound is hit. Never
 * throws for a builder/verifier failure — those resolve to a terminal
 * LoopResult with the corresponding stopReason.
 */
export async function runLoop(opts: LoopOptions, deps: LoopDeps): Promise<LoopResult> {
  const maxRounds        = Math.max(1, opts.maxRounds        ?? 4);
  const perRoundTimeoutMs = Math.max(1_000, opts.perRoundTimeoutMs ?? 120_000);
  const verifyTimeoutMs  = Math.max(1_000, opts.verifyTimeoutMs  ?? 45_000);
  const totalBudgetMs    = Math.max(1_000, opts.totalBudgetMs    ?? 420_000);
  const stallLimit       = Math.max(1, opts.stallLimit       ?? 2);
  const maxTotalTokens   = Math.max(1_000, opts.maxTotalTokens ?? 120_000);

  const start   = Date.now();
  const history: LoopRound[] = [];
  const seenHashes = new Set<string>();

  let priorArtifact: string | null = null;
  let priorFeedback: string | null = null;
  let lastHash = '';
  let stallStreak = 0;
  let spentTokens = 0;

  const finish = (
    stopReason: LoopStopReason,
    passed: boolean,
  ): LoopResult => ({
    passed,
    rounds:        history.length,
    finalArtifact: priorArtifact ?? '',
    finalFeedback: priorFeedback ?? '',
    stopReason,
    history,
    elapsedMs:     Date.now() - start,
  });

  for (let round = 1; round <= maxRounds; round++) {
    // ── wall-clock bound (ASAGI #1) — checked BEFORE the round starts ──
    if (Date.now() - start >= totalBudgetMs) {
      return finish('wall_clock', false);
    }

    // ── cost gate (ASAGI #5) — project this round's spend BEFORE spending it ──
    const projected = estTokens(opts.goal, priorArtifact, priorFeedback) + 2_000 /* completion est. */;
    if (spentTokens + projected > maxTotalTokens) {
      return finish('cost_budget', false);
    }

    // ── BUILD (per-round timeout, ASAGI #1) ──
    const buildStart = Date.now();
    let artifact: string;
    try {
      artifact = await withTimeout(
        deps.build({ goal: opts.goal, priorArtifact, priorFeedback, round }),
        perRoundTimeoutMs, `loop-build round ${round}`,
      );
    } catch {
      return finish('build_error', false);
    }
    const buildMs = Date.now() - buildStart;

    // ── VERIFY (independent hard timeout so a hung gate can't deadlock, ASAGI #2) ──
    const verifyStart = Date.now();
    let verdict: LoopVerdict;
    try {
      verdict = await withTimeout(
        deps.verify({ goal: opts.goal, artifact, round }),
        verifyTimeoutMs, `loop-verify round ${round}`,
      );
    } catch {
      // A verifier failure is not the builder's fault — surface the artifact
      // built this round rather than discarding it.
      priorArtifact = artifact;
      history.push({
        round, artifact, passed: false, feedback: 'verifier error',
        critiqueHash: '', buildMs, verifyMs: Date.now() - verifyStart, estTokens: projected,
      });
      return finish('verify_error', false);
    }
    const verifyMs = Date.now() - verifyStart;

    spentTokens += projected;
    const hash = verdict.passed ? '' : critiqueHash(verdict.feedback);
    const rec: LoopRound = {
      round, artifact, passed: verdict.passed, feedback: verdict.feedback,
      critiqueHash: hash, buildMs, verifyMs, estTokens: projected,
    };
    history.push(rec);
    opts.onRound?.(rec);

    priorArtifact = artifact;
    priorFeedback = verdict.feedback;

    // ── PASS → done ──
    if (verdict.passed) {
      return finish('passed', true);
    }

    // ── stall / oscillation detection (ASAGI #3) ──
    // Same critique as last round (no progress) OR a critique we've seen in an
    // EARLIER round (A→B→A oscillation) both count as a stall.
    const repeat = hash === lastHash || seenHashes.has(hash);
    stallStreak = repeat ? stallStreak + 1 : 0;
    seenHashes.add(hash);
    lastHash = hash;
    if (stallStreak >= stallLimit) {
      return finish('stalled', false);
    }
  }

  return finish('max_rounds', false);
}
