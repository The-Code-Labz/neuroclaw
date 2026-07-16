// Autonomous Mission Control loop.
//
// A single self-driving loop that keeps pulling the next `todo` task off the
// Mission Control board, runs it through the EXISTING agent_task pipeline
// (job-worker.ts → _runAgentTask: doing → run → review → holdout reviewer →
// done/failed/retry), waits for it to reach a terminal state, then moves to the
// next task — with no per-task user input. It is bounded (max tasks, wall-clock
// deadline, consecutive-failure streak) so it can never run away, and when it
// stops it writes a consolidated report back into a session the user can open.
//
// Design notes:
//  - Sequential by default: enqueue one task, await its terminal state, then the
//    next. This gives focused, observable progress and a clean final report,
//    rather than dumping the whole board into the job queue at once.
//  - We reuse the task lifecycle (not run events) as the source of truth: the
//    holdout reviewer advances `review` → done/failed, so polling the task to a
//    terminal status is decoupled from chat-run internals.
//  - Safety: risky / outward-facing tool calls inside a task turn are already
//    gated by the existing approval/broker layer — the loop does not bypass it.
//  - Only one autonomous loop runs at a time (singleton state).

import {
  enqueueJob, createSession, saveMessage, getAgentById, getAgentByName,
  type AgentRecord,
} from '../db';
import { getTasks, getTaskById, updateTask, type AppTask } from './task-manager';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { config } from '../config';
import { healMemoryStats, candidateFixes } from './self-heal/heal-loop';

export interface AutonomousOptions {
  /** Cap on tasks worked before the loop stops and reports back. */
  maxTasks:                number;
  /** Wall-clock budget in minutes; the loop stops once exceeded. */
  maxMinutes:              number;
  /** Stop after this many consecutive task failures (likely systemic blocker). */
  maxConsecutiveFailures:  number;
  /** Per-task ceiling (ms) before the loop gives up waiting and moves on. */
  perTaskTimeoutMs:        number;
  /** Restrict to a single project board; omit to drain across all projects. */
  projectId?:              string;
  /** Skip todo tasks created more than N days ago (stale guard). 0 = no limit. */
  maxTaskAgeDays:          number;
  /** Fallback driver agent (by name) for tasks with no resolvable assignee. */
  defaultAgentName:        string;
  /** Who/what kicked off the run, for the audit trail. */
  triggeredBy:             string;
}

type TaskOutcome = 'done' | 'failed' | 'blocked' | 'timeout' | 'rejected';
type StopReason  = 'boardEmpty' | 'maxTasks' | 'deadline' | 'failureStreak' | 'manual' | 'error';

interface WorkedTask {
  id:      string;
  title:   string;
  agent:   string;
  outcome: TaskOutcome;
}

interface LoopState {
  running:             boolean;
  runId:               string | null;
  sessionId:           string | null;
  startedAt:           number | null;
  stoppedAt:           number | null;
  stopReason:          StopReason | null;
  currentTaskId:       string | null;
  consecutiveFailures: number;
  worked:              WorkedTask[];
  skipped:             number;
  opts:                AutonomousOptions | null;
}

const POLL_MS = 3000;

const state: LoopState = {
  running: false, runId: null, sessionId: null, startedAt: null, stoppedAt: null,
  stopReason: null, currentTaskId: null, consecutiveFailures: 0, worked: [], skipped: 0,
  opts: null,
};

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Resolve the agent that should work a task: explicit agent → named assignee
 *  → configured default driver. Returns null if none is active. */
function resolveAgentForTask(task: AppTask, defaultAgentName: string): { id: string; name: string } | null {
  const pick = (a: AgentRecord | undefined | null): { id: string; name: string } | null =>
    a && a.status === 'active' ? { id: a.id, name: a.name } : null;

  if (task.agent_id) {
    const byId = pick(getAgentById(task.agent_id));
    if (byId) return byId;
  }
  if (task.assignee && task.assignee !== 'User' && task.assignee !== 'AI IDE Agent') {
    const byName = pick(getAgentByName(task.assignee));
    if (byName) return byName;
  }
  return pick(getAgentByName(defaultAgentName));
}

