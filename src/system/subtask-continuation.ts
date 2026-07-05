// Proactive continuation after fire-and-forget sub-agents finish.
//
// The gap this closes: an agent calls run_subtask, tells the user "I'm on it",
// and its turn ENDS. The sub-agent runs detached. When it finishes, the only
// trace is an agent_messages inbox note that surfaces on the user's NEXT
// message — so the user has to keep poking "are you done yet?".
//
// This module makes the agent come back on its own. When a session's
// sub-agents finish, it fires ONE continuation turn for the initiating agent
// (after all siblings complete, debounced) that synthesizes the result and
// delivers it to the same surface the user is on (Discord channel / dashboard
// session). The inbox notes + the subtask outputs we feed in let the agent
// answer the original request without the user prompting again.
//
// Distinct from run-continuation.ts, which handles a long-running MAIN turn
// that got backgrounded (fires on run:terminal). Sub-agents never fire
// run:terminal — they finish via taskEvents — so they need this separate path.

import {
  getDb, startRun, endRun, getAgentById, getRun, getLatestRunForSession,
  sessionHasActiveRun, markRunDelivered, type RunRecord,
} from '../db';
import { taskEvents } from './background-tasks';
import { runEvents, type RunTerminalEvent } from './event-bus';
import { chatStream } from '../agent/alfred';
import { postToChannel } from '../integrations/discord-bot';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';

// Coalesce window: when several subtasks finish close together (parallel
// run_subtask calls in one turn), wait this long after the last completion
// before firing a single continuation — never one per subtask.
const DEBOUNCE_MS = parseInt(process.env.SUBTASK_CONTINUATION_DEBOUNCE_MS ?? '4000', 10);
// Absolute runaway backstop: max auto-continuations per session in a rolling
// window, regardless of progress. Generous, because a legitimate deep-research
// task can do many productive rounds (each sub-agent takes minutes). This only
// catches true runaway; the progress-based spin guard below is the real
// control.
const MAX_PER_WINDOW = parseInt(process.env.SUBTASK_CONTINUATION_MAX_PER_WINDOW ?? '12', 10);
// Spin guard, PROGRESS-BASED (not count-based): after this many CONSECUTIVE
// UNPRODUCTIVE rounds — sub-agents returned only failures / blocked / empty /
// stub output, i.e. no new usable data — flip the prompt to "wrap up now, stop
// spawning". A productive round (a real new `done` result) RESETS the streak,
// so a deep-research task that keeps surfacing data is never cut off; only a
// flaky-tool loop that keeps coming back empty trips it.
const SPIN_GUARD_AFTER = parseInt(process.env.SUBTASK_CONTINUATION_SPIN_GUARD_AFTER ?? '2', 10);
const WINDOW_MS = 10 * 60_000;
// How far back to pull finished subtask outputs to feed the continuation.
const RESULT_LOOKBACK_MIN = 15;
// A `done` subtask counts as "productive" only if its output clears this many
// chars and isn't the exhausted-tool-turns sentinel — a stub or sentinel is no
// real progress.
const PRODUCTIVE_MIN_CHARS = 80;

interface TaskRow {
  session_id:   string | null;
  agent_id:     string | null;
  notify_policy:string | null;
  task_source:  string | null;
}

const debounceTimers = new Map<string, NodeJS.Timeout>();
const inFlight       = new Set<string>();

interface SessionState {
  windowStart:        number;  // rolling-window anchor
  total:              number;  // continuations fired this window (runaway backstop)
  unproductiveStreak: number;  // consecutive rounds with no new usable data
  lastConsumedAt:     string;  // max subtask updated_at already assessed (ISO; '' = none)
}
const sessionStates = new Map<string, SessionState>();
// Sessions whose subtasks settled while a turn was still live. The trigger is
// the completion EVENT, so without this a skipped session would never retry
// once the turn ends — the common case where a quick subtask finishes before
// the agent's own turn does. We re-arm these on the next run:terminal.
const pendingSessions = new Set<string>();

function loadTask(taskId: string): TaskRow | undefined {
  try {
    return getDb().prepare(
      `SELECT session_id, agent_id, notify_policy, task_source FROM tasks WHERE id = ?`,
    ).get(taskId) as TaskRow | undefined;
  } catch {
    return undefined;
  }
}

