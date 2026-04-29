import { getDb, logAudit } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

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
    logHive('agent_expired', `Temporary agent "${agent.name}" expired and was deactivated`, agent.id, { expires_at: agent.expires_at });
    logger.info('Temporary agent expired', { name: agent.name, id: agent.id });
  }

  return expired.length;
}

export function startCleanupScheduler(): void {
  const n = expireTemporaryAgents();
  if (n > 0) logger.info(`Cleaned up ${n} expired temporary agent(s) on startup`);

  // Every 5 minutes
  setInterval(() => {
    const count = expireTemporaryAgents();
    if (count > 0) logger.info(`Cleaned up ${count} expired temporary agent(s)`);
  }, 5 * 60 * 1000);

  logger.info('Temp-agent cleanup scheduler started (every 5 min)');
}