/** Poll a task until it reaches a terminal status, the per-task timeout trips,
 *  or the loop is stopped. */
async function waitForTerminal(taskId: string, timeoutMs: number): Promise<TaskOutcome> {
  const start = Date.now();
  state.currentTaskId = taskId;
  let sawActive = false; // task entered doing/review (the job actually picked it up)
  try {
    while (state.running) {
      const t = getTaskById(taskId);
      if (!t)                    return 'failed';   // archived/deleted mid-run
      if (t.status === 'done')   return 'done';
      if (t.status === 'failed') return 'failed';
      if (t.status === 'blocked') return 'blocked';
      if (t.status === 'doing' || t.status === 'review') {
        sawActive = true;
      } else if (t.status === 'todo' && sawActive) {
        // The holdout reviewer ran and bounced the work back to 'todo' (retry
        // queue). That's terminal for this dispatch — move on instead of
        // burning the per-task cap waiting for a done/failed that won't come.
        return 'rejected';
      }
      if (Date.now() - start > timeoutMs) return 'timeout';
      await sleep(POLL_MS);
    }
    return 'timeout'; // stopped mid-wait
  } finally {
    state.currentTaskId = null;
  }
}

function buildReport(reason: StopReason): string {
  const o = state.opts!;
  const dur = state.startedAt ? Math.round(((state.stoppedAt ?? Date.now()) - state.startedAt) / 60000) : 0;
  const done   = state.worked.filter((w) => w.outcome === 'done');
  const failed = state.worked.filter((w) => w.outcome !== 'done');
  const reasonLabel: Record<StopReason, string> = {
    boardEmpty:    'no more todo tasks on the board',
    maxTasks:      `reached the ${o.maxTasks}-task budget`,
    deadline:      `hit the ${o.maxMinutes}-minute time budget`,
    failureStreak: `${o.maxConsecutiveFailures} tasks failed in a row (likely a systemic blocker)`,
    manual:        'stopped on request',
    error:         'the loop hit an internal error',
  };

  const lines: string[] = [];
  lines.push(`**Autonomous run complete** — ${reasonLabel[reason]}.`);
  lines.push('');
  lines.push(`Worked **${state.worked.length}** task(s) in ~${dur} min · ${done.length} done · ${failed.length} not done · ${state.skipped} skipped (no agent).`);
  if (done.length) {
    lines.push('');
    lines.push('**Completed (parked at `review` for your sign-off):**');
    for (const w of done) lines.push(`- ${w.title} — _@${w.agent}_`);
  }
  if (failed.length) {
    lines.push('');
    lines.push('**Did not finish:**');
    for (const w of failed) lines.push(`- ${w.title} — _@${w.agent}_ (${w.outcome})`);
  }

  // Read-only self-heal telemetry: show what injection WOULD inject before it's armed.
  try {
    const stats = healMemoryStats();
    lines.push('');
    lines.push(`**Self-heal memory** — ${stats.total} signature(s) observed · ${stats.learned} learned · ${stats.observing} observing · ${stats.demoted} demoted.`);
    const candidates = candidateFixes();
    if (candidates.length) {
      lines.push('');
      lines.push('**Candidate fixes (injection would use these if SELF_HEAL_FIX_INJECTION=true):**');
      for (const c of candidates) {
        const ready = c.distinct_sessions >= config.selfHeal.trustHitCount && c.verify_fail === 0;
        lines.push(`- \`${c.signature}\` — ${c.error_class} in ${c.module_ident} · pass ${c.verify_pass} / fail ${c.verify_fail} · ${c.distinct_sessions} distinct session(s) · ${ready ? '**TRUSTED**' : 'prior'}`);
        lines.push(`  > ${c.verified_fix.split('\n')[0].slice(0, 160)}`);
      }
    }
  } catch (err) {
    logger.warn('autonomous-loop: self-heal telemetry failed (non-fatal)', { error: String(err) });
  }

  lines.push('');
  lines.push('_Review the completed tasks in Mission Control and approve or send back. Run autonomous mode again to continue._');
  return lines.join('\n');
}

