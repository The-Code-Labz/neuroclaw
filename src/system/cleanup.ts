import { getDb, logAudit } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { cleanupOldTasks } from './background-tasks';
import { isSessionCleanupRunning } from './session-cleanup';
import { sweepOrphans, sweepUploads } from './workspace';
import { config } from '../config';

export function expireTemporaryAgents(): number {
  const db  = getDb();
  const now = new Date().toISOString();

  const expired = db.prepare(`
    SELECT id, name, expires_at FROM agents
    WHERE temporary = 1 AND status = 'active'
      AND expires_at IS NOT NULL AND expires_at <= ?
  `).all(now) as Array<{ id: string; name: string; expires_at: string }>;

  if (expired.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE agents SET status = 'inactive', updated_at = datetime('now') WHERE id = ?",
  );
  for (const agent of expired) {
    stmt.run(agent.id);
    logAudit('agent_expired', 'agent', agent.id, { name: agent.name, expires_at: agent.expires_at });
    logHive('agent_expired', `cleanup: Temporary agent "${agent.name}" expired and was deactivated`, agent.id, { expires_at: agent.expires_at });
    logger.info('cleanup: temp agent expired', { name: agent.name, id: agent.id });
  }

  return expired.length;
}

function purgeOldDebugLogs(): void {
  try {
    const db = getDb();
    db.prepare("DELETE FROM debug_logs WHERE created_at < datetime('now', '-24 hours')").run();
  } catch { /* non-fatal */ }
}

// Reap orphaned/aged agent workspaces and age out generated uploads/ media.
// Fire-and-forget — these are async and best-effort; never block the tick.
function sweepWorkspaces(): void {
  if (!config.workspace.enabled) return;
  void sweepOrphans().catch(err => logger.warn('cleanup: workspace sweepOrphans failed', { error: (err as Error).message }));
  void sweepUploads().catch(err => logger.warn('cleanup: uploads sweep failed', { error: (err as Error).message }));
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startCleanupScheduler(): void {
  // Singleton guard — prevent duplicate timers if called multiple times
  if (cleanupTimer) {
    logger.warn('cleanup: scheduler already running — skipping duplicate start');
    return;
  }

  const n = expireTemporaryAgents();
  if (n > 0) logger.info(`cleanup: expired ${n} temp agent(s) on startup`);
  purgeOldDebugLogs();
  sweepWorkspaces();

  // Every 5 minutes
  cleanupTimer = setInterval(() => {
    // Don't pile a second table sweep onto the connection while the hourly
    // stale-session sweep (which can run for minutes) is mid-flight — this
    // tick simply defers to the next 5-minute slot.
    if (isSessionCleanupRunning()) {
      logger.debug('cleanup: session-cleanup sweep in progress — deferring this tick');
      return;
    }
    const count = expireTemporaryAgents();
    if (count > 0) logger.info(`cleanup: expired ${count} temp agent(s)`);
    purgeOldDebugLogs();
    cleanupOldTasks(); // evict completed background tasks older than 1h from the in-memory Map
    sweepWorkspaces(); // reap orphaned/aged workspaces + age out generated uploads media
  }, 5 * 60 * 1000);

  logger.info('cleanup: temp-agent scheduler started (every 5 min)');
}

export function stopCleanupScheduler(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info('cleanup: scheduler stopped');
  }
}
