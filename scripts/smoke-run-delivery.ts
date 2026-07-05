/**
 * Smoke test for run-delivery (deliverRun state transitions).
 *
 * Run against a throwaway DB:
 *   DB_PATH=/tmp/smoke-run-delivery.db npx tsx scripts/smoke-run-delivery.ts
 *
 * Exits 0 on pass, 1 on failure. No Discord bot needs to be running —
 * postToChannel returns { ok:false } when no bot is connected, which exercises
 * the failure / retry path without hitting a real Discord channel.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../src/db';
import { deliverRun } from '../src/system/run-delivery';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.error(`  FAIL  ${label}`); failures++; }
}

function seedRun(f: {
  origin: string; status: string; sessionId?: string;
  finalOutput?: string; partialOutput?: string; errorText?: string;
  deliveryTarget?: object | null; delivered?: number;
}): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO runs (id, session_id, origin, user_message, status,
                      final_output, partial_output, error_text, delivery_target, delivered)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, f.sessionId ?? null, f.origin, 'smoke test', f.status,
    f.finalOutput ?? null, f.partialOutput ?? null, f.errorText ?? null,
    f.deliveryTarget ? JSON.stringify(f.deliveryTarget) : null, f.delivered ?? 0,
  );
  return id;
}
function row(id: string): { delivered: number; notify_attempts: number } {
  return getDb().prepare('SELECT delivered, notify_attempts FROM runs WHERE id = ?')
    .get(id) as { delivered: number; notify_attempts: number };
}
function msgCount(sessionId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
    .get(sessionId) as { n: number }).n;
}

async function main(): Promise<void> {
  const sessionId = randomUUID();
  getDb().prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(sessionId, 'smoke');
  const target = { botId: 'x', channelId: 'c', messageId: 'm', userId: 'u', guildId: null };

  // 1. Non-Discord done → delivered = 1.
  const r1 = seedRun({ origin: 'dashboard', status: 'done', finalOutput: 'hi' });
  await deliverRun(r1);
  check('non-discord done → delivered=1', row(r1).delivered === 1);

  // 2. Non-Discord error → delivered = 1 + interrupted message persisted.
  const before = msgCount(sessionId);
  const r2 = seedRun({ origin: 'dashboard', status: 'error', sessionId, partialOutput: 'partial work' });
  await deliverRun(r2);
  check('non-discord error → delivered=1', row(r2).delivered === 1);
  check('non-discord error → interrupted message persisted', msgCount(sessionId) === before + 1);

  // 3. Discord done, no bot → delivered stays 0, notify_attempts = 1.
  const r3 = seedRun({ origin: 'discord', status: 'done', finalOutput: 'answer', deliveryTarget: target });
  await deliverRun(r3);
  check('discord no-bot → delivered stays 0', row(r3).delivered === 0);
  check('discord no-bot → notify_attempts=1', row(r3).notify_attempts === 1);

  // 4. Retry past the cap → delivered = -1.
  for (let i = 0; i < 10; i++) await deliverRun(r3);
  check('discord retry cap → delivered=-1', row(r3).delivered === -1);

  // 5. Already-delivered run → no-op.
  const r5 = seedRun({ origin: 'discord', status: 'done', delivered: 1, deliveryTarget: target });
  await deliverRun(r5);
  check('already-delivered → notify_attempts stays 0', row(r5).notify_attempts === 0);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