function finish(reason: StopReason): void {
  state.running    = false;
  state.stoppedAt  = Date.now();
  state.stopReason = reason;

  const report = buildReport(reason);
  try {
    if (state.sessionId) {
      const driver = getAgentByName(state.opts!.defaultAgentName);
      saveMessage(state.sessionId, 'assistant', report, driver?.id);
    }
  } catch (err) {
    logger.warn('autonomous-loop: failed to persist report', { error: String(err) });
  }

  logHive(
    'autonomous_stopped',
    `Autonomous run stopped (${reason}): ${state.worked.length} worked, ${state.skipped} skipped`,
    undefined,
    {
      reason,
      worked: state.worked.length,
      done:   state.worked.filter((w) => w.outcome === 'done').length,
      failed: state.worked.filter((w) => w.outcome !== 'done').length,
      skipped: state.skipped,
      runId:  state.runId,
    },
    undefined,
    state.sessionId ?? undefined,
  );
  logger.info('autonomous-loop: stopped', { reason, worked: state.worked.length, runId: state.runId });
}

async function drive(): Promise<void> {
  const o = state.opts!;
  // maxTasks / maxMinutes of 0 mean "unlimited" — drain the whole board.
  const deadline = o.maxMinutes > 0 ? state.startedAt! + o.maxMinutes * 60_000 : Infinity;
  const skip = new Set<string>();
  let reason: StopReason = 'boardEmpty';

  try {
    while (state.running) {
      if (o.maxTasks > 0 && state.worked.length >= o.maxTasks)   { reason = 'maxTasks';      break; }
      if (Date.now() >= deadline)                                { reason = 'deadline';      break; }
      if (state.consecutiveFailures >= o.maxConsecutiveFailures) { reason = 'failureStreak'; break; }

      const todos = getTasks('todo', o.projectId ? { project_id: o.projectId } : {});
      // Stale guard: skip tasks created more than maxTaskAgeDays ago so the loop
      // doesn't churn through weeks-old junk. Uses created_at (not updated_at,
      // which the loop itself bumps on every review-bounce). 0 = no age limit.
      const ageCutoffMs = o.maxTaskAgeDays > 0 ? Date.now() - o.maxTaskAgeDays * 86_400_000 : 0;
      const next = todos.find((t) =>
        !skip.has(t.id) &&
        (ageCutoffMs === 0 || new Date(t.created_at).getTime() >= ageCutoffMs));
      if (!next) { reason = 'boardEmpty'; break; }

      const agent = resolveAgentForTask(next, o.defaultAgentName);
      if (!agent) {
        skip.add(next.id);
        state.skipped++;
        logHive('autonomous_task_failed', `No active agent for "${next.title}" — skipped`, undefined, { taskId: next.id });
        continue;
      }

      logger.info('autonomous-loop: dispatching task', { taskId: next.id, title: next.title, agent: agent.name });
      // Take ownership BEFORE dispatch: _runAgentTask's stillOwner() guard only
      // writes the task result when task.agent_id === the job's agentId. Tasks
      // dispatched here often have a null agent_id (assignee was free text like
      // "User"), so without this the result write is silently skipped and the
      // task gets stranded in 'doing'.
      // Write-site #3 — sync assignee alongside agent_id so the card/monitors
      // don't strand a stale "User" label on a task we just took ownership of.
      if (next.agent_id !== agent.id) updateTask(next.id, { agent_id: agent.id, assignee: agent.name });
      enqueueJob('agent_task', {
        taskId:          next.id,
        agentId:         agent.id,
        agentName:       agent.name,
        taskTitle:       next.title,
        taskDescription: next.description ?? '',
      });

      const outcome = await waitForTerminal(next.id, o.perTaskTimeoutMs);
      skip.add(next.id);
      state.worked.push({ id: next.id, title: next.title, agent: agent.name, outcome });

      if (outcome === 'done') {
        state.consecutiveFailures = 0;
        logHive('autonomous_task_done', `Autonomous: "${next.title}" → done (by ${agent.name})`, agent.id, { taskId: next.id });
      } else {
        // The stop-guard exists to catch SYSTEMIC breakage (dead provider, bad
        // creds), so only 'timeout'/'failed'/'blocked' (couldn't run / storm-broken)
        // escalate the streak. 'rejected' means the task ran and the reviewer ran —
        // the system is healthy, the work just didn't pass — so it resets the streak.
        // This lets an unlimited run drain a board of mixed-quality tasks instead of
        // stopping after 3 quality-bounces in a row.
        if (outcome === 'timeout' || outcome === 'failed' || outcome === 'blocked') state.consecutiveFailures++;
        else state.consecutiveFailures = 0;
        logHive('autonomous_task_failed', `Autonomous: "${next.title}" → ${outcome} (by ${agent.name})`, agent.id, { taskId: next.id, outcome });
      }
    }
    if (!state.running) reason = 'manual';
  } catch (err) {
    reason = 'error';
    logger.error('autonomous-loop: driver threw', { error: String(err) });
  } finally {
    finish(reason);
  }
}

