// TaskHealthMonitor — watches tasks stuck in 'doing' and alerts via AlertDispatcher.
//
// Independent of Sentinel's escalation ladder. Sentinel nudges agents;
// this monitor alerts the human. Three tiers: warn (30m), error (2h), critical (8h).
// Dedup key includes the tier so each task fires each tier at most once per window.

import { getDb } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sendAlert } from './alert-dispatcher';

interface StuckTask {
  id:            string;
  title:         string;
  updated_at:    string;
  agent_name:    string | null;
  minutes_stuck: number;
}

function findStuckTasks(minMinutes: number): StuckTask[] {
  // Age math lives in SQL via julianday(), which parses BOTH timestamp formats
  // present in tasks ('YYYY-MM-DD HH:MM:SS' from datetime('now') writers and
  // the ISO-T/Z schema default) as UTC. The previous JS comparison broke two
  // ways: the ISO threshold string ('...T...Z') sorts above every space-format
  // timestamp on the same date (space < 'T'), matching every 'doing' task
  // instantly; and new Date('YYYY-MM-DD HH:MM:SS') parses as LOCAL time, so on
  // a UTC-offset host the age came out negative ("Task stuck for -420m").
  return getDb().prepare(`
    SELECT t.id, t.title, t.updated_at, a.name AS agent_name,
           CAST((julianday('now') - julianday(t.updated_at)) * 1440 AS INTEGER) AS minutes_stuck
    FROM tasks t
    LEFT JOIN agents a ON t.agent_id = a.id
    WHERE t.status  = 'doing'
      AND t.archived = 0
      AND (julianday('now') - julianday(t.updated_at)) * 1440 >= ?
    ORDER BY t.updated_at ASC
  `).all(minMinutes) as StuckTask[];
}

export async function runTaskHealthScan(): Promise<{ checked: number }> {
  const { warnMin, errorMin, criticalMin } = config.taskHealth;
  const stuckTasks = findStuckTasks(warnMin);

  for (const task of stuckTasks) {
    const minutesStuck  = task.minutes_stuck;
    const agentSuffix   = task.agent_name ? ` (assigned: ${task.agent_name})` : '';

    let severity: 'warn' | 'error' | 'critical';
    let tier:     string;
    let body:     string;

    if (minutesStuck >= criticalMin) {
      severity = 'critical';
      tier     = 'critical';
      body     = `"${task.title}" has been stuck for ${minutesStuck}m${agentSuffix} — Sentinel escalation failed.`;
    } else if (minutesStuck >= errorMin) {
      severity = 'error';
      tier     = 'error';
      body     = `"${task.title}" still stuck after ${minutesStuck}m${agentSuffix} — needs attention.`;
    } else {
      severity = 'warn';
      tier     = 'warn';
      body     = `"${task.title}" has been in-progress for ${minutesStuck}m${agentSuffix}.`;
    }

    try {
      await sendAlert({
        severity,
        source:   'task_health',
        title:    `Task stuck for ${minutesStuck}m: "${task.title}"`,
        body,
        dedupKey: `task_health_${task.id}_${tier}`,
      });
    } catch (err) {
      logger.warn('task-health: sendAlert failed', { taskId: task.id, error: (err as Error).message });
    }
  }

  return { checked: stuckTasks.length };
}

let healthTimer: NodeJS.Timeout | null = null;

export function startTaskHealthMonitor(): void {
  const intervalMs = config.taskHealth.intervalMin * 60_000;

  healthTimer = setInterval(() => {
    runTaskHealthScan().catch(err =>
      logger.warn('task-health: scan error', { error: (err as Error).message }),
    );
  }, intervalMs);

  logger.info('task-health: monitor started', {
    intervalMin: config.taskHealth.intervalMin,
    warnMin:     config.taskHealth.warnMin,
    errorMin:    config.taskHealth.errorMin,
    criticalMin: config.taskHealth.criticalMin,
  });
}

export function stopTaskHealthMonitor(): void {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}
