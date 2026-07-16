// Handoff-recovery retention sweep.
//
// Terminal handoff_recovery rows are useful for a short post-mortem window but
// would grow unbounded. This archivist deletes terminal records older than
// HANDOFF_RECOVERY_TTL_DAYS, mirroring the task-archivist pattern.

import { getDb } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

const HANDOFF_RECOVERY_TTL_DAYS = 7;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const TERMINAL_STATUSES = ['done', 'failed', 'orphaned'] as const;

let isRunning = false;
let archivistTimer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const cutoff = new Date(
      Date.now() - HANDOFF_RECOVERY_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const result = getDb().prepare(`
      DELETE FROM handoff_recovery
      WHERE status IN (${placeholders}) AND created_at < ?
    `).run(...TERMINAL_STATUSES, cutoff);

    if (result.changes > 0) {
      logHive(
        'tasks_archived',
        `handoff-archivist: pruned ${result.changes} terminal hand-off record(s) older than ${HANDOFF_RECOVERY_TTL_DAYS}d`,
        undefined,
        { count: result.changes, ttlDays: HANDOFF_RECOVERY_TTL_DAYS },
      );
      logger.info('handoff-archivist: sweep complete', { pruned: result.changes });
    }
  } catch (err) {
    logger.warn('handoff-archivist: sweep failed', { err: (err as Error).message });
  } finally {
    isRunning = false;
  }
}

export function startHandoffArchivist(): void {
  if (archivistTimer) {
    logger.warn('handoff-archivist: scheduler already running — skipping duplicate start');
    return;
  }
  void sweep();
  archivistTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  logger.info('handoff-archivist: started', { ttlDays: HANDOFF_RECOVERY_TTL_DAYS, intervalMs: SWEEP_INTERVAL_MS });
}

export function stopHandoffArchivist(): void {
  if (archivistTimer) {
    clearInterval(archivistTimer);
    archivistTimer = null;
  }
}