export interface AutonomousStatus {
  running:             boolean;
  runId:               string | null;
  sessionId:           string | null;
  startedAt:           number | null;
  stoppedAt:           number | null;
  stopReason:          StopReason | null;
  currentTaskId:       string | null;
  consecutiveFailures: number;
  worked:              WorkedTask[];
  skipped:             number;
}

export function getAutonomousStatus(): AutonomousStatus {
  return {
    running:             state.running,
    runId:               state.runId,
    sessionId:           state.sessionId,
    startedAt:           state.startedAt,
    stoppedAt:           state.stoppedAt,
    stopReason:          state.stopReason,
    currentTaskId:       state.currentTaskId,
    consecutiveFailures: state.consecutiveFailures,
    worked:              state.worked,
    skipped:             state.skipped,
  };
}

/** Start the autonomous loop. Returns the run handle. No-op (returns the live
 *  status) if a loop is already running. */
export function startAutonomousLoop(overrides: Partial<AutonomousOptions> = {}): { ok: boolean; reason?: string; status: AutonomousStatus } {
  if (state.running) {
    return { ok: false, reason: 'already_running', status: getAutonomousStatus() };
  }

  const cfg = config.autonomous;
  const opts: AutonomousOptions = {
    maxTasks:               overrides.maxTasks               ?? cfg.maxTasks,
    maxMinutes:             overrides.maxMinutes             ?? cfg.maxMinutes,
    maxConsecutiveFailures: overrides.maxConsecutiveFailures ?? cfg.maxConsecutiveFailures,
    perTaskTimeoutMs:       overrides.perTaskTimeoutMs       ?? cfg.perTaskTimeoutMs,
    projectId:              overrides.projectId,
    maxTaskAgeDays:         overrides.maxTaskAgeDays         ?? cfg.maxTaskAgeDays,
    defaultAgentName:       overrides.defaultAgentName       ?? cfg.defaultAgentName,
    triggeredBy:            overrides.triggeredBy            ?? 'dashboard',
  };

  const driver = getAgentByName(opts.defaultAgentName);
  const runId  = `auto-${Date.now()}`;
  const sessionId = createSession(driver?.id ?? '', `Autonomous run — ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`, 'autonomous');

  state.running = true;
  state.runId = runId;
  state.sessionId = sessionId;
  state.startedAt = Date.now();
  state.stoppedAt = null;
  state.stopReason = null;
  state.currentTaskId = null;
  state.consecutiveFailures = 0;
  state.worked = [];
  state.skipped = 0;
  state.opts = opts;

  logHive('autonomous_started', `Autonomous run started (${opts.triggeredBy}): up to ${opts.maxTasks} tasks / ${opts.maxMinutes}min`, driver?.id, { runId, opts }, undefined, sessionId);
  logger.info('autonomous-loop: started', { runId, opts });

  // Fire-and-forget the driver; it manages its own lifecycle + report-back.
  void drive();

  return { ok: true, status: getAutonomousStatus() };
}

/** Request a cooperative stop. The loop finishes the in-flight task's wait,
 *  then reports back. */
export function stopAutonomousLoop(): { ok: boolean; status: AutonomousStatus } {
  if (!state.running) return { ok: false, status: getAutonomousStatus() };
  state.running = false;
  logger.info('autonomous-loop: stop requested', { runId: state.runId });
  return { ok: true, status: getAutonomousStatus() };
}
