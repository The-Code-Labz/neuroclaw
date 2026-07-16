// Self-contained tests for durable synchronous hand-off recovery.
// Run with:
//   npx tsx --test src/system/handoff-recovery.test.ts

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';

process.env.DB_PATH = ':memory:';

import { getDb, createSession, saveMessage, getSessionMessages } from '../db';
import {
  startHandoffRecord,
  recoverStuckHandoffs,
  HandoffRecord,
} from './handoff-recovery';

function createAgent(id: string, name: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO agents (id, name, status) VALUES (?, ?, 'active')
  `).run(id, name);
}

function insertHandoffChain(
  sessionA: string,
  sessionB: string,
  sessionC: string,
  sessionD: string,
): { a: string; b: string; c: string } {
  const now = Date.now();
  const a = startHandoffRecord({
    callerSessionId: sessionA,
    callerAgentId: 'agent-a',
    callerRunId: randomUUID(),
    targetAgentId: 'agent-b',
    targetSessionId: sessionB,
    message: 'handoff A→B',
    source: 'message_agent',
  });
  const b = startHandoffRecord({
    callerSessionId: sessionB,
    callerAgentId: 'agent-b',
    callerRunId: randomUUID(),
    targetAgentId: 'agent-c',
    targetSessionId: sessionC,
    message: 'handoff B→C',
    source: 'message_agent',
    parentHandoffId: a,
  });
  const c = startHandoffRecord({
    callerSessionId: sessionC,
    callerAgentId: 'agent-c',
    callerRunId: randomUUID(),
    targetAgentId: 'agent-d',
    targetSessionId: sessionD,
    message: 'handoff C→D',
    source: 'message_agent',
    parentHandoffId: b,
  });

  // Make all three frames stale so a single sweep tries to recover all of them.
  getDb().prepare(`
    UPDATE handoff_recovery SET heartbeat_at = 0 WHERE id IN (?, ?, ?)
  `).run(a, b, c);

  return { a, b, c };
}

before(() => {
  // Force schema creation by touching the DB before tests mutate rows.
  getDb();
  for (const [id, name] of [
    ['agent-a', 'Agent A'],
    ['agent-b', 'Agent B'],
    ['agent-c', 'Agent C'],
    ['agent-d', 'Agent D'],
  ]) {
    createAgent(id, name);
  }
});

test('3-level cascade A→B→C delivers exactly once into A when both hops go stale in one sweep', () => {
  const sessionA = createSession('agent-a', 'Session A');
  const sessionB = createSession('agent-b', 'Session B');
  const sessionC = createSession('agent-c', 'Session C');
  const sessionD = createSession('agent-d', 'Session D');

  const { a, b, c } = insertHandoffChain(sessionA, sessionB, sessionC, sessionD);

  // The only completed peer turn is in D's session; B and A have no output,
  // so the result must be forwarded all the way up to A.
  saveMessage(sessionD, 'assistant', 'C-output', 'agent-d');

  const recovered = recoverStuckHandoffs(0);
  assert.equal(recovered, 3, 'expected all three stale frames to be recovered');

  const rows = getDb()
    .prepare('SELECT status FROM handoff_recovery WHERE id IN (?, ?, ?) ORDER BY depth')
    .all(a, b, c) as { status: string }[];
  assert.deepEqual(rows.map((r) => r.status), ['done', 'done', 'done']);

  const deliveries = getDb()
    .prepare('SELECT COUNT(*) n FROM handoff_deliveries')
    .get() as { n: number };
  assert.equal(deliveries.n, 3, 'expected one delivery ledger row per frame');

  const aMessages = getSessionMessages(sessionA).filter((m) => m.role === 'assistant');
  assert.equal(aMessages.length, 1, 'A session must receive exactly one recovered message');
  assert.equal(aMessages[0].content, 'C-output');

  // A second recovery sweep must not produce duplicate messages.
  const recovered2 = recoverStuckHandoffs(0);
  assert.equal(recovered2, 0);
  const aMessages2 = getSessionMessages(sessionA).filter((m) => m.role === 'assistant');
  assert.equal(aMessages2.length, 1, 'A session must still have exactly one message');
});

test('single stale hand-off is idempotent across repeated sweeps', () => {
  const sessionX = createSession('agent-a', 'Session X');
  const sessionY = createSession('agent-b', 'Session Y');

  const id = startHandoffRecord({
    callerSessionId: sessionX,
    callerAgentId: 'agent-a',
    targetAgentId: 'agent-b',
    targetSessionId: sessionY,
    message: 'single handoff',
    source: 'message_agent',
  });
  getDb().prepare('UPDATE handoff_recovery SET heartbeat_at = 0 WHERE id = ?').run(id);

  saveMessage(sessionY, 'assistant', 'Y-output', 'agent-b');

  assert.equal(recoverStuckHandoffs(0), 1);
  assert.equal(recoverStuckHandoffs(0), 0);

  const xMessages = getSessionMessages(sessionX).filter((m) => m.role === 'assistant');
  assert.equal(xMessages.length, 1);
  assert.equal(xMessages[0].content, 'Y-output');
});
