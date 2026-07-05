import * as cron from 'node-cron';
import { getDb, createAnalystAlert, listAnalystAlerts, type AnalystAlert } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

const STEPHANIE_CRON = process.env.STEPHANIE_CRON ?? '0 9 * * 1,4'; // Mon + Thu 9AM

const CFG_LAST_RUN   = 'stephanie_last_run';
const CFG_NEXT_RUN   = 'stephanie_next_run';
const CFG_THRESHOLDS = 'stephanie_thresholds';

let _task: cron.ScheduledTask | null = null;

interface StephanieThresholds {
  overloadPct: number;
  idleDays: number;
  alfredDominancePct: number;
  cooldownHours: number;
}

function cfgGet(key: string): string | undefined {
  return (getDb()
    .prepare('SELECT value FROM config_items WHERE key = ?')
    .get(key) as { value: string } | undefined)?.value;
}

function cfgSet(key: string, value: string): void {
  getDb().prepare(
    `INSERT INTO config_items (key, value, description)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value, key);
}

function getThresholds(): StephanieThresholds {
  try {
    const raw = cfgGet(CFG_THRESHOLDS);
    if (raw) return { overloadPct: 40, idleDays: 3, alfredDominancePct: 50, cooldownHours: 6, ...JSON.parse(raw) as Partial<StephanieThresholds> };
  } catch { /* use defaults */ }
  return { overloadPct: 40, idleDays: 3, alfredDominancePct: 50, cooldownHours: 6 };
}

export function runStephanieAnalysis(): void {
  const db = getDb();
  const thresholds = getThresholds();

  try {
    // Message volume per agent, last 24h
    const msgRows = db.prepare(`
      SELECT agent_id, COUNT(*) AS cnt
      FROM messages
      WHERE created_at > datetime('now', '-1 day') AND agent_id IS NOT NULL
      GROUP BY agent_id
    `).all() as { agent_id: string; cnt: number }[];

    const totalMsgs = msgRows.reduce((s, r) => s + r.cnt, 0);
    const msgsByAgent: Record<string, number> = {};
    for (const r of msgRows) msgsByAgent[r.agent_id] = r.cnt;

    // Active task counts per agent
    const taskRows = db.prepare(`
      SELECT agent_id, COUNT(*) AS cnt
      FROM tasks
      WHERE status IN ('todo', 'doing') AND agent_id IS NOT NULL
      GROUP BY agent_id
    `).all() as { agent_id: string; cnt: number }[];
    const tasksByAgent: Record<string, number> = {};
    for (const r of taskRows) tasksByAgent[r.agent_id] = r.cnt;

    // Active non-temp agents
    const agents = db.prepare(`
      SELECT id, name, role, capabilities, created_at
      FROM agents
      WHERE status = 'active' AND temporary = 0
    `).all() as { id: string; name: string; role: string; capabilities: string; created_at: string }[];

    // Recent alerts for cooldown enforcement
    const allAlerts = listAnalystAlerts({ limit: 500 });
    const cooldownCutoff = new Date(Date.now() - thresholds.cooldownHours * 60 * 60 * 1000).toISOString();
    const hasRecentAlert = (type: AnalystAlert['type'], agentId: string | null): boolean =>
      allAlerts.some(a => a.type === type && a.agent_id === (agentId ?? null) && a.created_at > cooldownCutoff);

    // Overload check — only evaluate agents with meaningful activity (min 5 msgs OR 3 active tasks in 24h)
    if (totalMsgs > 5) {
      for (const r of msgRows) {
        if (r.cnt < 5) continue; // skip agents with trivial message counts
        const pct = Math.round((r.cnt / totalMsgs) * 100);
        if (pct >= thresholds.overloadPct && !hasRecentAlert('overload', r.agent_id)) {
          const name = agents.find(a => a.id === r.agent_id)?.name ?? r.agent_id;
          createAnalystAlert({
            type: 'overload',
            agent_id: r.agent_id,
            severity: pct >= 60 ? 'critical' : 'warn',
            message: `${name} handled ${pct}% of messages in the last 24h. Consider delegating some of their categories to a specialist.`,
            metadata: JSON.stringify({ pct, cnt: r.cnt, total: totalMsgs }),
          });
        }
      }
    }

    // Idle check — use configurable idleDays, skip orchestrators and brand-new agents
    const idleDaysRaw = thresholds.idleDays;
    const idleDays = Math.max(1, Number.isFinite(Number(idleDaysRaw)) ? Math.floor(Number(idleDaysRaw)) : 7);
    const msgIdleRows = db.prepare(`
      SELECT agent_id, COUNT(*) AS cnt
      FROM messages
      WHERE created_at > datetime('now', ? || ' days') AND agent_id IS NOT NULL
      GROUP BY agent_id
    `).all(`-${idleDays}`) as { agent_id: string; cnt: number }[];
    const msgsIdleByAgent: Record<string, number> = {};
    for (const r of msgIdleRows) msgsIdleByAgent[r.agent_id] = r.cnt;

    for (const agent of agents) {
      if (agent.role === 'orchestrator') continue;
      // Skip agents created less than 24 hours ago
      const ageHours = (Date.now() - new Date(agent.created_at).getTime()) / (1000 * 60 * 60);
      if (ageHours < 24) continue;
      const msgsIdle = msgsIdleByAgent[agent.id] ?? 0;
      const active = tasksByAgent[agent.id] ?? 0;
      if (msgsIdle === 0 && active === 0 && !hasRecentAlert('idle', agent.id)) {
        createAnalystAlert({
          type: 'idle',
          agent_id: agent.id,
          severity: 'info',
          message: `${agent.name} has had no messages or active tasks in the last ${idleDays} days. Consider reviewing their scope or deactivating if unused.`,
          metadata: JSON.stringify({ idleDays, msgsIdle, activeTasks: active }),
        });
      }
    }

    // Alfred dominance check → recommend_spawn
    const alfred = agents.find(a => a.role === 'orchestrator');
    if (alfred && totalMsgs > 10) {
      const alfredPct = Math.round(((msgsByAgent[alfred.id] ?? 0) / totalMsgs) * 100);
      if (alfredPct >= thresholds.alfredDominancePct && !hasRecentAlert('recommend_spawn', alfred.id)) {
        createAnalystAlert({
          type: 'recommend_spawn',
          agent_id: alfred.id,
          severity: 'warn',
          message: `Alfred is handling ${alfredPct}% of all messages. This suggests missing specialists. Review the categories Alfred is receiving most and consider creating dedicated agents for them.`,
          metadata: JSON.stringify({ alfredPct, total: totalMsgs }),
        });
      }
    }

    const now = new Date().toISOString();
    cfgSet(CFG_LAST_RUN, now);
    // Next run is governed by cron expression; not trivially computable here.
    cfgSet(CFG_NEXT_RUN, '');
    logHive('analyst_run_ok', 'stephanie: Stephanie analysis cycle complete', undefined, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Stephanie analysis failed', { err: msg });
    logHive('analyst_error', `stephanie: Stephanie analysis failed: ${msg}`, undefined, {});
  }
}

export function getStephanieStatus(): {
  lastRun: string | null;
  nextRun: string | null;
  alertCounts: Record<string, number>;
  enabled: boolean;
  cron: string;
} {
  const unread = listAnalystAlerts({ unreadOnly: true, limit: 200 });
  const counts: Record<string, number> = { info: 0, warn: 0, critical: 0 };
  for (const a of unread) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  return {
    lastRun:     cfgGet(CFG_LAST_RUN) ?? null,
    nextRun:     cfgGet(CFG_NEXT_RUN) || null,
    alertCounts: counts,
    enabled:     true,
    cron:        STEPHANIE_CRON,
  };
}

export function startStephanieScheduler(): void {
  if (_task) { _task.stop(); _task = null; }

  if (!cron.validate(STEPHANIE_CRON)) {
    logger.error(`Stephanie scheduler: invalid cron "${STEPHANIE_CRON}" — scheduler NOT started`);
    return;
  }

  _task = cron.schedule(STEPHANIE_CRON, () => runStephanieAnalysis());
  logger.info(`Stephanie scheduler started (cron: ${STEPHANIE_CRON})`);
}

export function stopStephanieScheduler(): void {
  if (_task) { _task.stop(); _task = null; }
}
