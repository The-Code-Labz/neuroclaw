import { archiveTask, type AppTask } from './task-manager';
import { getDb } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

const ARCHIVE_AGE_MS    = 24 * 60 * 60 * 1000; // 24 hours
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;       // 30 minutes

// Statuses that are terminal — the task will never run again on its own, so
// once it has been idle past ARCHIVE_AGE_MS it only clutters the live board.
// 'failed' is set ONLY on permanent failure (retries exhausted / abort); while
// retrying, job-worker returns the task to 'todo', so a 'failed' row is dead.
// 'cancelled' is terminal by definition. 'blocked' is intentionally excluded —
// a blocked task is parked awaiting input, not finished.
const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const;

let isRunning = false;
let archivistTimer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const cutoff = new Date(Date.now() - ARCHIVE_AGE_MS).toISOString();
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const stale = getDb()
      .prepare(
        `SELECT * FROM tasks
         WHERE archived = 0 AND status IN (${placeholders}) AND updated_at < ?`,
      )
      .all(...TERMINAL_STATUSES, cutoff) as AppTask[];

    if (stale.length === 0) return;

    const archived: string[] = [];
    for (const task of stale) {
      try {
        archiveTask(task.id, 'task-archivist');
        archived.push(task.id);
      } catch (err) {
        logger.warn('task-archivist: failed to archive task', {
          taskId: task.id,
          err: (err as Error).message,
        });
      }
    }

    // archiveTask() emits a per-task logHive('task_updated') internally.
    // This rollup log is intentionally separate — it records the batch
    // summary (count + IDs) for observability, which the per-task logs don't provide.
    logHive(
      'tasks_archived',
      `task-archivist: Archived ${archived.length} terminal task(s) older than 24h`,
      undefined,
      { count: archived.length, taskIds: archived },
    );

    logger.info('task-archivist: sweep complete', { archived: archived.length });
  } catch (err) {
    logger.warn('task-archivist: sweep failed', { err: (err as Error).message });
  } finally {
    isRunning = false;
  }
}

export function startTaskArchivist(): void {
  if (archivistTimer) {
    logger.warn('task-archivist: scheduler already running — skipping duplicate start');
    return;
  }
  void sweep();
  archivistTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  logger.info('task-archivist: started (24h threshold, 30-min interval)');
}
