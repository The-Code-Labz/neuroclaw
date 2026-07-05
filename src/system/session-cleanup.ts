/**
 * Session Cleanup Background Agent
 *
 * Periodically cleans up stale sessions to prevent database bloat.
 * Selects sessions by the immutable `source` column (not title patterns).
 * Extracts memories before deleting.
 *
 * DELETABLE sources: comms, spawn, step, sentinel, cron, agent_task
 *
 * NEVER deletes: dashboard, cli, terminal, voice, discord, room, unknown
 */

import { getDb, logAudit } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { config } from '../config';
import { archiveSessionMemories } from '../memory/session-archiver';
import { getMemoryStore } from '../memory/memory-store';

/** Sources cleanup is allowed to delete (agent-machinery bloat). Everything
 *  else — dashboard, cli, terminal, voice, discord, room, unknown — is never
 *  auto-deleted. */
const DELETABLE_SOURCES = ['comms', 'spawn', 'step', 'sentinel', 'cron', 'agent_task'] as const;

export interface StaleSessionRow {
  id:                     string;
  title:                  string | null;
  source:                 string;
  message_count:          number;
  archived_at:            string | null;
  archived_message_count: number;
  updated_at:             string;
  idle_hours:             number;
  has_running_run:        number; // 0 | 1
  has_active_task:        number; // 0 | 1
  has_pending_msg:        number; // 0 | 1
}

/**
 * Returns deletable-source sessions idle for at least CLEANUP_COMMS_MIN_HOURS,
 * with the signals needed to decide whether each has "ended".
 */
export function findStaleSessions(limit = 500): StaleSessionRow[] {
  const db = getDb();
  const placeholders = DELETABLE_SOURCES.map(() => '?').join(',');
  return db.prepare(`
    SELECT
      s.id, s.title, s.source, s.message_count, s.archived_at,
      s.archived_message_count, s.updated_at,
      (julianday('now') - julianday(s.updated_at)) * 24 AS idle_hours,
      EXISTS(SELECT 1 FROM runs r
             WHERE r.session_id = s.id AND r.status = 'running')                       AS has_running_run,
      EXISTS(SELECT 1 FROM tasks t
             WHERE t.session_id = s.id AND t.status IN ('todo','doing','review'))       AS has_active_task,
      EXISTS(SELECT 1 FROM agent_messages am
             WHERE am.session_id = s.id AND am.status = 'pending')                      AS has_pending_msg
    FROM sessions s
    WHERE s.source IN (${placeholders})
      AND s.pinned = 0
      AND COALESCE(s.status, 'active') != 'archived'
      AND (julianday('now') - julianday(s.updated_at)) * 24 >= ?
    ORDER BY idle_hours DESC
    LIMIT ?
  `).all(...DELETABLE_SOURCES, config.cleanup.commsMinHours, limit) as StaleSessionRow[];
}

/** 'force' = past the hard cap, delete regardless of ended-state.
 *  'delete' = within window and ended.  'skip' = not yet deletable. */
function classifyEligibility(row: StaleSessionRow): 'delete' | 'force' | 'skip' {
  if (row.has_running_run) return 'skip';                 // never delete an in-flight run
  if (row.idle_hours > config.cleanup.hardCapHours) return 'force';
  const ended = !row.has_active_task && !row.has_pending_msg;
  return ended ? 'delete' : 'skip';
}

/**
 * Delete a single session and all its related data.
 * Returns the number of messages deleted.
 */
