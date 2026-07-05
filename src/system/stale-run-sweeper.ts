// Stale-run sweeper (v4.0).
//
// Catches runs whose heartbeat went silent — almost always because the host
// process died mid-loop. Now async with cooperative batching (spec: sweep-yield-batching),
// scenario-specific grace periods (spec: task-sweep-grace-periods), a reentrancy
// guard, and detached-task-runtime hooks (spec: detached-task-runtime).
//
// Scheduling lives here (not in sentinel) so the dashboard chat reliability
// concern stays self-contained. Started once from src/dashboard/server.ts.

import { getDb, listStaleRuns, markRunDropped, listUndeliveredDiscordRuns, type RunRecord } from '../db';
import { deliverRun, MAX_NOTIFY_ATTEMPTS } from './run-delivery';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDetachedTaskLifecycleRuntime } from './detached-task-runtime';
import { TASK_SWEEP_CONFIG } from '../config/task-sweep-config';

// ── Constants ────────────────────────────────────────────────────────────────

const SWEEP_YIELD_BATCH_SIZE = 25;

/** Grace periods for run-level stale detection (mirrors TASK_SWEEP_CONFIG for runs). */
const TASK_RECONCILE_GRACE_MS         = TASK_SWEEP_CONFIG.RECONCILE_GRACE_MS;
const STALE_RUNNING_MS                = TASK_SWEEP_CONFIG.STALE_RUNNING_MS;
const CODEX_NATIVE_RECONCILE_GRACE_MS = TASK_SWEEP_CONFIG.CODEX_NATIVE_RECONCILE_GRACE_MS;

// ── Stale scenario types ─────────────────────────────────────────────────────

export type StaleScenario =
  | 'backing_session_missing'
  | 'stale_running'
  | 'subagent_recovery_wedged'
  | 'codex_native_childless';

export interface StaleDecision {
  action:  'retain' | 'mark_lost';
  reason:  string;
  ageMs:   number;
}

// ── Task record shape (minimal, for sweep evaluation) ────────────────────────

interface TaskRecord {
  id:                  string;
  status:              string;
  provider:            string | null;
  child_session_key:   string | null;
  last_heartbeat_at:   number | null;
  recovery_started_at: number | null;
  created_at:          string;   // ISO text from DB
}

// ── Summary type ─────────────────────────────────────────────────────────────