function anyDoingSubtask(sessionId: string): boolean {
  try {
    const row = getDb().prepare(
      `SELECT 1 FROM tasks WHERE session_id = ? AND task_source = 'subtask' AND status = 'doing' LIMIT 1`,
    ).get(sessionId) as { 1: number } | undefined;
    return !!row;
  } catch {
    return true; // fail safe: assume work pending, don't fire prematurely
  }
}

/** Recently-finished subtask outputs for the session, newest first, truncated. */
function recentSubtaskResults(sessionId: string): Array<{ title: string; status: string; output: string }> {
  try {
    const rows = getDb().prepare(
      `SELECT title, status, output, terminal_outcome, block_reason
         FROM tasks
        WHERE session_id = ? AND task_source = 'subtask'
          AND status IN ('done','failed','blocked')
          AND (julianday('now') - julianday(updated_at)) * 1440 <= ?
        ORDER BY updated_at DESC LIMIT 6`,
    ).all(sessionId, RESULT_LOOKBACK_MIN) as Array<{
      title: string; status: string; output: string | null;
      terminal_outcome: string | null; block_reason: string | null;
    }>;
    return rows.map(r => {
      let status = r.status;
      let body = r.output ?? '';
      if (r.status === 'failed') {
        try { body = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* raw */ }
      } else if (r.status === 'blocked' || r.terminal_outcome === 'blocked') {
        status = 'blocked';
        body = r.block_reason ?? body;
      }
      return { title: r.title, status, output: body.slice(0, 4000) };
    });
  } catch {
    return [];
  }
}

/**
 * Did any subtask settle with NEW usable data since `sinceIso`? Returns whether
 * the round was productive and the new high-water timestamp to remember. Only a
 * `done` subtask (terminal_outcome NULL → not progress-only/blocked) with
 * substantial, non-sentinel output counts as progress.
 */
