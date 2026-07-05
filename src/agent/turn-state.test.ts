// Self-contained tests for turn-state. Run with:
//   npx tsx --test src/agent/turn-state.test.ts
// (Node 20+ has `--test` baked in; tsx handles the TS.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTurn, markTurnDone, isTurnFinished, getTurnState,
  updateActivity, bumpTurn, clearTurn, _resetAllTurns,
} from './turn-state';

test('no entry → isTurnFinished returns true (compactor-safe default)', () => {
  _resetAllTurns();
  assert.equal(isTurnFinished('s-1'), true);
});

test('startTurn registers an active turn, isTurnFinished is false', () => {
  _resetAllTurns();
  startTurn({ sessionId: 's-1', runId: 'r-1', agentId: 'a-1' });
  assert.equal(isTurnFinished('s-1'), false);
  const s = getTurnState('s-1');
  assert.ok(s);
  assert.equal(s.runId, 'r-1');
  assert.equal(s.agentId, 'a-1');
  assert.equal(s.signal, null);
  assert.equal(s.turnNumber, 0);
  assert.equal(s.currentActivity, 'thinking');
});

test('markTurnDone sets signal and flips isTurnFinished to true', () => {
  _resetAllTurns();
  startTurn({ sessionId: 's-2', runId: 'r-2', agentId: 'a-2' });
  markTurnDone('s-2', 'done', 'no_tool_calls');
  assert.equal(isTurnFinished('s-2'), true);
  const s = getTurnState('s-2');
  assert.equal(s?.signal, 'done');
  assert.equal(s?.reason, 'no_tool_calls');
});

test('updateActivity changes currentActivity, no-op without entry', () => {
  _resetAllTurns();
  updateActivity('missing', 'tool: foo');           // must not throw
  startTurn({ sessionId: 's-3', runId: 'r-3', agentId: 'a-3' });
  updateActivity('s-3', 'tool: search_memory');
  assert.equal(getTurnState('s-3')?.currentActivity, 'tool: search_memory');
});

test('bumpTurn increments turnNumber', () => {
  _resetAllTurns();
  startTurn({ sessionId: 's-4', runId: 'r-4', agentId: 'a-4' });
  bumpTurn('s-4');
  bumpTurn('s-4');
  bumpTurn('s-4');
  assert.equal(getTurnState('s-4')?.turnNumber, 3);
});

test('clearTurn removes the entry → isTurnFinished true again', () => {
  _resetAllTurns();
  startTurn({ sessionId: 's-5', runId: 'r-5', agentId: 'a-5' });
  clearTurn('s-5');
  assert.equal(isTurnFinished('s-5'), true);
  assert.equal(getTurnState('s-5'), undefined);
});

test('multiple parallel sessions are independent', () => {
  _resetAllTurns();
  startTurn({ sessionId: 'a', runId: 'r-a', agentId: 'agent-a' });
  startTurn({ sessionId: 'b', runId: 'r-b', agentId: 'agent-b' });
  markTurnDone('a', 'done');
  assert.equal(isTurnFinished('a'), true);
  assert.equal(isTurnFinished('b'), false);
  bumpTurn('b');
  assert.equal(getTurnState('a')?.turnNumber, 0);
  assert.equal(getTurnState('b')?.turnNumber, 1);
});

test('startTurn replaces any stale entry for the same session', () => {
  _resetAllTurns();
  startTurn({ sessionId: 's-6', runId: 'r-old', agentId: 'a-1', turnNumber: 12 });
  startTurn({ sessionId: 's-6', runId: 'r-new', agentId: 'a-2' });
  const s = getTurnState('s-6');
  assert.equal(s?.runId, 'r-new');
  assert.equal(s?.turnNumber, 0);
});

test('all three signals are accepted and surfaced', () => {
  _resetAllTurns();
  for (const sig of ['done', 'paused', 'stopped'] as const) {
    startTurn({ sessionId: `s-${sig}`, runId: 'r', agentId: 'a' });
    markTurnDone(`s-${sig}`, sig, `reason-${sig}`);
    assert.equal(getTurnState(`s-${sig}`)?.signal, sig);
    assert.equal(isTurnFinished(`s-${sig}`), true);
  }
});
