// Runtime verification for isTaskLive(). Uses a throwaway DB so it never
// touches the real one. Run: npx tsx scripts/task-liveness-check.ts
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DB_PATH = join(tmpdir(), `liveness-check-${randomUUID()}.db`);
process.env.TASK_LIVENESS_WINDOW_MIN = '3';

// Wrapped in async IIFE because the project is CommonJS (top-level await unsupported).
(async () => {
  const { getDb } = await import('../src/db');
  const { isTaskLive } = await import('../src/system/task-liveness');

  // getDb() calls initSchema + runMigrations internally on first call
  const db = getDb();
  const now = Date.now();
  let failures = 0;
  function check(name: string, cond: boolean): void {
    if (cond) { console.log(`  ok  ${name}`); }
    else { console.error(`FAIL  ${name}`); failures++; }
  }

  // Case A: fresh task heartbeat → live (L3)
  check('fresh task heartbeat is live',
    isTaskLive({ id: 'a', agent_id: null, last_heartbeat_at: now - 30_000 }, now) === true);

  // Case B: stale task heartbeat, no job, no run → dead
  check('stale heartbeat with nothing else is dead',
    isTaskLive({ id: 'b', agent_id: null, last_heartbeat_at: now - 10 * 60_000 }, now) === false);

  // Case C: claimed job with fresh claimed_at → live (L1)
  const taskC = 'c';
  db.prepare(`INSERT INTO job_queue (id, type, payload, status, claimed_at, attempts, max_attempts, created_at)
              VALUES (?, 'agent_task', ?, 'claimed', ?, 0, 3, ?)`)
    .run(randomUUID(), JSON.stringify({ taskId: taskC }), new Date(now - 10_000).toISOString(), new Date(now).toISOString());
  check('claimed fresh job is live',
    isTaskLive({ id: taskC, agent_id: null, last_heartbeat_at: null }, now) === true);

  // Case D: claimed job with STALE claimed_at, no heartbeat → dead
  const taskD = 'd';
  db.prepare(`INSERT INTO job_queue (id, type, payload, status, claimed_at, attempts, max_attempts, created_at)
              VALUES (?, 'agent_task', ?, 'claimed', ?, 0, 3, ?)`)
    .run(randomUUID(), JSON.stringify({ taskId: taskD }), new Date(now - 5 * 60_000).toISOString(), new Date(now).toISOString());
  check('claimed stale job is dead',
    isTaskLive({ id: taskD, agent_id: null, last_heartbeat_at: null }, now) === false);

  // Case E: assigned agent with fresh run heartbeat → live (L2)
  const agentE = randomUUID();
  const sessionE = randomUUID();
  db.prepare(`INSERT INTO agents (id, name) VALUES (?, 'TestAgentE')`).run(agentE);
  db.prepare(`INSERT INTO sessions (id, status) VALUES (?, 'active')`).run(sessionE);
  db.prepare(`INSERT INTO runs (id, session_id, origin, user_message, initiating_agent_id, status, started_at, last_heartbeat_at)
              VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`)
    .run(randomUUID(), sessionE, 'api', 'test message', agentE, new Date(now).toISOString(),
         new Date(now - 20_000).toISOString().replace('T', ' ').replace('Z', ''));
  check('busy agent (fresh run heartbeat) keeps its task live',
    isTaskLive({ id: 'e', agent_id: agentE, last_heartbeat_at: null }, now) === true);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