function assessProgress(sessionId: string, sinceIso: string): { productive: boolean; maxUpdatedAt: string } {
  try {
    const rows = getDb().prepare(
      `SELECT status, output, terminal_outcome, updated_at
         FROM tasks
        WHERE session_id = ? AND task_source = 'subtask'
          AND status IN ('done','failed','blocked')
          AND updated_at > ?
        ORDER BY updated_at`,
    ).all(sessionId, sinceIso) as Array<{
      status: string; output: string | null; terminal_outcome: string | null; updated_at: string;
    }>;
    let productive = false;
    let maxUpdatedAt = sinceIso;
    for (const r of rows) {
      if (r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at;
      const out = (r.output ?? '').trim();
      if (
        r.status === 'done' &&
        r.terminal_outcome === null &&
        out.length >= PRODUCTIVE_MIN_CHARS &&
        !out.includes('[sub-agent incomplete')
      ) {
        productive = true;
      }
    }
    return { productive, maxUpdatedAt };
  } catch {
    // Fail toward "productive" so a query hiccup never wrongly forces wrap-up on
    // a legitimate deep-research session.
    return { productive: true, maxUpdatedAt: sinceIso };
  }
}

/**
 * Roll the session window, record this continuation, and decide the prompt mode.
 * Returns the 1-based attempt number, whether the spin guard should engage (too
 * many CONSECUTIVE UNPRODUCTIVE rounds), and the current unproductive streak —
 * or null if the absolute per-window backstop is exceeded (caller skips).
 *
 * Progress-based, so a deep-research task that keeps surfacing new data resets
 * its streak every productive round and is never prematurely wrapped up; only a
 * flaky-tool loop returning empties trips the guard.
 */
function evaluateRound(sessionId: string): { attemptNo: number; spinGuard: boolean; streak: number } | null {
  const now = Date.now();
  let st = sessionStates.get(sessionId);
  if (!st || now - st.windowStart > WINDOW_MS) {
    st = { windowStart: now, total: 0, unproductiveStreak: 0, lastConsumedAt: '' };
    sessionStates.set(sessionId, st);
  }
  if (st.total >= MAX_PER_WINDOW) return null;
  st.total++;

  const { productive, maxUpdatedAt } = assessProgress(sessionId, st.lastConsumedAt);
  st.lastConsumedAt = maxUpdatedAt;
  if (productive) st.unproductiveStreak = 0;
  else st.unproductiveStreak++;

  return {
    attemptNo: st.total,
    spinGuard: st.unproductiveStreak >= SPIN_GUARD_AFTER,
    streak:    st.unproductiveStreak,
  };
}

function parseDeliveryTarget(run: RunRecord | null): { botId?: string; channelId: string; userId?: string } | null {
  if (!run?.delivery_target) return null;
  try {
    const t = JSON.parse(run.delivery_target) as Record<string, unknown>;
    if (typeof t.channelId !== 'string') return null;
    return {
      botId:     typeof t.botId === 'string' ? t.botId : undefined,
      channelId: t.channelId,
      userId:    typeof t.userId === 'string' ? t.userId : undefined,
    };
  } catch {
    return null;
  }
}

async function runContinuation(sessionId: string): Promise<void> {
  if (inFlight.has(sessionId)) return;

  const results = recentSubtaskResults(sessionId);
  if (results.length === 0) return; // nothing to report

  const sourceRun = getLatestRunForSession(sessionId);
  const agentId   = sourceRun?.initiating_agent_id ?? null;
  if (!agentId) {
    logger.info('subtask-continuation: no initiating agent for session', { sessionId });
    return;
  }
  const agentRecord = getAgentById(agentId);
  if (!agentRecord || agentRecord.status !== 'active') return;
  if (agentRecord.provider === 'mcp') return; // MCP agents proxy externally

  const round = evaluateRound(sessionId);
  if (round === null) {
    logger.warn('subtask-continuation: window backstop hit — not auto-continuing', { sessionId, maxPerWindow: MAX_PER_WINDOW });
    return;
  }
  const { attemptNo, spinGuard, streak } = round;

  inFlight.add(sessionId);

  const resultsBlock = results.map((r, i) =>
    `Subtask ${i + 1} [${r.status}] "${r.title}":\n${r.output || '(no output)'}`,
  ).join('\n\n');

  // Spin guard (progress-based): only after consecutive UNPRODUCTIVE rounds do
  // we stop inviting more research and force a best-effort delivery. A
  // deep-research task making real progress resets the streak and keeps going;
  // a flaky-tool loop (search/fetch returns nothing → agent re-spawns) trips it.
  const continuationContext = spinGuard
    ? '[SUB-AGENTS FINISHED — WRAP UP NOW] You have already re-engaged on this goal several times in this session ' +
      'and the research/sub-agent tools are clearly not getting you a clean result. STOP — do NOT call run_subtask ' +
      'again. Deliver your best, complete answer to the user RIGHT NOW using the results below plus your own knowledge, ' +
      'and be honest about any gaps or which tools failed. A confident best-effort answer is what the user wants; ' +
      'more waiting or more searching is not. Be concise.\n\n' +
      '=== SUBTASK RESULTS ===\n' + resultsBlock
    : '[SUB-AGENTS FINISHED] The sub-agent task(s) you delegated in this session have completed — results below. ' +
      'The user is waiting and has NOT sent a new message, so proactively DELIVER the actual answer now using these ' +
      'results plus your own knowledge where they are thin. Prefer delivering a complete answer over launching more ' +
      'research — only spawn another sub-agent if a specific, essential piece is genuinely missing AND a sub-agent can ' +
      'realistically get it. Do not just acknowledge or say you are "working on it" — give the answer. Be concise.\n\n' +
      '=== SUBTASK RESULTS ===\n' + resultsBlock;

  const continuationRunId = startRun({
    origin:            'subtask-continuation',
    sessionId,
    initiatingAgentId: agentId,
    parentRunId:       sourceRun?.id ?? null,
    userMessage:       '[subtasks-complete]',
    // Carry the Discord target so any downstream delivery path can reach the user.
    deliveryTarget:    sourceRun?.delivery_target ? JSON.parse(sourceRun.delivery_target) as Record<string, unknown> : null,
  });

  let output = '';
  try {
    await chatStream(
      '[subtasks-complete]',
      sessionId,
      (chunk) => { output += chunk; },
      agentRecord.system_prompt ?? '',
      agentId,
      undefined,                 // onMeta
      undefined,                 // attachments
      continuationContext,       // extraSystemContext
      continuationRunId,
      undefined,                 // signal
      true,                      // suppressUserMessage — don't persist the synthetic prompt
    );
    endRun(continuationRunId, { status: 'done', final_output: output });
  } catch (err) {
    endRun(continuationRunId, { status: 'error', error_text: String(err) });
    logger.warn('subtask-continuation: chatStream failed', { sessionId, continuationRunId, err: String(err) });
    inFlight.delete(sessionId);
    return;
  }

  // Deliver to Discord if that's where the user is. Dashboard sessions persist
  // the assistant message via chatStream and surface it on reattach/poll.
  if (sourceRun?.origin === 'discord' && output.trim()) {
    const target = parseDeliveryTarget(sourceRun);
    if (target) {
      const res = await postToChannel(target.botId, target.channelId, output, { mentionUserId: target.userId });
      if (!res.ok) logger.warn('subtask-continuation: discord post failed', { sessionId, err: res.error });
    }
  }
  // Mark delivered so run-continuation's run:terminal listener doesn't fire a
  // second follow-up on top of this one.
  try { markRunDelivered(continuationRunId, 1); } catch { /* best-effort */ }

  logHive('subtask_continuation', `proactive continuation fired (attempt ${attemptNo}, unproductive streak ${streak}${spinGuard ? ' → spin-guard: wrap-up' : ''}, ${results.length} result(s))`, agentId, {
    sessionId, continuationRunId, origin: sourceRun?.origin ?? 'unknown', resultCount: results.length, attemptNo, spinGuard, unproductiveStreak: streak,
  });
  inFlight.delete(sessionId);
}

// Decide whether to fire now, defer (siblings still running), or park the
// session as pending (a live turn is in the way — retry when it ends).
function attempt(sessionId: string): void {
  if (anyDoingSubtask(sessionId)) return;            // a later completion reschedules
  if (sessionHasActiveRun(sessionId)) {
    // Don't collide with a live turn. Park it — the run:terminal listener
    // re-arms this session the moment the blocking run finishes.
    pendingSessions.add(sessionId);
    logger.info('subtask-continuation: deferred — session has an active run (re-arm on terminal)', { sessionId });
    return;
  }
  pendingSessions.delete(sessionId);
  runContinuation(sessionId).catch(err =>
    logger.warn('subtask-continuation: runContinuation threw', { sessionId, err: String(err) }),
  );
}

function scheduleAttempt(sessionId: string, delayMs: number): void {
  const existing = debounceTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId);
    attempt(sessionId);
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  debounceTimers.set(sessionId, timer);
}

