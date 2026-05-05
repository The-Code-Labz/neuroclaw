// Task Monitor — lightweight background agent that watches for stalled tasks.
//
// Every TASK_MONITOR_INTERVAL_SEC seconds (default 60), it:
//   1. Queries tasks with status = 'doing' where updated_at is older than
//      TASK_MONITOR_STALE_MINUTES minutes (default 3).
//   2. For each stale task that has an assigned agent, sends a short reminder
//      message to that agent via a fire-and-forget chatStream call.
//   3. Records run state in config_items (enabled, last_run, alerts_sent).
//
// Entry points:
//   - startTaskMonitor()   called from dashboard server boot
//   - stopTaskMonitor()    for clean shutdown / tests
//   - getTaskMonitorStatus()   used by GET /api/task-monitor/status
//
// Uses a cheap fast model (gpt-4o-mini or heartbeat.model fallback) so this
// never burns budget. The reminder call does NOT persist to the agent's normal
// conversation history — it creates an ephemeral session so the main chat
// context is unaffected.

import { getDb, getAgentById, createSession } from '../db';
import { chatStream } from '../agent/alfred';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { config } from '../config';

// ── Constants ──────────────────────────────────────────────────────────────

const INTERVAL_MS        = parseInt(process.env.TASK_MONITOR_INTERVAL_SEC  ?? '60',  10) * 1000;
const STALE_MINUTES      = parseInt(process.env.TASK_MONITOR_STALE_MINUTES ?? '3',   10);
// Cheap model for reminder pings (same logic as heartbeat)
const MONITOR_MODEL      = process.env.TASK_MONITOR_MODEL?.trim() || config.heartbeat.model || 'gpt-4o-mini';

const CONFIG_KEY_ENABLED      = 'task_monitor_enabled';
const CONFIG_KEY_LAST_RUN     = 'task_monitor_last_run';
const CONFIG_KEY_ALERTS_SENT  = 'task_monitor_alerts_sent';

// ── Config-items helpers ────────────────────────────────────────────────────

