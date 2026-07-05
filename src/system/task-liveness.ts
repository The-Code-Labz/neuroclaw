// Single source of truth for "is this task actively being worked on right now".
// A task is LIVE if ANY of three already-maintained signals is fresh:
//   L1  active job  — a job_queue row for this task is pending, or claimed with
//                     a fresh claimed_at (the 20s job-worker heartbeat).
//   L2  busy agent  — the assigned agent has a runs row whose last_heartbeat_at
//                     is fresh (the 10s per-turn heartbeat; chat-turn execution).
//   L3  task beat   — tasks.last_heartbeat_at is fresh (stamped by job-worker).
// Monitors MUST treat a live task as untouchable. Mirrors the heartbeat-age
// pattern already used by stale-run-sweeper.ts.

import { getDb } from '../db';

const LIVENESS_WINDOW_MS =
  Math.max(1, Number(process.env.TASK_LIVENESS_WINDOW_MIN ?? '3')) * 60_000;
const JOB_CLAIM_FRESH_MS = 60_000; // matches recoverStaleClaims default

export interface LivenessInput {
  id:                 string;
  agent_id:           string | null;
  last_heartbeat_at:  number | null; // epoch-ms
}

export function isTaskLive(task: LivenessInput, now: number = Date.now()): boolean {
  // L3 — explicit task heartbeat (epoch-ms)
  if (task.last_heartbeat_at && now - task.last_heartbeat_at < LIVENESS_WINDOW_MS) {
    return true;
  }

  const db = getDb();

  // L1 — active job for this task
  const job = db.prepare(`
    SELECT claimed_at FROM job_queue
    WHERE status IN ('pending','claimed')
      AND json_extract(payload,'$.taskId') = ?
    LIMIT 1
  `).get(task.id) as { claimed_at: string | null } | undefined;
  if (job) {
    if (!job.claimed_at) return true;                          // pending = queued to run
    if (now - Date.parse(job.claimed_at) < JOB_CLAIM_FRESH_MS) return true;
  }

  // L2 — assigned agent currently running anything (ISO-text heartbeat)
  if (task.agent_id) {
    const run = db.prepare(`
      SELECT last_heartbeat_at FROM runs
      WHERE initiating_agent_id = ? AND last_heartbeat_at IS NOT NULL
      ORDER BY last_heartbeat_at DESC LIMIT 1
    `).get(task.agent_id) as { last_heartbeat_at: string | null } | undefined;
    if (run?.last_heartbeat_at && now - Date.parse(run.last_heartbeat_at) < LIVENESS_WINDOW_MS) {
      return true;
    }
  }

  return false;
}
