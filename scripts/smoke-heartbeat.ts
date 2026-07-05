/**
 * Smoke test for the per-run heartbeat → runs.last_heartbeat_at write path.
 *
 * Regression guard for the turn-state wiring bug: startHeartbeat's tick reads
 * getTurnState(); with no startTurn() the tick never reaches updateRunHeartbeat,
 * so last_heartbeat_at stays null and the stale-run sweeper false-drops the run
 * once it is older than AGENT_RUN_STALE_MS.
 *
 *   DB_PATH=/tmp/smoke-heartbeat.db npx tsx scripts/smoke-heartbeat.ts
 *
 * Exits 0 on pass, 1 on failure.
 */
import { randomUUID } from 'node:crypto';
import { getDb, getRun } from '../src/db';
import { startHeartbeat } from '../src/agent/heartbeat';
import { startTurn, clearTurn } from '../src/agent/turn-state';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.error(`  FAIL  ${label}`); failures++; }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function seedRun(): { sessionId: string; runId: string } {
  const sessionId = randomUUID();
  const runId = randomUUID();
  getDb().prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(sessionId, 'smoke-hb');
  getDb().prepare(
    "INSERT INTO runs (id, session_id, origin, user_message, status) VALUES (?, ?, 'dashboard', 'smoke', 'running')",
  ).run(runId, sessionId);
  return { sessionId, runId };
}

async function main(): Promise<void> {
  // A. Bug repro — a heartbeat with NO turn-state registered never persists.
  {
    const { sessionId, runId } = seedRun();
    const stop = startHeartbeat(sessionId, runId, () => {}, 40);
    await sleep(170);
    stop();
    check('no startTurn → last_heartbeat_at stays null', getRun(runId)?.last_heartbeat_at == null);
  }

  // B. Fixed path — startTurn registered → heartbeat persists on every tick.
  {
    const { sessionId, runId } = seedRun();
    startTurn({ sessionId, runId, agentId: 'agent-smoke' });
    const stop = startHeartbeat(sessionId, runId, () => {}, 40);
    await sleep(170);
    stop();
    clearTurn(sessionId);
    const run = getRun(runId);
    check('with startTurn → last_heartbeat_at written', run?.last_heartbeat_at != null);
    check('with startTurn → current_activity written', run?.current_activity === 'thinking');
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