export interface RunSweepSummary {
  candidateRuns:  number;
  totalStale:     number;
  processed:      number;
  dropped:        number;
  skippedByGrace: number;
  skippedByRecovery: number;
  batches:        number;
  durationMs:     number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Resolve the provider for a run by joining to the agents table.
 * Returns null if the agent is not found.
 */
function resolveAgentProvider(agentId: string | null): string | null {
  if (!agentId) return null;
  try {
    const row = getDb().prepare(
      `SELECT provider FROM agents WHERE id = ? LIMIT 1`,
    ).get(agentId) as { provider: string | null } | undefined;
    return row?.provider ?? null;
  } catch {
    return null;
  }
}

/**
 * Scenario-specific grace period for a run record.
 */
function getRunGracePeriodMs(run: RunRecord, _nowMs: number): number {
  const agentProvider = resolveAgentProvider(run.initiating_agent_id);
  if (agentProvider === 'codex') return CODEX_NATIVE_RECONCILE_GRACE_MS;
  if (run.status === 'running' || run.status === 'detached') return STALE_RUNNING_MS;
  return TASK_RECONCILE_GRACE_MS;
}

// ── Task-level grace resolution (spec: task-sweep-grace-periods) ─────────────

function getTaskGracePeriod(_task: TaskRecord, scenario: StaleScenario): number {
  switch (scenario) {
    case 'codex_native_childless':      return TASK_SWEEP_CONFIG.CODEX_NATIVE_RECONCILE_GRACE_MS;
    case 'subagent_recovery_wedged':    return TASK_SWEEP_CONFIG.SUBAGENT_RECOVERY_WEDGE_GRACE_MS;
    case 'stale_running':               return TASK_SWEEP_CONFIG.STALE_RUNNING_MS;
    case 'backing_session_missing':
    default:                            return TASK_SWEEP_CONFIG.RECONCILE_GRACE_MS;
  }
}

function isCodexNativeSubagentTask(task: TaskRecord): boolean {
  return task.provider === 'codex' && !task.child_session_key?.trim();
}

function isSubagentRecoveryWedged(task: TaskRecord): boolean {
  if (!task.recovery_started_at) return false;
  const recoveryAge = Date.now() - task.recovery_started_at;
  return recoveryAge > TASK_SWEEP_CONFIG.SUBAGENT_RECOVERY_WEDGE_GRACE_MS;
}

export function evaluateStaleTask(task: TaskRecord, nowMs: number): StaleDecision {
  const ageMs = nowMs - new Date(task.created_at).getTime();

  // 1. Codex native childless — highest priority, longest grace
  if (isCodexNativeSubagentTask(task)) {
    const grace = getTaskGracePeriod(task, 'codex_native_childless');
    return ageMs < grace
      ? { action: 'retain', reason: 'codex_native_childless', ageMs }
      : { action: 'mark_lost', reason: 'codex_native_childless', ageMs };
  }

  // 2. Wedged recovery
  if (isSubagentRecoveryWedged(task)) {
    const grace = getTaskGracePeriod(task, 'subagent_recovery_wedged');
    return ageMs < grace
      ? { action: 'retain', reason: 'subagent_recovery_wedged', ageMs }
      : { action: 'mark_lost', reason: 'subagent_recovery_wedged', ageMs };
  }

  // 3. Stale running (no heartbeat progress)
  const heartbeatAge = nowMs - (task.last_heartbeat_at ?? new Date(task.created_at).getTime());
  if (task.status === 'doing' && heartbeatAge > TASK_SWEEP_CONFIG.STALE_RUNNING_MS) {
    return { action: 'mark_lost', reason: 'stale_running', ageMs };
  }

  // 4. Backing session missing (standard)
  if (!task.child_session_key && ageMs > TASK_SWEEP_CONFIG.RECONCILE_GRACE_MS) {
    return { action: 'mark_lost', reason: 'backing_session_missing', ageMs };
  }

  return { action: 'retain', reason: 'backing_session_present', ageMs };
}

// ── Reentrancy guard ─────────────────────────────────────────────────────────

let sweepInProgress = false;

// ── Main sweep logic ─────────────────────────────────────────────────────────

async function _runStaleRunSweepImpl(maxAgeMs?: number): Promise<RunSweepSummary> {
  const start = Date.now();
  const candidateThreshold = maxAgeMs ?? config.dashboard.runStaleMs;
  const candidates = listStaleRuns(candidateThreshold);

  const nowMs = Date.now();

  // Apply scenario-specific grace periods to filter out runs that are within grace
  const staleRuns = candidates.filter(run => {
    const grace = getRunGracePeriodMs(run, nowMs);
    const runAgeMs = nowMs - new Date(run.started_at).getTime();
    return runAgeMs >= grace;
  });

  const skippedByGrace = candidates.length - staleRuns.length;
  let processed = 0;
  let dropped = 0;
  let skippedByRecovery = 0;
  let batches = 0;

  for (let i = 0; i < staleRuns.length; i += SWEEP_YIELD_BATCH_SIZE) {
    const batch = staleRuns.slice(i, i + SWEEP_YIELD_BATCH_SIZE);
    batches++;

    for (const run of batch) {
      processed++;

      // Spec 6: give the detached runtime a chance to recover before marking lost
      try {
        const ageMs = nowMs - new Date(run.started_at).getTime();
        const recovery = await getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost({
          taskId: run.id,
          runId:  run.id,
          ageMs,
        });
        if (recovery.recovered) {
          logger.info('stale-run-sweeper: task recovered — skipping lost marking', {
            runId: run.id, reason: recovery.reason,
          });
          skippedByRecovery++;
          continue;
        }
      } catch (err) {
        logger.warn('stale-run-sweeper: tryRecoverTaskBeforeMarkLost threw', { runId: run.id, err: String(err) });
      }

      try {
        markRunDropped(run.id, 'stale-run-sweeper: dropped — exceeded grace period');
        dropped++;
        logger.warn('stale-run-sweeper: run marked dropped', {
          runId:       run.id,
          sessionId:   run.session_id,
          scenario:    run.status === 'running' || run.status === 'detached' ? 'stale_running' : 'backing_session_missing',
          gracePeriodMs: getRunGracePeriodMs(run, nowMs),
          ageMs:       nowMs - new Date(run.started_at).getTime(),
        });
      } catch (err) {
        logger.warn('stale-run-sweeper: failed to drop run', { runId: run.id, error: (err as Error).message });
      }
    }

    // Yield to event loop between batches (setImmediate — correct for cooperative yield)
    if (i + SWEEP_YIELD_BATCH_SIZE < staleRuns.length) {
      await yieldToEventLoop();
    }
  }

  const durationMs = Date.now() - start;
  logger.info('stale-run-sweeper: sweep complete', {
    candidateRuns: candidates.length,
    totalStale:    staleRuns.length,
    skippedByGrace,
    skippedByRecovery,
    processed,
    dropped,
    batches,
    durationMs,
  });

  return { candidateRuns: candidates.length, totalStale: staleRuns.length, processed, dropped, skippedByGrace, skippedByRecovery, batches, durationMs };
}

export async function runStaleRunSweep(maxAgeMs?: number): Promise<RunSweepSummary> {
  if (sweepInProgress) {
    logger.info('stale-run-sweeper: sweep already in progress — skipping tick');
    return { candidateRuns: 0, totalStale: 0, processed: 0, dropped: 0, skippedByGrace: 0, skippedByRecovery: 0, batches: 0, durationMs: 0 };
  }
  sweepInProgress = true;
  try {
    return await _runStaleRunSweepImpl(maxAgeMs);
  } finally {
    sweepInProgress = false;
  }
}

/**
 * Re-attempt delivery for terminal Discord-origin runs not yet delivered.
 * Crash-safe backstop for the immediate run:terminal hook.
 */
export async function runDeliveryRetrySweep(): Promise<{ retried: number }> {
  const pending = listUndeliveredDiscordRuns(MAX_NOTIFY_ATTEMPTS);
  let retried = 0;
  for (const run of pending) {
    try { await deliverRun(run.id); retried++; }
    catch (err) {
      logger.warn('delivery-retry: deliverRun failed', { runId: run.id, err: String(err) });
    }
  }
  return { retried };
}

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

export function startStaleRunSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    runStaleRunSweep().catch(err =>
      logger.warn('stale-run-sweeper: tick failed', { err: String(err) }));
    runDeliveryRetrySweep().catch(err =>
      logger.warn('delivery-retry: sweep failed', { err: String(err) }));
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('stale-run-sweeper: started', { tickMs: TICK_MS, staleMs: config.dashboard.runStaleMs });
}

export function stopStaleRunSweeper(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
