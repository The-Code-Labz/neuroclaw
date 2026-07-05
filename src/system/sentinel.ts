// Sentinel — background task manager agent.
//
// Escalation ladder per stale task:
//   Level 0 → 1: check_in_with_agent  (sends ephemeral LLM message, records reply)
//   Level 1 → 2: request_reassignment (asks Alfred to pick best agent via LLM)
//   Level 2 → 3: mark_blocked         (logs sentinel_blocked, notifies Alfred)
//
// All conversations are ephemeral (separate sessions, not visible in main chat).
// State is persisted in sentinel_task_state so escalation survives restarts.

import { randomUUID } from 'crypto';
import {
  getDb, getAllAgents, getAgentById,
  getAlfredAgent, getSentinelAgent, enqueueJob,
  type AgentRecord,
} from '../db';
import { logHive } from './hive-mind';
import { updateTask } from './task-manager';
import { logger } from '../utils/logger';
import { translateClaudeError } from '../utils/claudeErrorLabel';
import { sendAlert } from './alert-dispatcher';
import { isTaskLive } from './task-liveness';

// ── Config ────────────────────────────────────────────────────────────────────

const INTERVAL_MS    = parseInt(process.env.SENTINEL_INTERVAL_SEC  ?? '60',  10) * 1000;
const STALE_MINUTES  = parseInt(process.env.SENTINEL_STALE_MINUTES ?? '15',  10);
const SENTINEL_MODEL = process.env.SENTINEL_MODEL?.trim()
  || process.env.HEARTBEAT_MODEL?.trim()
  || 'gpt-4o-mini';
const CFG_ENABLED   = 'sentinel_enabled';
const CFG_LAST_RUN  = 'sentinel_last_run';
const CFG_ALERTS    = 'sentinel_alerts_sent';
const CFG_REASSIGNS = 'sentinel_reassigns';
const CFG_BLOCKED   = 'sentinel_blocked_count';

// Grace period: number of check-in intervals before escalating to reassignment.
const ESCALATION_GRACE_INTERVALS = parseInt(process.env.SENTINEL_GRACE_INTERVALS ?? '2', 10);
// Max total escalation cycles (check-in → reassign → blocked) before abandoning.
const MAX_ESCALATIONS = parseInt(process.env.SENTINEL_MAX_ESCALATIONS ?? '3', 10);

// Liveness-first behavior (default on). Kill-switch: set SENTINEL_USE_LIVENESS_READ=false
// to fall back to the legacy LLM check-in path during canary.
const USE_LIVENESS = process.env.SENTINEL_USE_LIVENESS_READ !== 'false';
// Min gap between escalations/alerts for one task — deterministic liveness reads
// would otherwise re-fire identically every scan.
const ESCALATION_COOLDOWN_MS = parseInt(
  process.env.SENTINEL_ESCALATION_COOLDOWN_MS ?? String(15 * 60_000), 10,
);

// ── DB helpers ────────────────────────────────────────────────────────────────

