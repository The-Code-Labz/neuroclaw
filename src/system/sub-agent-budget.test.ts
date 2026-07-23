// Self-contained tests for the sub-agent graduated budget + fail-streak.
// Run with:
//   npx tsx --test src/system/sub-agent-budget.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBAGENT_TURN_PRESETS,
  resolveSubAgentTurnBudget,
  classifyStreakDelta,
  foldStreak,
} from './sub-agent-budget';

// ── Component A — graduated budget + clamp semantics (ASAGI C1) ─────────────
//
// NOTE: resolveSubAgentTurnBudget's clampRaw param DEFAULTS to
// process.env.SUB_AGENT_MAX_TOOL_TURNS, and JS's default-param rule means
// passing `undefined` explicitly STILL triggers the default (reads process.env).
// So to test the true "unset" path we must clear the env for the assertion — the
// same gotcha that (before this fix) let a leftover SUB_AGENT_MAX_TOOL_TURNS=32
// silently clamp frontier 200 → 32 and make the whole feature a no-op.

test('preset governs when clamp is genuinely unset', () => {
  const saved = process.env.SUB_AGENT_MAX_TOOL_TURNS;
  delete process.env.SUB_AGENT_MAX_TOOL_TURNS;
  try {
    assert.equal(resolveSubAgentTurnBudget('simple'),   SUBAGENT_TURN_PRESETS.simple);
    assert.equal(resolveSubAgentTurnBudget('complex'),  SUBAGENT_TURN_PRESETS.complex);
    assert.equal(resolveSubAgentTurnBudget('frontier'), SUBAGENT_TURN_PRESETS.frontier);
  } finally {
    if (saved !== undefined) process.env.SUB_AGENT_MAX_TOOL_TURNS = saved;
  }
});

test('an explicit empty-string clamp is ignored (NaN → preset governs)', () => {
  // Guards the migration: even a stray `SUB_AGENT_MAX_TOOL_TURNS=` (empty) must
  // NOT clamp to 0/NaN — presets still govern.
  assert.equal(resolveSubAgentTurnBudget('frontier', ''), SUBAGENT_TURN_PRESETS.frontier);
});

test('default presets are 32 / 96 / 200 (env-free)', () => {
  // Only meaningful when the SUB_AGENT_TURNS_* envs are not overridden.
  if (process.env.SUB_AGENT_TURNS_SIMPLE === undefined)   assert.equal(SUBAGENT_TURN_PRESETS.simple,   32);
  if (process.env.SUB_AGENT_TURNS_COMPLEX === undefined)  assert.equal(SUBAGENT_TURN_PRESETS.complex,  96);
  if (process.env.SUB_AGENT_TURNS_FRONTIER === undefined) assert.equal(SUBAGENT_TURN_PRESETS.frontier, 200);
});

test('explicit clamp caps the preset (frontier 200 clamped to 50)', () => {
  assert.equal(resolveSubAgentTurnBudget('frontier', '50'), 50);
  assert.equal(resolveSubAgentTurnBudget('complex',  '50'), 50); // 96 -> 50
  assert.equal(resolveSubAgentTurnBudget('simple',   '50'), 32); // 32 already below clamp
});

test('clamp above preset is a no-op (never RAISES the ceiling)', () => {
  assert.equal(resolveSubAgentTurnBudget('simple', '9999'), SUBAGENT_TURN_PRESETS.simple);
});

test('unknown complexity falls back to simple preset', () => {
  // @ts-expect-error — deliberately passing an invalid complexity
  assert.equal(resolveSubAgentTurnBudget('bogus', undefined), SUBAGENT_TURN_PRESETS.simple);
});

test('non-numeric clamp is ignored (preset governs)', () => {
  assert.equal(resolveSubAgentTurnBudget('frontier', 'notanumber'), SUBAGENT_TURN_PRESETS.frontier);
});

// ── Component B — fail-streak classifier ────────────────────────────────────

test('clean JSON result resets (weight 0)', () => {
  assert.equal(classifyStreakDelta(JSON.stringify({ ok: true, data: [1, 2, 3] })), 0);
  assert.equal(classifyStreakDelta(JSON.stringify({ items: [], nextPageToken: 'x' })), 0);
});

test('non-JSON text result counts as progress (weight 0)', () => {
  assert.equal(classifyStreakDelta('here are the results, page 3 fetched'), 0);
});

test('malformed args / unknown tool are half-weight (self-correcting)', () => {
  assert.equal(classifyStreakDelta(JSON.stringify({ error: 'Invalid web_search arguments' })), 0.5);
  assert.equal(classifyStreakDelta(JSON.stringify({ error: 'Unknown tool: foo. Use search_tools to find available tools.' })), 0.5);
});

test('gated-in-sub-agent error is full weight (retry never works)', () => {
  assert.equal(
    classifyStreakDelta(JSON.stringify({ error: "Tool 'fs_write' is not available inside a sub-agent. Return your result as text." })),
    1,
  );
});

test('ok:false structured error is full weight', () => {
  assert.equal(classifyStreakDelta(JSON.stringify({ ok: false, error: 'upstream 500' })), 1);
});

// ── foldStreak — batch semantics (any clean result resets) ──────────────────

test('any clean result in a batch resets the streak to 0', () => {
  const batch = [
    JSON.stringify({ error: 'Invalid x arguments' }),
    JSON.stringify({ ok: true }), // clean → reset
  ];
  assert.equal(foldStreak(3, batch), 0);
});

test('all-error batch adds the worst (max) weight', () => {
  const batch = [
    JSON.stringify({ error: 'Invalid x arguments' }),                                   // 0.5
    JSON.stringify({ error: "Tool 'x' is not available inside a sub-agent." }),          // 1
  ];
  assert.equal(foldStreak(1, batch), 2); // 1 + max(0.5, 1)
});

test('fail-streak trips at 4 after ~4 full-weight failures; scattered benign among clean never trips', () => {
  const gated = JSON.stringify({ error: "Tool 'x' is not available inside a sub-agent." });
  const clean = JSON.stringify({ ok: true });
  const half  = JSON.stringify({ error: 'Invalid x arguments' });

  // 4 consecutive full-weight → 4 ≥ threshold(4) → would bail
  let s = 0;
  for (let i = 0; i < 4; i++) s = foldStreak(s, [gated]);
  assert.equal(s, 4);

  // Benign half-weights interleaved with clean progress → never accumulates
  let s2 = 0;
  s2 = foldStreak(s2, [half]);   // 0.5
  s2 = foldStreak(s2, [clean]);  // reset → 0
  s2 = foldStreak(s2, [half]);   // 0.5
  s2 = foldStreak(s2, [clean]);  // reset → 0
  assert.ok(s2 < 4);
});