function schedule(taskId: string): void {
  const task = loadTask(taskId);
  if (!task) return;
  if (task.task_source !== 'subtask') return;        // ignore non-subtask jobs
  if (task.notify_policy === 'never') return;         // user opted this subtask out
  const sessionId = task.session_id;
  if (!sessionId || !task.agent_id) return;
  scheduleAttempt(sessionId, DEBOUNCE_MS);
}

/**
 * Subscribe to sub-agent terminal events. Call once at startup alongside
 * startRunContinuation(). Coalesces parallel subtasks into a single proactive
 * continuation per session after all siblings finish.
 */
export function startSubtaskContinuation(): void {
  const onDone = (e: { taskId?: string }) => { if (e?.taskId) schedule(e.taskId); };
  taskEvents.on('task_complete', onDone);
  taskEvents.on('task_failed', onDone);
  taskEvents.on('task_blocked', onDone);

  // Re-arm parked sessions when the run blocking them finishes. Without this, a
  // subtask that completed mid-turn (skipped above) would never produce a
  // proactive continuation — exactly the gap testing surfaced. We listen on
  // BOTH the clean-terminal channel AND the dedicated 'run:dropped' channel:
  // a run swept to 'dropped' by the stale-run sweeper is a non-clean terminal
  // that does NOT fire 'run:terminal', so a session parked behind it would
  // otherwise stay stranded forever.
  const reArm = (e: RunTerminalEvent) => {
    const run = getRun(e.runId);
    if (!run?.session_id) return;
    // Ignore our own / wrap-up runs — only USER turns gate us.
    if (run.origin === 'subtask-continuation' || run.origin === 'continuation') return;
    if (!pendingSessions.has(run.session_id)) return;
    // Small delay so the run's status has fully committed before we re-check.
    scheduleAttempt(run.session_id, 1500);
  };
  runEvents.on('run:terminal', reArm);
  runEvents.on('run:dropped', reArm);

  logger.info('subtask-continuation: subscribed to subtask terminal events', {
    debounceMs: DEBOUNCE_MS, maxPerWindow: MAX_PER_WINDOW,
  });
}
