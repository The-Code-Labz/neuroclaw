/**
 * Curator — nightly memory backstop.
 *
 * Each night, archives memories from every session not yet fully captured
 * (archived_at IS NULL, or message_count grew since the last archive).
 * Incremental: overflow beyond CURATOR_MAX_SESSIONS_PER_RUN is carried to the
 * next night. The Curator only archives — it never deletes.
 *
 * Runs before the Dream Cycle (02:00 vs 03:00) so freshly archived memories
 * feed nightly consolidation.
 */

import { getDb, logAudit, enqueueJob } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { config } from '../config';
import { archiveSessionMemories } from '../memory/session-archiver';

export interface SweepResult {
  sessionsProcessed: number;
  memoriesExtracted: number;
  failures:          number;
  pending:           number; // dirty sessions not reached this run — carried to the next sweep
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Archive every not-yet-current session, up to CURATOR_MAX_SESSIONS_PER_RUN.
 */
export async function runMemorySweep(): Promise<SweepResult> {
  const empty: SweepResult = { sessionsProcessed: 0, memoriesExtracted: 0, failures: 0, pending: 0 };
  if (running) {
    logger.warn('curator: sweep already in progress — skipping');
    return empty;
  }
  running = true;
  const result: SweepResult = { ...empty };

  try {
    const db = getDb();
    const max = config.curator.maxSessionsPerRun;

    // Count all dirty sessions first, then fetch only this run's batch. Oldest-updated first.
    const dirtyClause = 'archived_at IS NULL OR message_count > archived_message_count';
    const totalDirty = (db.prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE ${dirtyClause}`
    ).get() as { n: number }).n;

    const batch = db.prepare(`
      SELECT id FROM sessions
      WHERE ${dirtyClause}
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(max) as Array<{ id: string }>;

    // Sessions that were dirty but didn't fit in this batch — carried to the next sweep.
    result.pending = Math.max(0, totalDirty - batch.length);

    try {
      logHive('memory_sweep_started', `curator: sweeping ${batch.length} session(s)`, undefined,
        { batch: batch.length, pending: result.pending });
    } catch { /* best-effort */ }

    // Parallelise across sessions (each archive is internally sequential).
    const limit = Math.max(1, config.curator.concurrency);
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < batch.length) {
        const i = idx++;
        try {
          const r = await archiveSessionMemories(batch[i].id);
          if (r.skipped) continue;   // archived elsewhere or session gone — not work, not failure
          if (r.ok) {
            result.sessionsProcessed++;
            result.memoriesExtracted += r.extracted;
          } else {
            result.failures++;
          }
        } catch (err) {
          result.failures++;
          logger.warn('curator: session archive threw', {
            sessionId: batch[i].id, error: (err as Error).message,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, batch.length) }, worker));

    try {
      logHive('memory_sweep_completed',
        `curator: archived ${result.sessionsProcessed} session(s), ${result.memoriesExtracted} memory(ies)`,
        undefined, { ...result });
    } catch { /* best-effort */ }
    logger.info('curator: sweep complete', { ...result });
  } catch (err) {
    logger.warn('curator: sweep threw', { error: (err as Error).message });
  } finally {
    running = false;
  }

  return result;
}

// ── Scheduler (nightly at CURATOR_RUN_TIME) ──────────────────────────────────

function msUntilNext(timeOfDay: string): number {
  const m = timeOfDay.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 24 * 3_600_000;
  const hour = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const min  = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  const now  = new Date();
  const next = new Date(now);
  next.setHours(hour, min, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNext(): void {
  const ms = msUntilNext(config.curator.runTime);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      enqueueJob('maintenance', { task: 'curator_sweep' }, 3, 3, new Date(Date.now() + 5_000));
    } catch (err) { logger.warn('curator: failed to enqueue', { error: (err as Error).message }); }
    scheduleNext();
  }, ms);
  logger.info('curator: scheduled next sweep', {
    runTime: config.curator.runTime, inMinutes: Math.round(ms / 60000),
  });
}

export function startCurator(): void {
  if (!config.curator.enabled) {
    logger.info('curator: disabled (CURATOR_ENABLED=false)');
    return;
  }
  if (timer) {
    logger.warn('curator: scheduler already running — skipping duplicate start');
    return;
  }
  scheduleNext();
}

export function stopCurator(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
