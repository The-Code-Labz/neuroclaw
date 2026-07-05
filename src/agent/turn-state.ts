// Per-session turn state — pure in-memory bookkeeping for the dashboard
// chat reliability overhaul (v3.2). Tracks whether an agent's current turn is
// still running, what it's currently doing, and which turn (loop iteration)
// it's on. The heartbeat emitter (heartbeat.ts) reads this; the compactor
// gates on isTurnFinished() so it never fires mid-loop; the route's stop
// handler calls markTurnDone(... 'stopped' ...).
//
// One entry per session — multiple parallel sessions are independent. There
// is no on-disk projection; persistence lives in the runs table (the
// heartbeat writes current_activity / partial_output / turn_number there).
//
// Lifecycle:
//   startTurn()       — at the top of chatStream / orchestrateMultiAgent
//   updateActivity()  — before each LLM call / before each tool dispatch
//   bumpTurn()        — at the bottom of each loop iteration
//   markTurnDone()    — when the loop exits cleanly OR on soft/hard cap OR
//                       on explicit /stop OR on error
//   clearTurn()       — in the `finally` block, so a stale state doesn't
//                       block the next turn's compactor

export type TurnSignal = 'done' | 'paused' | 'stopped';

export interface TurnState {
  sessionId:       string;
  runId:           string;
  agentId:         string;
  signal:          TurnSignal | null;     // null while still running
  reason?:         string;                // 'no_tool_calls' | 'soft_cap' | 'hard_cap' | 'user_stop' | 'error' | …
  turnNumber:      number;                // bumped per loop iteration
  startedAt:       number;                // Date.now()
  lastActivityAt:  number;                // Date.now() of most recent updateActivity()
  currentActivity: string;                // 'thinking' | 'tool: <name>' | 'waiting_llm' | …
}

const active = new Map<string, TurnState>();

export interface StartTurnInput {
  sessionId:       string;
  runId:           string;
  agentId:         string;
  turnNumber?:     number;
  startedAt?:      number;
  currentActivity?: string;
}

/** Register a new turn. Replaces any stale entry for the same session. */
export function startTurn(input: StartTurnInput): void {
  const now = Date.now();
  active.set(input.sessionId, {
    sessionId:       input.sessionId,
    runId:           input.runId,
    agentId:         input.agentId,
    signal:          null,
    turnNumber:      input.turnNumber ?? 0,
    startedAt:       input.startedAt ?? now,
    lastActivityAt:  now,
    currentActivity: input.currentActivity ?? 'thinking',
  });
}

/** Mark the turn finished. Subsequent isTurnFinished() returns true. */
export function markTurnDone(
  sessionId: string,
  signal: TurnSignal,
  reason?: string,
): void {
  const s = active.get(sessionId);
  if (!s) return;
  s.signal = signal;
  if (reason !== undefined) s.reason = reason;
  s.lastActivityAt = Date.now();
}

/**
 * True iff the turn has been explicitly marked done/paused/stopped, OR no
 * turn is registered at all (so the compactor can run on a freshly-loaded
 * session that has no active work). False while a turn is mid-flight.
 */
export function isTurnFinished(sessionId: string): boolean {
  const s = active.get(sessionId);
  if (!s) return true;            // no active turn → safe to run compactor
  return s.signal !== null;
}

export function getTurnState(sessionId: string): TurnState | undefined {
  return active.get(sessionId);
}

/** Update what the agent is currently doing. No-op if no turn registered. */
export function updateActivity(sessionId: string, activity: string): void {
  const s = active.get(sessionId);
  if (!s) return;
  s.currentActivity = activity;
  s.lastActivityAt = Date.now();
}

/** Increment the per-turn loop iteration counter. */
export function bumpTurn(sessionId: string): void {
  const s = active.get(sessionId);
  if (!s) return;
  s.turnNumber += 1;
  s.lastActivityAt = Date.now();
}

/**
 * Drop the entry entirely. Call from the chatStream / orchestrate `finally`
 * block so a crashed turn doesn't leave a stale "thinking" state behind.
 *
 * If `runId` is provided, the entry is only deleted when it still belongs to
 * this run. This prevents A's cleanup from evicting B's state when two
 * requests for the same session are queued concurrently — without the guard,
 * B's heartbeat auto-stops (sees no state → isTurnFinished → true) and run B
 * gets swept as stale by the stale-run-sweeper even though it's still in-flight.
 */
export function clearTurn(sessionId: string, runId?: string): void {
  if (runId !== undefined) {
    const s = active.get(sessionId);
    if (s && s.runId !== runId) return; // another run already registered; leave it alone
  }
  active.delete(sessionId);
}

// ── Test / introspection helpers (not used in production code paths) ────────
/** Internal — for tests only. Wipes every entry. */
export function _resetAllTurns(): void {
  active.clear();
}
/** Internal — for diagnostics. Snapshot of live turns. */
export function _listActiveTurns(): TurnState[] {
  return [...active.values()];
}
