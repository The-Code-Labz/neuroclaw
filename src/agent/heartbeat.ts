// Per-turn heartbeat emitter (v3.2). Replaces the silent 15s `:` SSE
// keepalive with structured events the dashboard can actually display:
//
//   { type: 'heartbeat', turn: 4, elapsedMs: 47000, currentActivity: 'tool: search_memory' }
//
// Two consumers:
//   1. The SSE stream (route writes it directly to the live tab)
//   2. runs.last_heartbeat_at / current_activity / turn_number / partial_output
//      (persisted via updateRunHeartbeat — what /api/chat/resume reads)
//
// The interval keeps ticking until isTurnFinished() returns true, then
// auto-clears. The route handler also gets a stop() closure for the
// `finally` path so we don't leak intervals.

import { updateRunHeartbeat } from '../db';
import { getTurnState, isTurnFinished } from './turn-state';
import { agentBus } from '../system/event-bus';

export interface HeartbeatEvent {
  type:            'heartbeat';
  sessionId:       string;
  runId:           string;
  agentId:         string;
  turn:            number;
  elapsedMs:       number;
  currentActivity: string;
}

/**
 * Start a heartbeat timer. Returns a stop() function — call it from your
 * route's finally block (or just let the natural isTurnFinished() check
 * end it; both are safe).
 *
 * `onBeat` is invoked on every tick. It MAY throw (e.g. SSE stream closed) —
 * we swallow the error so the persisted heartbeat path stays alive even
 * after the client has gone. The bus emit happens regardless so
 * /api/chat/resume can still pick up the event for a re-attached client.
 */
export function startHeartbeat(
  sessionId: string,
  runId: string,
  onBeat: (e: HeartbeatEvent) => void,
  intervalMs?: number,
): () => void {
  const interval = intervalMs ?? Number(process.env.DASHBOARD_HEARTBEAT_INTERVAL_MS ?? '10000');
  let stopped = false;

  const handle = setInterval(() => {
    if (stopped) return;
    // Auto-stop once the turn is marked done/paused/stopped.
    if (isTurnFinished(sessionId)) {
      stopped = true;
      clearInterval(handle);
      return;
    }
    const state = getTurnState(sessionId);
    if (!state) return;

    const event: HeartbeatEvent = {
      type:            'heartbeat',
      sessionId,
      runId,
      agentId:         state.agentId,
      turn:            state.turnNumber,
      elapsedMs:       Date.now() - state.startedAt,
      currentActivity: state.currentActivity,
    };

    // 1. Persist — survives client disconnect, source of truth for resume.
    updateRunHeartbeat(runId, state.currentActivity, state.turnNumber);

    // 2. Cross-process bus — picked up by /api/chat/resume to re-attach.
    try {
      agentBus.emitAgent(event);
    } catch { /* bus emit should not crash the loop */ }

    // 3. Live SSE callback — may fail if client gone, that's fine.
    try { onBeat(event); } catch { /* stream might be gone */ }
  }, interval);

  // setInterval keeps the process alive — unref so we don't block shutdown.
  if (typeof handle.unref === 'function') handle.unref();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