function cfgGet(key: string): string | undefined {
  return (getDb().prepare('SELECT value FROM config_items WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function cfgSet(key: string, value: string, description?: string): void {
  getDb().prepare(
    `INSERT INTO config_items (key, value, description)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value, description ?? key);
}

// ── Escalation cooldown (anti-spam) ─────────────────────────────────────────────
const escalatedTasks = new Map<string, number>(); // taskId → last escalation ts (ms)

function inCooldown(taskId: string): boolean {
  const last = escalatedTasks.get(taskId) ?? 0;
  return Date.now() - last < ESCALATION_COOLDOWN_MS;
}
function markEscalated(taskId: string): void {
  escalatedTasks.set(taskId, Date.now());
}
function clearEscalation(taskId: string): void {
  escalatedTasks.delete(taskId);
}

// ── Lightweight LLM (SENTINEL_MODEL only — never chatStream) ─────────────────────
// Used for the optional courtesy nudge and the Alfred reassignment pick. Routes
// through the OpenAI-compat client so Sentinel never queues behind live Claude
// turns and is never aborted by config.claude.timeoutMs.
async function sentinelLlm(systemPrompt: string, userMsg: string): Promise<string> {
  try {
    const { getClient } = await import('../agent/openai-client');
    const client = getClient();
    const resp = await client.chat.completions.create({
      model:    SENTINEL_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMsg },
      ],
      stream: false,
    });
    return resp.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    logger.warn('sentinel: SENTINEL_MODEL call failed', { error: translateClaudeError(err) });
    return '';
  }
}

// ── Sentinel task state helpers ───────────────────────────────────────────────

interface SentinelTaskState {
  id:                     string;
  task_id:                string;
  escalation_level:       number;
  reminders_sent:         number;
  last_check_in_at:       string | null;
  original_agent_id:      string | null;
  reassigned_to_agent_id: string | null;
  agent_response:         string | null;
  blocked_reason:         string | null;
}

function getState(taskId: string): SentinelTaskState | undefined {
  return getDb().prepare('SELECT * FROM sentinel_task_state WHERE task_id = ?').get(taskId) as SentinelTaskState | undefined;
}

function createState(taskId: string, agentId: string | null): SentinelTaskState {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO sentinel_task_state
      (id, task_id, escalation_level, reminders_sent, original_agent_id, created_at, updated_at)
    VALUES (?, ?, 0, 0, ?, ?, ?)
  `).run(id, taskId, agentId ?? null, now, now);
  return getState(taskId)!;
}

function updateState(taskId: string, patch: Partial<Omit<SentinelTaskState, 'id' | 'task_id' | 'created_at'>>): void {
  const ALLOWED_COLS = new Set([
    'escalation_level', 'reminders_sent', 'last_check_in_at',
    'original_agent_id', 'reassigned_to_agent_id', 'agent_response', 'blocked_reason',
  ]);
  for (const k of Object.keys(patch)) {
    if (!ALLOWED_COLS.has(k)) throw new Error(`sentinel: disallowed column in updateState: ${k}`);
  }
  const fields = Object.entries(patch)
    .map(([k]) => `${k} = ?`)
    .join(', ');
  const values = Object.values(patch);
  getDb().prepare(
    `UPDATE sentinel_task_state SET ${fields}, updated_at = datetime('now') WHERE task_id = ?`,
  ).run(...values, taskId);
}

function taskWasActedOn(taskId: string, beforeUpdatedAt: string): boolean {
  const row = getDb().prepare(
    'SELECT status, updated_at, agent_id, last_heartbeat_at FROM tasks WHERE id = ?',
  ).get(taskId) as { status: string; updated_at: string; agent_id: string | null; last_heartbeat_at: number | null } | undefined;
  if (!row) return false;
  if (row.status !== 'doing') return true;
  if (row.updated_at !== beforeUpdatedAt) return true;
  // A task that has become live again (agent resumed work) counts as acted-on.
  if (isTaskLive({ id: taskId, agent_id: row.agent_id, last_heartbeat_at: row.last_heartbeat_at })) return true;
  return false;
}

// ── Stale task finder ─────────────────────────────────────────────────────────

interface StaleTask {
  id:                string;
  title:             string;
  description:       string | null;
  agent_id:          string | null;
  updated_at:        string;
  last_heartbeat_at: number | null;
}

function findStaleTasks(): StaleTask[] {
  // Allowlist task_source — this IS the subtask/background exclusion: only
  // 'dashboard' tasks are ever monitored; 'subtask', 'background', and any
  // future source are excluded by construction.
  const rows = getDb().prepare(`
    SELECT id, title, description, agent_id, updated_at, last_heartbeat_at FROM tasks
    WHERE status = 'doing'
      AND datetime(updated_at) < datetime('now', ?)
      AND task_source = 'dashboard'
  `).all(`-${STALE_MINUTES} minutes`) as StaleTask[];

  if (!USE_LIVENESS) return rows; // kill-switch: legacy behavior
  // Drop any task that is actually being worked on right now.
  return rows.filter(t => !isTaskLive({ id: t.id, agent_id: t.agent_id, last_heartbeat_at: t.last_heartbeat_at }));
}

// ── Escalation steps ──────────────────────────────────────────────────────────

async function checkInWithAgent(task: StaleTask, agent: AgentRecord, state: SentinelTaskState): Promise<void> {
  const sentinelAgent = getSentinelAgent();

  const minutesStale = Math.round((Date.now() - new Date(task.updated_at).getTime()) / 60_000);
  const priorContext = state.agent_response
    ? `\n\nYour previous response: "${state.agent_response.slice(0, 300)}"\n`
    : '';

  const msg =
    `[Sentinel Check-In]\n\n` +
    `Task: ${task.title}\n` +
    (task.description ? `Description: ${task.description}\n` : '') +
    `Status: doing for ${minutesStale} minute(s) without progress` +
    priorContext +
    `\nTask "${task.title}" (ID: ${task.id}) has been flagged as stalled — no update detected for ${minutesStale} minutes.\n\n` +
    `If you are actively working on this task, update its status NOW:\n` +
    `  - manage_task(action="update", task_id="${task.id}", status="doing")\n\n` +
    `If the task is complete, set status to "review". If you cannot proceed, set status to "blocked" (or "cancelled") and explain in the description.\n\n` +
    `Choose one status:\n` +
    `\`doing\`     — still in progress.\n` +
    `\`review\`    — work is complete and ready for review.\n` +
    `\`blocked\`   — cannot proceed (explain blocker in description).\n` +
    `\`cancelled\` — should not / cannot be done; release it.\n` +
    `\`done\`      — fully completed.\n\n` +
    `After the status update, briefly summarize progress.`;

  const preCheckUpdatedAt = task.updated_at;
  // Optional courtesy nudge. Informational only — escalation is decided by
  // liveness, not by whether the agent replies. Disable with SENTINEL_SEND_NUDGE=false.
  let reply = '';
  if (process.env.SENTINEL_SEND_NUDGE !== 'false') {
    reply = await sentinelLlm(
      agent.system_prompt ?? `You are ${agent.name}. Respond concisely.`,
      msg,
    );
  }

  const freshState = getState(task.id);
  if (!freshState || freshState.escalation_level !== state.escalation_level) {
    logger.warn('sentinel: state changed during LLM call, skipping update', { taskId: task.id });
    return;
  }

  // Verify the agent actually acted
  const acted = taskWasActedOn(task.id, preCheckUpdatedAt);
  if (acted) {
    updateState(task.id, {
      escalation_level: 0,
      reminders_sent:   0,
      last_check_in_at: new Date().toISOString(),
      agent_response:   reply.slice(0, 2000),
    });
    clearEscalation(task.id);
    logger.info('sentinel: agent acted on check-in — resetting escalation', { taskId: task.id, agentName: agent.name });
    return;
  }

  // Grace period: hold at level 0 until ESCALATION_GRACE_INTERVALS reminders sent.
  const newReminderCount = state.reminders_sent + 1;
  const nextLevel = newReminderCount >= ESCALATION_GRACE_INTERVALS ? 1 : 0;

  updateState(task.id, {
    escalation_level:  nextLevel,
    reminders_sent:    newReminderCount,
    last_check_in_at:  new Date().toISOString(),
    agent_response:    reply.slice(0, 2000),
  });

  lifetimeAlerts++;
  cfgSet(CFG_ALERTS, String(lifetimeAlerts));

  logHive('sentinel_check_in', `sentinel: Sentinel checked in with ${agent.name} about stalled task "${task.title}"`, sentinelAgent?.id, { taskId: task.id, agentId: agent.id, minutesStale, replyLen: reply.length });

  logger.info('sentinel: check-in complete', { taskId: task.id, agentName: agent.name, replyLen: reply.length });
  sendAlert({
    severity: 'warn',
    source:   'sentinel',
    title:    `Sentinel checked in with ${agent.name} about stalled task "${task.title}"`,
    body:     `Task has been in-progress for ${minutesStale}m. Agent response: "${reply.slice(0, 200)}"`,
    dedupKey: `sentinel_checkin_${task.id}`,
  }).catch(err => logger.warn('sentinel: sendAlert failed', { error: (err as Error).message }));
}

async function requestReassignment(task: StaleTask, state: SentinelTaskState): Promise<void> {
  const sentinelAgent = getSentinelAgent();
  const alfred = getAlfredAgent();

  const candidates = getAllAgents().filter(a =>
    a.status === 'active' &&
    a.role !== 'orchestrator' &&
    a.id !== state.original_agent_id,
  );

  if (candidates.length === 0) {
    logger.warn('sentinel: no candidate agents for reassignment', { taskId: task.id });
    return;
  }

  let newAgentId: string = candidates[0].id;

  if (alfred) {
    const candidateList = candidates
      .map(a => `- ${a.name} (${a.role}): ${a.description ?? 'no description'}`)
      .join('\n');

    const msg =
      `[Sentinel → Alfred] Task reassignment needed.\n\n` +
      `Task: ${task.title}\n` +
      (task.description ? `Description: ${task.description}\n` : '') +
      `Prior agent response: "${(state.agent_response ?? 'none').slice(0, 400)}"\n\n` +
      `The assigned agent has been stalled and unresponsive. ` +
      `Pick the best specialist from this list to take over:\n\n` +
      candidateList +
      `\n\nRouting guidance (use as a starting signal, not a hard rule):\n` +
      `- Infrastructure, Docker, containers, deployment → prefer infra-specialist agents\n` +
      `- Code, debugging, implementation, refactoring → prefer coding-specialist agents\n` +
      `- API design, integrations, webhooks → prefer API/integration agents\n` +
      `- Research, analysis, intel gathering → prefer research-specialist agents\n` +
      `- UI, frontend, design → prefer frontend agents\n\n` +
      `Respond with ONLY the agent's exact name, nothing else.`;

    let reply = '';
    reply = await sentinelLlm(alfred.system_prompt ?? '', msg);
    // Sort longest name first so e.g. "BackendCoder" is checked before "Coder".
    const sorted = [...candidates].sort((a, b) => b.name.length - a.name.length);
    const picked = sorted.find(a => reply.trim().toLowerCase().includes(a.name.toLowerCase()));
    if (picked) newAgentId = picked.id;
  }

  const newAgent = getAgentById(newAgentId);
  if (!newAgent) return;

  // Cancel the original in-flight job for this task so the stalled agent's run
  // can't keep executing (and can't overwrite the new agent's work — see the
  // stale-write guard in job-worker._runAgentTask).
  try {
    getDb().prepare(`
      UPDATE job_queue
      SET status = 'failed', error = 'cancelled: reassigned by Sentinel'
      WHERE status IN ('pending','claimed')
        AND json_extract(payload,'$.taskId') = ?
    `).run(task.id);
  } catch (err) {
    logger.warn('sentinel: failed to cancel original job before reassign', { taskId: task.id, error: (err as Error).message });
  }

  // Reassign + reset to 'todo', then re-enqueue through the normal job pipeline.
  // _runAgentTask will set it back to 'doing' with a fresh heartbeat (→ live).
  getDb().prepare(
    `UPDATE tasks SET agent_id = ?, status = 'todo', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  ).run(newAgentId, task.id);

  enqueueJob('agent_task', {
    taskId:          task.id,
    agentId:         newAgentId,
    agentName:       newAgent.name,
    taskTitle:       task.title,
    taskDescription: task.description ?? '',
  });

  updateState(task.id, {
    escalation_level:       2,
    reassigned_to_agent_id: newAgentId,
    agent_response:         `reassigned to ${newAgent.name}; original run cancelled`,
    last_check_in_at:       new Date().toISOString(),
  });

  lifetimeReassigns++;
  cfgSet(CFG_REASSIGNS, String(lifetimeReassigns));

  logHive('sentinel_reassign', `sentinel: Sentinel reassigned "${task.title}" to ${newAgent.name} (original job cancelled, re-enqueued)`, sentinelAgent?.id, { taskId: task.id, newAgentId, newAgentName: newAgent.name });

  logger.info('sentinel: task reassigned + re-enqueued', { taskId: task.id, newAgentName: newAgent.name });
  sendAlert({
    severity: 'warn',
    source:   'sentinel',
    title:    `Sentinel reassigned "${task.title}" to ${newAgent.name}`,
    body:     `Previous agent was stalled and unresponsive. Original run cancelled; task re-queued for ${newAgent.name}.`,
    dedupKey: `sentinel_reassign_${task.id}`,
  }).catch(err => logger.warn('sentinel: sendAlert failed', { error: (err as Error).message }));
}

async function markBlocked(task: StaleTask, state: SentinelTaskState): Promise<void> {
  const sentinelAgent = getSentinelAgent();
  const alfred = getAlfredAgent();
  const reason = `Task stalled through check-in and reassignment. Agent response: "${(state.agent_response ?? 'none').slice(0, 300)}"`;

  const freshState = getState(task.id);
  if (!freshState || freshState.escalation_level !== state.escalation_level) {
    logger.warn('sentinel: state changed during LLM call, skipping update', { taskId: task.id });
    return;
  }

  // Persist the blocked status on the task itself — otherwise the row stays
  // 'doing' (looking like active work) until the next scan force-fails it, and
  // the "blocked" state is never actually visible. Setting status='blocked'
  // removes it from findStaleTasks (which only selects 'doing'), so it becomes
  // a stable "needs human attention" row carrying the block reason.
  updateTask(task.id, { status: 'blocked', last_error: reason });

  // Escalation is finished for this task — clear the per-task sentinel state so
  // it is no longer tracked/cooled-down. (The task is now parked at 'blocked'.)
  getDb().prepare('DELETE FROM sentinel_task_state WHERE task_id = ?').run(task.id);
  clearEscalation(task.id);

  lifetimeBlocked++;
  cfgSet(CFG_BLOCKED, String(lifetimeBlocked));

  logHive('sentinel_blocked', `sentinel: Task "${task.title}" is fully blocked — Sentinel escalating to Alfred for user notification`, sentinelAgent?.id, { taskId: task.id, reason });

  await sendAlert({
    severity: 'critical',
    source:   'sentinel',
    title:    `Task "${task.title}" is fully blocked`,
    body:     `Stalled through check-in and reassignment.\nLast agent response: "${(state.agent_response ?? 'none').slice(0, 300)}"`,
    dedupKey: `sentinel_blocked_${task.id}`,
  });

  logger.warn('sentinel: task marked blocked', { taskId: task.id, taskTitle: task.title });
}

// ── Core scan ─────────────────────────────────────────────────────────────────

async function processStaleTask(task: StaleTask): Promise<boolean> {
  let state = getState(task.id);
  if (!state) {
    state = createState(task.id, task.agent_id);
  }

  // Anti-spam: at most one escalation action per task per cooldown window.
  if (USE_LIVENESS && inCooldown(task.id)) return false;

  // Escalation cap — task is truly stuck, mark failed and stop monitoring.
  if (state.escalation_level >= MAX_ESCALATIONS) {
    updateTask(task.id, {
      status:     'failed',
      last_error: `Sentinel: max escalations (${MAX_ESCALATIONS}) reached with no agent response. Task abandoned.`,
    });
    getDb().prepare('DELETE FROM sentinel_task_state WHERE task_id = ?').run(task.id);
    clearEscalation(task.id);
    logger.warn('sentinel: task abandoned after max escalations', { taskId: task.id, title: task.title });
    sendAlert({
      severity: 'critical',
      source:   'sentinel',
      title:    `Sentinel abandoned task "${task.title}" after ${MAX_ESCALATIONS} escalations`,
      body:     `No agent response after ${MAX_ESCALATIONS} full escalation cycles. Task marked failed.`,
      dedupKey: `sentinel_abandoned_${task.id}`,
    }).catch(err => logger.warn('sentinel: sendAlert failed', { error: (err as Error).message }));
    return false;
  }

  if (state.escalation_level === 0) {
    const agentId = task.agent_id ?? state.original_agent_id;
    if (!agentId) {
      try {
        updateTask(task.id, { status: 'todo', agent_id: null });
        getDb().prepare('DELETE FROM sentinel_task_state WHERE task_id = ?').run(task.id);
        logHive('sentinel_reset_agentless', `sentinel: Reset agentless stuck task "${task.title}" to todo`, undefined, { taskId: task.id });
        logger.info('sentinel: reset agentless stuck task to todo', { taskId: task.id });
      } catch (err) {
        logger.warn('sentinel: failed to reset agentless task', { taskId: task.id, error: (err as Error).message });
      }
      return false;
    }
    const agent = getAgentById(agentId);
    if (!agent || agent.status !== 'active') {
      try {
        updateTask(task.id, { status: 'todo', agent_id: null });
        getDb().prepare('DELETE FROM sentinel_task_state WHERE task_id = ?').run(task.id);
        logHive('orphaned_doing_task_requeued', `sentinel: Sentinel reset task "${task.title}" to todo — agent ${agentId} is inactive/deleted`, undefined, { taskId: task.id, previousAgentId: agentId, source: 'sentinel' });
        logger.info('sentinel: orphaned task reset to todo', { taskId: task.id, agentId });
      } catch (err) {
        logger.warn('sentinel: failed to reset orphaned task', { taskId: task.id, error: (err as Error).message });
      }
      return false;
    }
    await checkInWithAgent(task, agent, state);
    if (USE_LIVENESS) markEscalated(task.id);
    return true;
  }

  if (state.escalation_level === 1) {
    await requestReassignment(task, state);
    if (USE_LIVENESS) markEscalated(task.id);
    return true;
  }

  if (state.escalation_level === 2) {
    await markBlocked(task, state);
    if (USE_LIVENESS) markEscalated(task.id);
    return true;
  }

  return false;
}

let scanRunning = false;
let lifetimeAlerts    = 0;
let lifetimeReassigns = 0;
let lifetimeBlocked   = 0;

function loadLifetimeCounters(): void {
  lifetimeAlerts    = parseInt(cfgGet(CFG_ALERTS)    ?? '0', 10) || 0;
  lifetimeReassigns = parseInt(cfgGet(CFG_REASSIGNS) ?? '0', 10) || 0;
  lifetimeBlocked   = parseInt(cfgGet(CFG_BLOCKED)   ?? '0', 10) || 0;
}

export async function runSentinelScan(): Promise<{ checked: number; actedOn: number; skipped?: boolean }> {
  if (scanRunning) return { checked: 0, actedOn: 0, skipped: true };

  // Env var takes precedence over DB config for cold-start disable
  if (process.env.SENTINEL_ENABLED === '0') {
    logger.debug('sentinel: disabled via SENTINEL_ENABLED=0');
    return { checked: 0, actedOn: 0 };
  }

  const enabled = cfgGet(CFG_ENABLED);
  if (enabled === '0') return { checked: 0, actedOn: 0 };

  scanRunning = true;
  cfgSet(CFG_LAST_RUN, new Date().toISOString(), 'sentinel: timestamp of last scan');

  let checked = 0;
  let actedOn = 0;

  // Prune cooldown entries for tasks that are no longer 'doing' (completed,
  // failed, reassigned-to-todo). Bounds the in-memory escalatedTasks Map.
  if (escalatedTasks.size > 0) {
    for (const taskId of [...escalatedTasks.keys()]) {
      const row = getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string } | undefined;
      if (!row || row.status !== 'doing') escalatedTasks.delete(taskId);
    }
  }

  try {
    const staleTasks = findStaleTasks();
    checked = staleTasks.length;

    for (const task of staleTasks) {
      try {
        if (await processStaleTask(task)) actedOn++;
      } catch (err) {
        logger.warn('sentinel: error processing stale task', { taskId: task.id, error: (err as Error).message });
      }
    }
  } catch (err) {
    logger.error('sentinel: scan failed', { error: (err as Error).message });
  } finally {
    scanRunning = false;
  }

  return { checked, actedOn };
}

// ── Status ─────────────────────────────────────────────────────────────────────

export interface SentinelStatus {
  enabled:           boolean;
  lastRun:           string | null;
  checkInsTotal:     number;
  reassignmentsTotal: number;
  blockedTotal:      number;
  nextRun:           string | null;
  intervalSec:       number;
  staleMinutes:      number;
  model:             string;
  activeEscalations: number;
}

export function getSentinelStatus(): SentinelStatus {
  const enabled   = process.env.SENTINEL_ENABLED !== '0' && cfgGet(CFG_ENABLED) !== '0';
  const lastRun   = cfgGet(CFG_LAST_RUN) ?? null;
  const alerts    = parseInt(cfgGet(CFG_ALERTS)    ?? '0', 10) || 0;
  const reassigns = parseInt(cfgGet(CFG_REASSIGNS) ?? '0', 10) || 0;
  const blocked   = parseInt(cfgGet(CFG_BLOCKED)   ?? '0', 10) || 0;

  let nextRun: string | null = null;
  if (timer !== null && lastRun) {
    nextRun = new Date(new Date(lastRun).getTime() + INTERVAL_MS).toISOString();
  }

  const activeEscalations = (
    getDb().prepare('SELECT COUNT(*) as cnt FROM sentinel_task_state WHERE escalation_level < 3').get() as { cnt: number }
  ).cnt;

  return {
    enabled,
    lastRun,
    checkInsTotal:      alerts,
    reassignmentsTotal: reassigns,
    blockedTotal:       blocked,
    nextRun,
    intervalSec:        INTERVAL_MS / 1000,
    staleMinutes:       STALE_MINUTES,
    model:              SENTINEL_MODEL,
    activeEscalations,
  };
}

export function getActiveSentinelEscalations(): Array<{
  taskId: string; taskTitle: string; escalationLevel: number;
  assignedAgentName: string | null; lastCheckInAt: string | null; agentResponse: string | null;
}> {
  const rows = getDb().prepare(`
    SELECT s.*, t.title AS task_title, a.name AS agent_name
    FROM sentinel_task_state s
    LEFT JOIN tasks t ON s.task_id = t.id
    LEFT JOIN agents a ON COALESCE(s.reassigned_to_agent_id, s.original_agent_id) = a.id
    WHERE s.escalation_level < 3
    ORDER BY s.updated_at DESC
    LIMIT 50
  `).all() as Array<{
    task_id: string; task_title: string; escalation_level: number;
    agent_name: string | null; last_check_in_at: string | null; agent_response: string | null;
  }>;

  return rows.map(r => ({
    taskId:            r.task_id,
    taskTitle:         r.task_title ?? r.task_id,
    escalationLevel:   r.escalation_level,
    assignedAgentName: r.agent_name,
    lastCheckInAt:     r.last_check_in_at,
    agentResponse:     r.agent_response,
  }));
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

export function startSentinel(): void {
  const db = getDb();

  db.prepare(`INSERT OR IGNORE INTO config_items (key, value, description) VALUES (?, ?, ?)`)
    .run(CFG_ENABLED, '1', 'sentinel: 1=enabled, 0=disabled');

  loadLifetimeCounters();

  setTimeout(() => {
    runSentinelScan().catch(err =>
      logger.warn('sentinel: initial scan failed', { error: (err as Error).message }),
    );
  }, 15_000);

  timer = setInterval(() => {
    runSentinelScan().catch(err =>
      logger.warn('sentinel: scheduled scan failed', { error: (err as Error).message }),
    );
  }, INTERVAL_MS);

  logger.info('sentinel: scheduler started', {
    intervalSec:   INTERVAL_MS / 1000,
    staleMinutes:  STALE_MINUTES,
    model:         SENTINEL_MODEL,
  });
}

export function stopSentinel(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
