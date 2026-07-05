import { getDb, getAgentByName, enqueueJob, bumpFailureCount } from '../db';
import { updateTask, recoverStuckReviewTasks } from './task-manager';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { isTaskLive } from './task-liveness';

const STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS   = 10 * 60 * 1000;

interface StuckTaskRow {
  id:                string;
  title:             string;
  description:       string | null;
  agent_id:          string | null;
  assignee:          string;
  failure_count:     number;
  max_retries:       number;
  agent_name:        string | null;
  agent_status:      string | null;
  last_heartbeat_at: number | null;
}

interface OrphanedTaskRow {
  id:                string;
  title:             string;
  previous_agent_id: string;
}

async function recoverOrphanedTasks(): Promise<void> {
  const db = getDb();

  const orphaned = db.prepare(`
    SELECT t.id, t.title, t.agent_id AS previous_agent_id
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    WHERE t.status   = 'doing'
      AND t.archived = 0
      AND t.agent_id IS NOT NULL
      AND (a.id IS NULL OR a.status != 'active')
  `).all() as OrphanedTaskRow[];

  if (orphaned.length === 0) return;
  logger.info(`task-watchdog: found ${orphaned.length} orphaned task(s) with inactive/deleted agent`);

  for (const task of orphaned) {
    try {
      updateTask(task.id, { status: 'todo', agent_id: null });
      logHive('orphaned_doing_task_requeued', `task-watchdog: Task "${task.title}" reset to todo — agent ${task.previous_agent_id} is inactive/deleted`, undefined, { taskId: task.id, previousAgentId: task.previous_agent_id, source: 'watchdog' });
      logger.info(`task-watchdog: orphaned task "${task.title}" (${task.id}) reset — previous agent ${task.previous_agent_id}`);
    } catch (err) {
      logger.warn(`task-watchdog: failed to reset orphaned task ${task.id}`, { error: (err as Error).message });
    }
  }
}

async function recoverStuckTasks(): Promise<void> {
  const db = getDb();

  // Age check in SQL via julianday(): parses both timestamp formats present in
  // tasks ('YYYY-MM-DD HH:MM:SS' and ISO-T/Z) as UTC. The previous comparison
  // against a JS ISO string matched every space-format 'doing' task instantly
  // (space sorts below 'T'), so fresh tasks were yanked back to 'todo' with a
  // failure_count bump and force-failed after 3 watchdog cycles.
  const stuck = db.prepare(`
    SELECT t.id, t.title, t.description, t.agent_id, t.assignee, t.failure_count,
           t.max_retries, t.last_heartbeat_at,
           a.name AS agent_name, a.status AS agent_status
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    WHERE t.status  = 'doing'
      AND t.archived = 0
      AND (julianday('now') - julianday(t.updated_at)) * 86400000 >= ?
      AND NOT EXISTS (
        SELECT 1 FROM job_queue jq
        WHERE jq.status IN ('pending', 'claimed')
          AND json_extract(jq.payload, '$.taskId') = t.id
      )
  `).all(STUCK_THRESHOLD_MS) as StuckTaskRow[];

  const live = stuck.filter(t => isTaskLive({ id: t.id, agent_id: t.agent_id, last_heartbeat_at: t.last_heartbeat_at }));
  const dead = stuck.filter(t => !live.includes(t));
  if (live.length > 0) logger.info(`task-watchdog: skipped ${live.length} live task(s) past 2h threshold (still heartbeating)`);

  if (stuck.length === 0) return;
  if (dead.length === 0) return;
  logger.info(`task-watchdog: found ${dead.length} stuck task(s)`);

  for (const task of dead) {
    // Honor the task's own retry budget and use the SAME comparison as the
    // holdout-reviewer (retry while failure_count < max_retries; fail at/over)
    // so a given failure_count is deterministic regardless of which monitor
    // touches the task. Increment atomically (no read-modify-write race).
    const maxRetries = task.max_retries ?? 3;
    if (task.failure_count >= maxRetries) {
      updateTask(task.id, {
        status:     'failed',
        last_error: `Stuck: exceeded recovery limit after ${maxRetries} attempts`,
      });
      logHive('task_recovered', `task-watchdog: Task "${task.title}" marked failed after exceeding ${maxRetries} stuck recoveries`, undefined, {
        taskId: task.id, action: 'failed', failureCount: task.failure_count,
      });
      logger.warn(`task-watchdog: task "${task.title}" (${task.id}) marked failed — exceeded recovery limit`);
      continue;
    }

    const newFailureCount = bumpFailureCount(task.id);
    updateTask(task.id, { status: 'todo' });

    let agentId   = task.agent_id ?? null;
    let agentName = task.agent_name ?? null;

    if (!agentId && task.assignee && task.assignee !== 'User') {
      const resolved = getAgentByName(task.assignee);
      if (resolved && resolved.status === 'active') {
        agentId   = resolved.id;
        agentName = resolved.name;
      }
    }

    if (agentId && agentName) {
      enqueueJob('agent_task', {
        taskId:          task.id,
        agentId,
        agentName,
        taskTitle:       task.title,
        taskDescription: task.description ?? '',
      });
      logHive('task_recovered', `task-watchdog: Task "${task.title}" recovered and re-enqueued for ${agentName}`, agentId, {
        taskId: task.id, action: 're-enqueued', failureCount: newFailureCount,
      });
      logger.info(`task-watchdog: re-enqueued "${task.title}" for agent ${agentName}`);
    } else {
      logHive('task_recovered', `task-watchdog: Task "${task.title}" reset to todo (no agent resolved)`, undefined, {
        taskId: task.id, action: 'reset-only', failureCount: newFailureCount, assignee: task.assignee,
      });
      logger.info(`task-watchdog: reset "${task.title}" to todo — no agent resolved from assignee="${task.assignee}"`);
    }
  }
}

let watchdogTimer: NodeJS.Timeout | null = null;

export function startTaskWatchdog(): void {
  const runCycle = async (): Promise<void> => {
    await recoverOrphanedTasks().catch(err =>
      logger.warn('task-watchdog: orphan scan error', { error: (err as Error).message }),
    );
    await recoverStuckTasks().catch(err =>
      logger.warn('task-watchdog: stuck scan error', { error: (err as Error).message }),
    );
    // Re-fire the holdout verdict for any task stranded in 'review' for >5min
    // (a live verdict resolves in seconds, so the threshold avoids double-firing
    // one that is still pending in-process).
    try {
      const recovered = recoverStuckReviewTasks(5 * 60 * 1000);
      if (recovered > 0) logger.info(`task-watchdog: re-fired holdout verdict for ${recovered} stranded 'review' task(s)`);
    } catch (err) {
      logger.warn('task-watchdog: review recovery error', { error: (err as Error).message });
    }
  };

  runCycle();
  watchdogTimer = setInterval(() => void runCycle(), POLL_INTERVAL_MS);
  logger.info('task-watchdog: started (orphan pass + 2h stuck threshold, 10m interval)');
}

export function stopTaskWatchdog(): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}