export async function deleteSessionWithRelated(sessionId: string): Promise<{ messagesDeleted: number; memoriesDeleted: number }> {
  const db = getDb();

  // PRESERVE long-term memory rows — detach from the session (don't delete!).
  // Routed through the memory store so it hits the active backend (sqlite|supabase),
  // not a frozen local copy. Done outside the sync transaction below since the
  // store API is async.
  await (await getMemoryStore()).detachSession(sessionId);

  const doDelete = db.transaction(() => {
    // Count messages before deletion
    const msgCount = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }).n;

    // Delete transient data tied to the session (messages, approvals, notes)
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session_prompts WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM comms_notes WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM agent_user_messages WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM approvals WHERE session_id = ?').run(sessionId);

    // PRESERVE analytics and spend - just detach from session (don't delete!)
    // These are critical for historical reporting and should outlive sessions.
    db.prepare('UPDATE analytics_events SET session_id = NULL WHERE session_id = ?').run(sessionId);
    db.prepare('UPDATE model_spend SET session_id = NULL WHERE session_id = ?').run(sessionId);

    // PRESERVE memories - just detach from session (don't delete!).
    // memory_index detach happens above via the memory store (async, pre-transaction).
    db.prepare('UPDATE memories SET session_id = NULL WHERE session_id = ?').run(sessionId);

    // Nullify references in tables where we want to preserve the row
    db.prepare('UPDATE runs SET session_id = NULL WHERE session_id = ?').run(sessionId);
    db.prepare('UPDATE tasks SET session_id = NULL WHERE session_id = ?').run(sessionId);
    db.prepare('UPDATE hive_mind SET session_id = NULL WHERE session_id = ?').run(sessionId);
    db.prepare('UPDATE agent_messages SET session_id = NULL WHERE session_id = ?').run(sessionId);

    // Finally delete the session itself
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    return { messagesDeleted: msgCount, memoriesDeleted: 0 };
  });

  return doDelete();
}

/**
 * Extract memories from, then delete, stale bloat sessions.
 * For each candidate: archive its memories first; delete if ended (>= 24h) or
 * force-delete past the 54h hard cap (even if extraction failed — logged loud).
 */
