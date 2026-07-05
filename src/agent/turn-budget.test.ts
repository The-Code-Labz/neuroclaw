// Self-contained tests for turn-budget. Run with:
//   npx tsx --test src/agent/turn-budget.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurnBudget, WORKLOAD_PRESETS, isValidProfile } from './turn-budget';

test('null/undefined agent → normal preset', () => {
  assert.deepEqual(resolveTurnBudget(undefined), WORKLOAD_PRESETS.normal);
  assert.deepEqual(resolveTurnBudget(null), WORKLOAD_PRESETS.normal);
});

test('agent with no fields uses normal preset', () => {
  assert.deepEqual(resolveTurnBudget({}), WORKLOAD_PRESETS.normal);
});

test('workload_profile=heavy maps to heavy preset', () => {
  assert.deepEqual(resolveTurnBudget({ workload_profile: 'heavy' }), WORKLOAD_PRESETS.heavy);
});

test('workload_profile=marathon maps to marathon preset', () => {
  assert.deepEqual(resolveTurnBudget({ workload_profile: 'marathon' }), WORKLOAD_PRESETS.marathon);
});

test('unknown profile name falls back to normal', () => {
  assert.deepEqual(resolveTurnBudget({ workload_profile: 'bogus' }), WORKLOAD_PRESETS.normal);
});

test('explicit max_turns_soft overrides preset soft, hard stays from preset', () => {
  const b = resolveTurnBudget({ workload_profile: 'normal', max_turns_soft: 5 });
  assert.equal(b.soft, 5);
  assert.equal(b.hard, WORKLOAD_PRESETS.normal.hard);
});

test('explicit max_turns_hard overrides preset hard, soft stays from preset', () => {
  const b = resolveTurnBudget({ workload_profile: 'normal', max_turns_hard: 999 });
  assert.equal(b.soft, WORKLOAD_PRESETS.normal.soft);
  assert.equal(b.hard, 999);
});

test('both explicit override both', () => {
  const b = resolveTurnBudget({ max_turns_soft: 7, max_turns_hard: 13 });
  assert.deepEqual(b, { soft: 7, hard: 13 });
});

test('hard < soft is clamped to soft', () => {
  const b = resolveTurnBudget({ max_turns_soft: 100, max_turns_hard: 50 });
  assert.equal(b.soft, 100);
  assert.equal(b.hard, 100);
});

test('session.max_turns_override clamps both', () => {
  const b = resolveTurnBudget({ workload_profile: 'heavy' }, { max_turns_override: 42 });
  assert.deepEqual(b, { soft: 42, hard: 42 });
});

test('session.max_turns_override beats explicit agent values', () => {
  const b = resolveTurnBudget(
    { max_turns_soft: 5, max_turns_hard: 10 },
    { max_turns_override: 99 },
  );
  assert.deepEqual(b, { soft: 99, hard: 99 });
});

test('zero / negative / NaN values are treated as null', () => {
  // soft=0 should fall back to preset, not be honored as "no budget"
  assert.deepEqual(
    resolveTurnBudget({ max_turns_soft: 0, max_turns_hard: -5 }),
    WORKLOAD_PRESETS.normal,
  );
  assert.deepEqual(
    resolveTurnBudget({ max_turns_soft: Number.NaN as unknown as number }),
    WORKLOAD_PRESETS.normal,
  );
});

test('session override = 0 is ignored (treated as null)', () => {
  const b = resolveTurnBudget({ workload_profile: 'normal' }, { max_turns_override: 0 });
  assert.deepEqual(b, WORKLOAD_PRESETS.normal);
});

test('isValidProfile recognizes all four presets', () => {
  for (const p of ['light', 'normal', 'heavy', 'marathon']) {
    assert.equal(isValidProfile(p), true);
  }
  assert.equal(isValidProfile('something-else'), false);
  assert.equal(isValidProfile(null), false);
  assert.equal(isValidProfile(undefined), false);
});

test('WORKLOAD_PRESETS values are sane (soft < hard, both positive)', () => {
  for (const [, v] of Object.entries(WORKLOAD_PRESETS)) {
    assert.ok(v.soft > 0);
    assert.ok(v.hard > 0);
    assert.ok(v.soft <= v.hard);
  }
});
