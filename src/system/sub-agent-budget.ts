// src/system/sub-agent-budget.ts
// Pure, unit-testable helpers for the sub-agent graduated turn budget +
// progress-guard (fail-streak). Extracted from sub-agent-runner.ts so the
// budget math and streak classifier can be tested without mocking Kimi/MiniMax
// clients or the DB. See .planning/specs/2026-07-17-subagent-graduated-budget.md
//
// Design rationale (the origin bug): parent agents run graduated/marathon turn
// budgets, but when they DELEGATE a long bounded job to a run_subtask sub-agent
// it used to run under a flat 16-turn ceiling with no progress-guard — so a
// 44-page paginated fetch died at ~page 6 every time. This module gives
// sub-agents a graduated ceiling keyed off the SAME complexity the triage
// already computes, paired with a fail-streak guard so a big budget on a cheap
// model can't be burned by a flailing loop.

import type { SubAgentComplexity } from './sub-agent-triage';

// ── Component A — graduated budget presets ─────────────────────────────────
// Mirror the parent WORKLOAD_PRESETS philosophy: scale the ceiling to the
// declared complexity instead of one flat number. Env-overridable per tier.
export const SUBAGENT_TURN_PRESETS: Record<SubAgentComplexity, number> = {
  simple:   parseInt(process.env.SUB_AGENT_TURNS_SIMPLE   ?? '32',  10),
  complex:  parseInt(process.env.SUB_AGENT_TURNS_COMPLEX  ?? '96',  10),
  frontier: parseInt(process.env.SUB_AGENT_TURNS_FRONTIER ?? '200', 10),
};

/**
 * Resolve the per-call tool-turn budget for a sub-agent.
 *
 * ⚠️ ASAGI C1 (BLOCKING): the absolute clamp MUST read the RAW
 * `process.env.SUB_AGENT_MAX_TOOL_TURNS` string, NOT `config.subAgent.maxToolTurns`.
 * The config getter is `parseInt(process.env.X ?? '16')` — always a number — so it
 * cannot distinguish "operator pinned 16" from "nobody set it". Sourcing the clamp
 * from config would silently pin EVERY deployment to 16 forever → the whole feature
 * a no-op. So: unset ⇒ presets govern; set ⇒ hard upper bound (Math.min).
 *
 * @param complexity  simple | complex | frontier (from triage)
 * @param clampRaw    raw env string; defaults to process.env at call time (injectable for tests)
 */
export function resolveSubAgentTurnBudget(
  complexity: SubAgentComplexity,
  clampRaw: string | undefined = process.env.SUB_AGENT_MAX_TOOL_TURNS,
): number {
  const preset = SUBAGENT_TURN_PRESETS[complexity] ?? SUBAGENT_TURN_PRESETS.simple;
  if (clampRaw === undefined) return preset;
  const clamp = parseInt(clampRaw, 10);
  if (Number.isNaN(clamp)) return preset;
  return Math.min(preset, clamp);
}

// ── Component B — progress-guard (fail-streak) classifier ──────────────────
// Weight taxonomy built from what dispatchOpenAiTool / dispatchMetaTool /
// dispatchComposioTool ACTUALLY emit on the OpenAI-shaped sub-agent surface —
// NOT the Claude-CLI regex list (those strings never appear here). A clean
// result RESETS the streak (progress). Half-weight = self-correcting model
// mistake (bad JSON / wrong tool name) — Kimi/MiniMax mis-format JSON often, so
// we lean generous. Full-weight = structurally hopeless (gated tool that will
// NEVER succeed on retry) — burn the streak fast.

export type StreakWeight = 0 | 0.5 | 1;

/**
 * Classify one tool result's contribution to the fail-streak.
 *   0   → clean result (RESET the streak — real progress)
 *   0.5 → self-correcting error (malformed args / unknown tool name)
 *   1   → hopeless error (tool gated for sub-agents — retry never works)
 *
 * Non-JSON content is treated as clean (a plain-text tool result = progress).
 */
export function classifyStreakDelta(resultContent: string): StreakWeight {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultContent);
  } catch {
    return 0; // non-JSON text result — progress, reset
  }
  if (!parsed || typeof parsed !== 'object') return 0;
  const p = parsed as { error?: unknown; ok?: unknown; message?: unknown };
  const isError = p.error !== undefined || p.ok === false;
  if (!isError) return 0;

  const msg = String(p.error ?? p.message ?? '');

  // Full-weight: gated inside a sub-agent — retrying the same tool NEVER works.
  if (/is not available inside a sub-agent/i.test(msg)) return 1;

  // Half-weight: self-correcting model formatting mistakes.
  if (/^Invalid\s+.+\s+arguments/i.test(msg)) return 0.5;
  if (/^Unknown tool:/i.test(msg))            return 0.5;

  // Any other structured error — full weight.
  return 1;
}

/**
 * Fold a turn's batch of tool results into the running fail-streak.
 * A turn may fire multiple tool_calls; if ANY came back clean, the model made
 * progress → reset to 0. Otherwise add the worst (max) error weight of the batch.
 *
 * @returns the new streak value.
 */
export function foldStreak(current: number, resultContents: string[]): number {
  if (resultContents.length === 0) return current;
  const deltas = resultContents.map(classifyStreakDelta);
  if (deltas.some(d => d === 0)) return 0; // any clean result = progress
  return current + Math.max(...deltas);
}