export async function cleanupStaleSessions(opts: { dryRun?: boolean } = {}): Promise<{
  deleted: number;
  messagesDeleted: number;
  forced: number;
  archived: number;
  dryRun: boolean;
}> {
  const candidates = findStaleSessions(500);
  const maxDelete = 100;                          // safety limit per run
  const maxExtract = config.cleanup.maxExtractPerRun;

  let deleted = 0, messagesDeleted = 0, forced = 0, archived = 0, freshExtracts = 0;

  for (const row of candidates) {
    if (deleted >= maxDelete) break;

    const verdict = classifyEligibility(row);
    if (verdict === 'skip') continue;

    if (opts.dryRun) { deleted++; continue; }

    // Extract memories before deleting. archiveSessionMemories() is a cheap
    // no-op when the session is already archived and unchanged.
    const needsExtraction = !row.archived_at || row.message_count > row.archived_message_count;
    let archiveOk = true;

    if (needsExtraction) {
      // Bound fresh LLM extraction per run — but never defer a force case.
      if (freshExtracts >= maxExtract && verdict !== 'force') continue;
      try {
        const r = await archiveSessionMemories(row.id);
        archiveOk = r.ok;
        if (!r.skipped) { freshExtracts++; if (r.ok) archived++; }
      } catch (err) {
        archiveOk = false;
        logger.warn('cleanup: archive threw', { sessionId: row.id, error: (err as Error).message });
      }
    }

    if (!archiveOk && verdict !== 'force') continue;   // retry next pass

    if (verdict === 'force') forced++;
    if (!archiveOk && verdict === 'force') {
      logger.warn('cleanup: FORCE-DELETING session past hard cap with FAILED memory extraction', {
        sessionId: row.id, source: row.source, idleHours: Math.round(row.idle_hours),
      });
      try {
        logHive('cleanup_force_deleted_unarchived',
          `cleanup: force-deleted un-archived session ${row.id} (${Math.round(row.idle_hours)}h idle)`,
          undefined,
          { session_id: row.id, source: row.source, idle_hours: Math.round(row.idle_hours) });
      } catch { /* best-effort */ }
    }

    try {
      const { messagesDeleted: md } = await deleteSessionWithRelated(row.id);
      messagesDeleted += md;
      deleted++;
      logAudit('session_cleaned_up', 'session', row.id, {
        title: row.title, source: row.source, idle_hours: Math.round(row.idle_hours),
        messages_deleted: md, forced: verdict === 'force',
      });
    } catch (err) {
      logger.error('cleanup: failed to delete session', {
        sessionId: row.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deleted > 0 && !opts.dryRun) {
    logHive('sessions_cleaned_up', `session-cleanup: removed ${deleted} stale session(s)`, undefined, {
      count: deleted, messages_deleted: messagesDeleted, forced, archived,
    });
  }

  return { deleted, messagesDeleted, forced, archived, dryRun: !!opts.dryRun };
}

/**
 * Statistics about session health without deleting anything.
 */
export function getSessionStats(): {
  total: number;
  byCategory: Record<string, number>;
  staleCount: number;
  protectedCount: number;
} {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

  const rows = db.prepare(`
    SELECT COALESCE(source, 'unknown') AS category, COUNT(*) AS count
    FROM sessions GROUP BY COALESCE(source, 'unknown')
  `).all() as Array<{ category: string; count: number }>;

  const categoryMap: Record<string, number> = {};
  for (const r of rows) categoryMap[r.category] = r.count;

  const staleCount = findStaleSessions(500)
    .filter(s => classifyEligibility(s) !== 'skip').length;
  const deletable = (['comms','spawn','step','sentinel','cron','agent_task'] as const)
    .reduce((n, k) => n + (categoryMap[k] ?? 0), 0);

  return { total, byCategory: categoryMap, staleCount, protectedCount: total - deletable };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let cleanupTimer: NodeJS.Timeout | null = null;
let cleanupRunning = false;
let lastRunAt: string | null = null;

/** True while the (potentially minutes-long) stale-session sweep is running.
 *  Other maintenance schedulers (cleanup.ts) consult this to avoid piling
 *  concurrent table sweeps onto the same SQLite connection. */
export function isSessionCleanupRunning(): boolean {
  return cleanupRunning;
}
let lifetimeSessionsCleaned = 0;
let lifetimeMessagesCleaned = 0;

export interface SessionCleanupStatus {
  enabled: boolean;
  lastRun: string | null;
  intervalSec: number;
  lifetimeSessionsCleaned: number;
  lifetimeMessagesCleaned: number;
  currentStaleCount: number;
}

/**
 * Get the current status of the session cleanup scheduler.
 */
export function getSessionCleanupStatus(): SessionCleanupStatus {
  // Load lifetime stats from DB if not already loaded
  if (lifetimeSessionsCleaned === 0) {
    try {
      const db = getDb();
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'session_cleaned_up'"
      ).get() as { n: number };
      lifetimeSessionsCleaned = row.n;
    } catch { /* ignore */ }
  }

  return {
    enabled: cleanupTimer !== null,
    lastRun: lastRunAt,
    intervalSec: 3600, // 1 hour
    lifetimeSessionsCleaned,
    lifetimeMessagesCleaned,
    currentStaleCount: findStaleSessions(500).filter(s => classifyEligibility(s) !== 'skip').length,
  };
}

/**
 * Start the session cleanup scheduler.
 * Runs cleanup on startup and then every hour.
 */
export function startSessionCleanupScheduler(): void {
  if (cleanupTimer) {
    logger.warn('cleanup: scheduler already running — skipping duplicate start');
    return;
  }

  // Helper to run cleanup and update stats
  const runCleanup = async (): Promise<void> => {
    if (cleanupRunning) {
      logger.warn('cleanup: previous run still in progress — skipping this tick');
      return;
    }
    cleanupRunning = true;
    try {
      const result = await cleanupStaleSessions();
      lastRunAt = new Date().toISOString();
      lifetimeSessionsCleaned += result.deleted;
      lifetimeMessagesCleaned += result.messagesDeleted;
      try {
        const db = getDb();
        db.prepare(`
          INSERT INTO config_items (key, value, description, updated_at)
          VALUES ('session_cleanup_last_run', ?, 'Last session cleanup run timestamp', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(lastRunAt);
      } catch { /* ignore */ }
      if (result.deleted > 0) {
        logger.info(`cleanup: pruned ${result.deleted} stale session(s)`, {
          messagesDeleted: result.messagesDeleted, forced: result.forced, archived: result.archived,
        });
      }
    } finally {
      cleanupRunning = false;
    }
  };

  // Run on startup
  void runCleanup();

  // Run every hour
  cleanupTimer = setInterval(() => void runCleanup(), 60 * 60 * 1000);

  logger.info('cleanup: session scheduler started (every 1 hour, source-based)');
}

/**
 * Stop the session cleanup scheduler.
 */
export function stopSessionCleanupScheduler(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info('cleanup: session scheduler stopped');
  }
}

// ── Analytics retention cleanup ─────────────────────────────────────────────
// Separate from session cleanup - prunes old analytics/spend data after N days.
// This allows historical data to be preserved while preventing unbounded growth.

const ANALYTICS_RETENTION_DAYS = 90; // Keep analytics data for 90 days
const SPEND_RETENTION_DAYS = 180;    // Keep spend data for 180 days (billing records)
// hive_mind was previously never pruned (session deletion only nulled
// session_id) and is the highest-volume table after audio_cache — every
// routing decision, tool call, spawn, and heartbeat lands here.
const HIVE_RETENTION_DAYS = parseInt(process.env.HIVE_RETENTION_DAYS ?? '90', 10);
// Idempotency ledger for Discord TTS posts — keys are only consulted within
// minutes of synthesis; 30 days is generous.
const TTS_DELIVERY_RETENTION_DAYS = 30;

let analyticsCleanupTimer: NodeJS.Timeout | null = null;

/**
 * Prune old analytics and spend data based on retention policy.
 * Unlike session cleanup, this is purely time-based - data older than
 * the retention period is removed regardless of session state.
 */
export function pruneOldAnalyticsData(): { analyticsDeleted: number; spendDeleted: number; hiveDeleted: number; ttsDeliveriesDeleted: number } {
  const db = getDb();
  const result = { analyticsDeleted: 0, spendDeleted: 0, hiveDeleted: 0, ttsDeliveriesDeleted: 0 };

  // Each sweep is independent — one failing table must not stop the others.
  try {
    result.analyticsDeleted = db.prepare(`
      DELETE FROM analytics_events
      WHERE created_at < datetime('now', '-${ANALYTICS_RETENTION_DAYS} days')
    `).run().changes;
  } catch (err) {
    logger.warn('cleanup: failed to prune analytics_events', { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    result.spendDeleted = db.prepare(`
      DELETE FROM model_spend
      WHERE created_at < datetime('now', '-${SPEND_RETENTION_DAYS} days')
    `).run().changes;
  } catch (err) {
    logger.warn('cleanup: failed to prune model_spend', { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    result.hiveDeleted = db.prepare(`
      DELETE FROM hive_mind
      WHERE created_at < datetime('now', '-${HIVE_RETENTION_DAYS} days')
    `).run().changes;
  } catch (err) {
    logger.warn('cleanup: failed to prune hive_mind', { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    // Table is created on demand by the TTS delivery ledger — may not exist yet.
    result.ttsDeliveriesDeleted = db.prepare(`
      DELETE FROM tts_deliveries
      WHERE created_at < datetime('now', '-${TTS_DELIVERY_RETENTION_DAYS} days')
    `).run().changes;
  } catch { /* tts_deliveries not created yet — nothing to prune */ }

  if (result.analyticsDeleted > 0 || result.spendDeleted > 0 || result.hiveDeleted > 0 || result.ttsDeliveriesDeleted > 0) {
    logger.info('cleanup: pruned old analytics/spend/hive/tts-ledger data', result);
    try { logAudit('analytics_pruned', 'system', undefined, result); } catch { /* best-effort */ }
  }

  return result;
}

/**
 * Start analytics retention cleanup (runs daily).
 */
export function startAnalyticsRetentionCleanup(): void {
  if (analyticsCleanupTimer) return;

  // Run once on startup (after a delay to not slow down boot)
  setTimeout(() => pruneOldAnalyticsData(), 60_000);

  // Run daily
  analyticsCleanupTimer = setInterval(pruneOldAnalyticsData, 24 * 60 * 60 * 1000);

  logger.info('cleanup: analytics retention started', {
    analyticsRetentionDays: ANALYTICS_RETENTION_DAYS,
    spendRetentionDays: SPEND_RETENTION_DAYS,
    hiveRetentionDays: HIVE_RETENTION_DAYS,
    ttsDeliveryRetentionDays: TTS_DELIVERY_RETENTION_DAYS,
  });
}

export function stopAnalyticsRetentionCleanup(): void {
  if (analyticsCleanupTimer) {
    clearInterval(analyticsCleanupTimer);
    analyticsCleanupTimer = null;
  }
}