function cfgGet(key: string): string | undefined {
  return (getDb().prepare('SELECT value FROM config_items WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function cfgSet(key: string, value: string, description?: string): void {
  getDb().prepare(
    `INSERT INTO config_items (key, value, description) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value, description ?? key);
}

// ── State ──────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

// Runtime counters (also persisted in config_items)
let alertsSentLifetime = 0;

function loadLifetimeAlerts(): void {
  const raw = cfgGet(CONFIG_KEY_ALERTS_SENT);
  if (raw !== undefined) alertsSentLifetime = parseInt(raw, 10) || 0;
}

// ── Core scan ─────────────────────────────────────────────────────────────

interface StaleTask {
  id:        string;
  title:     string;
  agent_id:  string | null;
  updated_at: string;
}

function findStaleTasks(): StaleTask[] {
  return getDb().prepare(`
    SELECT id, title, agent_id, updated_at FROM tasks
    WHERE status = 'doing'
      AND archived = 0
      AND updated_at < datetime('now', '-${STALE_MINUTES} minutes')
  `).all() as StaleTask[];
}

async function remindAgent(task: StaleTask): Promise<void> {
  const agent = getAgentById(task.id.length > 0 && task.agent_id ? task.agent_id : '');
  if (!agent || agent.status !== 'active') {
    logger.debug('task-monitor: skipping stale task — no active agent assigned', { taskId: task.id });
    return;
  }

  const reminderMessage =
    `[Task Monitor] Hey ${agent.name} — you have a task that has been in "doing" status ` +
    `for more than ${STALE_MINUTES} minute(s) without an update:\n\n` +
    `**Task:** ${task.title}\n` +
    `**Last updated:** ${task.updated_at} UTC\n\n` +
    `Please update the task status or let the team know if you're blocked. ` +
    `If the task is complete, mark it as "review" or "done".`;

  // Use an ephemeral session so this ping doesn't pollute the agent's main history
  const sessionId = createSession(agent.id, `[task-monitor] ${task.title.slice(0, 50)}`);

  const systemPrompt = agent.system_prompt
    ?? `You are ${agent.name}. Acknowledge the task reminder concisely.`;

  try {
    let reply = '';
    await chatStream(
      reminderMessage,
      sessionId,
      (chunk) => { reply += chunk; },
      systemPrompt,
      agent.id,
      undefined,       // no meta events
      undefined,       // no attachments
      undefined,       // no extra system context
      undefined,       // no run id
    );

    logger.info('task-monitor: reminder sent', {
      taskId:    task.id,
      taskTitle: task.title,
      agentId:   agent.id,
      agentName: agent.name,
      replyLen:  reply.length,
    });

    try {
      logHive(
        'task_monitor_alert',
        `Reminder sent to ${agent.name} for stale task "${task.title}"`,
        agent.id,
        { taskId: task.id, staleSinceMinutes: STALE_MINUTES, replyLen: reply.length },
      );
    } catch { /* best-effort hive log */ }

  } catch (err) {
    logger.warn('task-monitor: failed to send reminder', {
      taskId:    task.id,
      agentId:   agent.id,
      error:     (err as Error).message,
    });
  }
}

export async function runTaskMonitorScan(): Promise<{ alertsSent: number; tasksChecked: number }> {
  if (running) {
    logger.debug('task-monitor: scan already in progress, skipping');
    return { alertsSent: 0, tasksChecked: 0 };
  }

  // Check enabled flag (default: enabled)
  const enabledFlag = cfgGet(CONFIG_KEY_ENABLED);
  if (enabledFlag === '0') {
    return { alertsSent: 0, tasksChecked: 0 };
  }

  running = true;
  const now = new Date().toISOString();
  cfgSet(CONFIG_KEY_LAST_RUN, now, 'task_monitor: timestamp of last scan');

  let alertsSent = 0;
  let tasksChecked = 0;

  try {
    const staleTasks = findStaleTasks();
    tasksChecked = staleTasks.length;

    if (staleTasks.length > 0) {
      logger.info('task-monitor: found stale tasks', { count: staleTasks.length, staleMinutes: STALE_MINUTES });
    }

    for (const task of staleTasks) {
      if (!task.agent_id) {
        logger.debug('task-monitor: stale task has no assigned agent', { taskId: task.id });
        continue;
      }
      await remindAgent(task);
      alertsSent++;
    }

    alertsSentLifetime += alertsSent;
    cfgSet(CONFIG_KEY_ALERTS_SENT, String(alertsSentLifetime), 'task_monitor: total alerts sent (lifetime)');

    if (alertsSent > 0) {
      logger.info('task-monitor: scan complete', { alertsSent, tasksChecked });
    }

  } catch (err) {
    logger.error('task-monitor: scan failed', { error: (err as Error).message });
  } finally {
    running = false;
  }

  return { alertsSent, tasksChecked };
}

// ── Status ─────────────────────────────────────────────────────────────────

export interface TaskMonitorStatus {
  enabled:      boolean;
  lastRunAt:    string | null;
  alertsSent:   number;
  nextRunAt:    string | null;
  intervalSec:  number;
  staleMinutes: number;
  model:        string;
}

export function getTaskMonitorStatus(): TaskMonitorStatus {
  const enabledFlag = cfgGet(CONFIG_KEY_ENABLED);
  const enabled     = enabledFlag !== '0';
  const lastRunAt   = cfgGet(CONFIG_KEY_LAST_RUN) ?? null;
  const alerts      = parseInt(cfgGet(CONFIG_KEY_ALERTS_SENT) ?? '0', 10) || 0;

  let nextRunAt: string | null = null;
  if (timer !== null && lastRunAt) {
    const nextMs = new Date(lastRunAt).getTime() + INTERVAL_MS;
    nextRunAt = new Date(nextMs).toISOString();
  }

  return {
    enabled,
    lastRunAt,
    alertsSent:   alerts,
    nextRunAt,
    intervalSec:  INTERVAL_MS / 1000,
    staleMinutes: STALE_MINUTES,
    model:        MONITOR_MODEL,
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────

export function startTaskMonitor(): void {
  // Seed config_items with defaults if not yet present (idempotent)
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO config_items (key, value, description)
     VALUES (?, ?, ?)`,
  ).run(CONFIG_KEY_ENABLED, '1', 'task_monitor: 1=enabled, 0=disabled');

  // Load lifetime alert count from DB into memory
  loadLifetimeAlerts();

  // Run once immediately (small delay so the server finishes booting first)
  setTimeout(() => {
    runTaskMonitorScan().catch(err =>
      logger.warn('task-monitor: initial scan failed', { error: (err as Error).message }),
    );
  }, 10_000);

  timer = setInterval(() => {
    runTaskMonitorScan().catch(err =>
      logger.warn('task-monitor: scheduled scan failed', { error: (err as Error).message }),
    );
  }, INTERVAL_MS);

  logger.info('task-monitor: scheduler started', {
    intervalSec:  INTERVAL_MS / 1000,
    staleMinutes: STALE_MINUTES,
    model:        MONITOR_MODEL,
  });
}

export function stopTaskMonitor(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
