// Loop Engineering — real-dependency wiring for the loop_run tool.
//
// Plugs concrete deps into the pure runLoop engine:
//   • BUILDER  — a single-shot LLM completion with NO tool access. Tool-less is
//     the recursion guard (ASAGI #4): the builder cannot call loop_run, so a
//     loop can never spawn itself. Uses config.loop.builderModel.
//   • VERIFIER — the in-process tier-2 review service (reviewInput), mapped to a
//     LoopVerdict. Reuses the existing pre-gate → tier-1 → tier-2 pipeline and
//     its fail-open invariant.

import { bgChatCompletion } from '../agent/openai-client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';
import { reviewInput } from './review-service';
import { runLoop, LoopResult, LoopBuildCtx, LoopVerifyCtx, LoopVerdict } from './loop-engine';

export interface LoopTaskOptions {
  goal:          string;
  artifactKind?: 'code' | 'prose' | 'unknown';
  acceptance?:   string;   // extra pass criteria folded into build + verify
  maxRounds?:    number;
  runId?:        string;
}

const BUILDER_SYSTEM = `You are a focused BUILDER in an iterative refine loop. Produce the BEST \
possible artifact that fully satisfies the goal and any acceptance criteria.

Rules:
- Output ONLY the artifact itself — no preamble, no explanation, no code fences unless the \
artifact IS code (then fence it).
- If PRIOR FEEDBACK is given, it is a reviewer critique of your last attempt. Address EVERY \
point in it. Do not regress anything that already worked.
- If a PRIOR ARTIFACT is given, revise it — do not restart from scratch unless the feedback \
demands it.`;

async function buildOnce(ctx: LoopBuildCtx, acceptance?: string): Promise<string> {
  const parts = [`GOAL:\n${ctx.goal}`];
  if (acceptance)         parts.push(`ACCEPTANCE CRITERIA:\n${acceptance}`);
  if (ctx.priorArtifact)  parts.push(`PRIOR ARTIFACT (revise this):\n${ctx.priorArtifact.slice(0, 8000)}`);
  if (ctx.priorFeedback)  parts.push(`PRIOR FEEDBACK (address every point):\n${ctx.priorFeedback.slice(0, 4000)}`);

  const resp = await bgChatCompletion({
    model:       config.loop.builderModel,   // resolved by lane below
    max_tokens:  4000,
    temperature: 0.4,
    messages: [
      { role: 'system', content: BUILDER_SYSTEM },
      { role: 'user',   content: parts.join('\n\n') },
    ],
  }, config.loop.builderModel.toLowerCase().startsWith('minimax')
    ? { preferMinimax: true, minimaxModel: config.loop.builderModel, label: 'loop-build' }
    : { voidaiModel: config.loop.builderModel, label: 'loop-build' });

  return resp.choices[0]?.message?.content ?? '';
}

function makeVerifier(opts: LoopTaskOptions) {
  return async (ctx: LoopVerifyCtx): Promise<LoopVerdict> => {
    const request = opts.acceptance
      ? `${ctx.goal}\n\nAcceptance criteria (must ALL be met):\n${opts.acceptance}`
      : ctx.goal;
    const agg = await reviewInput({
      request,
      artifact:     ctx.artifact,
      artifactKind: opts.artifactKind ?? 'unknown',
      runId:        opts.runId,
    });
    return { passed: agg.passed, feedback: agg.feedback || '' };
  };
}

/**
 * Drive a full build→verify→loop for a goal and return the terminal result.
 * Never throws — builder/verifier failures resolve to a terminal LoopResult.
 */
export async function runLoopTask(opts: LoopTaskOptions): Promise<LoopResult> {
  if (!config.loop.enabled) {
    return {
      passed: false, rounds: 0, finalArtifact: '', finalFeedback: 'loop engineering disabled',
      stopReason: 'cost_budget', history: [], elapsedMs: 0,
    };
  }

  const result = await runLoop({
    goal:              opts.goal,
    maxRounds:         opts.maxRounds ?? config.loop.maxRounds,
    perRoundTimeoutMs: config.loop.perRoundTimeoutMs,
    verifyTimeoutMs:   config.loop.verifyTimeoutMs,
    totalBudgetMs:     config.loop.totalBudgetMs,
    stallLimit:        config.loop.stallLimit,
    maxTotalTokens:    config.loop.maxTotalTokens,
    runId:             opts.runId,
    onRound: (r) => {
      logger.info('loop: round complete', {
        round: r.round, passed: r.passed, buildMs: r.buildMs, verifyMs: r.verifyMs,
      });
    },
  }, {
    build:  (ctx) => buildOnce(ctx, opts.acceptance),
    verify: makeVerifier(opts),
  });

  logHive(result.passed ? 'loop_passed' : 'loop_stopped',
    `Loop: ${result.passed ? 'PASSED' : `stopped (${result.stopReason})`} after ${result.rounds} round(s) in ${result.elapsedMs}ms`,
    undefined,
    { passed: result.passed, rounds: result.rounds, stopReason: result.stopReason },
    opts.runId);

  return result;
}
