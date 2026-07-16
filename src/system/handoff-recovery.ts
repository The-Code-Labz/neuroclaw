// Durable synchronous agent hand-off recovery (v4.1).
//
// message_agent and assign_task_to_agent(execute_now) both await a peer turn
// inside the calling process. If the process restarts mid-await, the in-memory
// promise evaporates. This module writes a lightweight recovery record BEFORE
// the await, heartbeats it on the existing 20s cadence, and — on restart —
// harvests the peer's output from its child session (read-only: no re-run).
//
// Recovery is strictly read-only. It never calls chatStream/runAgentTurn.
// If the child session has no completed assistant turn after the record's
// created_at, the hand-off is marked orphaned/failed and the user is notified.

import { randomUUID } from 'crypto';
import {
  getDb,
  getAgentById,
  getSessionMessages,
  saveMessage,
  updateAgentMessageResponse,
  createAgentUserMessage,
  wasHandoffDelivered,
  markHandoffDelivered,
} from '../db';
import { updateTask } from './task-manager';
import { agentBus } from './event-bus';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

// A crashed process stops heartbeating immediately; a busy but alive hand-off
// refreshes every 20s. 60s gives one missed beat + margin before recovery.
const HANDOFF_STALE_MS = 60_000;

export interface HandoffRecord {
  id: string;
  caller_session_id: string | null;
  caller_agent_id: string | null;
  caller_run_id: string | null;
  target_agent_id: string;
  target_session_id: string;
  message: string;
  source: 'message_agent' | 'execute_now';
  agent_message_id: string | null;
  task_id: string | null;
  parent_handoff_id: string | null;
  depth: number;
  status: 'running' | 'done' | 'failed' | 'orphaned';
  response: string | null;
  error: string | null;
  created_at: string;
  heartbeat_at: number;
  completed_at: string | null;
}

export interface StartHandoffInput {
  callerSessionId?: string | null;
  callerAgentId?: string | null;
  callerRunId?: string | null;
  targetAgentId: string;
  targetSessionId: string;
  message: string;
  source: 'message_agent' | 'execute_now';
  agentMessageId?: string | null;
  taskId?: string | null;
  parentHandoffId?: string | null;
}

export type HandoffCallContext = Omit<StartHandoffInput, 'targetAgentId' | 'targetSessionId' | 'message'>;

function agentName(agentId: string | null): string {
  if (!agentId) return 'system';
  return getAgentById(agentId)?.name ?? agentId;
}

export function startHandoffRecord(input: StartHandoffInput): string {
  const id = randomUUID();
  const nowIso = new Date().toISOString();
  let depth = 0;
  if (input.parentHandoffId) {
    const parent = getDb()
      .prepare('SELECT depth FROM handoff_recovery WHERE id = ?')
      .get(input.parentHandoffId) as { depth: number } | undefined;
    depth = (parent?.depth ?? 0) + 1;
  }

  getDb().prepare(`
    INSERT INTO handoff_recovery
      (id, caller_session_id, caller_agent_id, caller_run_id, target_agent_id,
       target_session_id, message, source, agent_message_id, task_id,
       parent_handoff_id, depth, status, created_at, heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(
    id,
    input.callerSessionId ?? null,
    input.callerAgentId ?? null,
    input.callerRunId ?? null,
    input.targetAgentId,
    input.targetSessionId,
    input.message,
    input.source,
    input.agentMessageId ?? null,
    input.taskId ?? null,
    input.parentHandoffId ?? null,
    depth,
    nowIso,
    Date.now(),
  );

  return id;
}

export function touchHandoffHeartbeat(id: string): void {
  getDb().prepare(`
    UPDATE handoff_recovery
    SET heartbeat_at = ?
    WHERE id = ? AND status = 'running'
  `).run(Date.now(), id);

  // For execute_now hand-offs, the task row has no job_queue backing, so
  // Sentinel/task-liveness depends on tasks.last_heartbeat_at. Stamp it here
  // so the new mechanism and the existing watchers agree the task is live.
  const taskId = getDb()
    .prepare('SELECT task_id FROM handoff_recovery WHERE id = ?')
    .get(id) as { task_id: string | null } | undefined;
  if (taskId?.task_id) {
    getDb().prepare(`
      UPDATE tasks SET last_heartbeat_at = ? WHERE id = ? AND status = 'doing'
    `).run(Date.now(), taskId.task_id);
  }
}

export function completeHandoffRecord(id: string, response: string): void {
  getDb().prepare(`
    UPDATE handoff_recovery
    SET status = 'done', response = ?, completed_at = ?
    WHERE id = ? AND status = 'running'
  `).run(response, new Date().toISOString(), id);
}

export function failHandoffRecord(id: string, error: string): void {
  getDb().prepare(`
    UPDATE handoff_recovery
    SET status = 'failed', error = ?, completed_at = ?
    WHERE id = ? AND status = 'running'
  `).run(error, new Date().toISOString(), id);
}

export function findRunningHandoffByTargetSession(sessionId: string): HandoffRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM handoff_recovery
    WHERE target_session_id = ? AND status = 'running'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(sessionId) as HandoffRecord | undefined;
  return row ?? null;
}

function getHandoffRecord(id: string): HandoffRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM handoff_recovery WHERE id = ?')
    .get(id) as HandoffRecord | undefined;
  return row ?? null;
}

function harvestResponse(record: HandoffRecord): string | null {
  try {
    const messages = getSessionMessages(record.target_session_id);
    // Find the latest assistant message strictly after the hand-off began.
    const after = messages
      .filter((m) => m.role === 'assistant' && m.created_at > record.created_at)
      .pop();
    return after?.content?.trim() ?? null;
  } catch (err) {
    logger.warn('handoff-recovery: failed to read child session messages', {
      handoffId: record.id,
      error: (err as Error).message,
    });
    return null;
  }
}

function notifyUser(record: HandoffRecord, body: string, kind: 'alert' | 'update'): void {
  try {
    createAgentUserMessage({
      fromAgentId: record.target_agent_id,
      fromName: agentName(record.target_agent_id),
      kind,
      body,
      sessionId: record.caller_session_id ?? null,
      metadata: {
        handoff_id: record.id,
        source: record.source,
        caller_session_id: record.caller_session_id,
        target_session_id: record.target_session_id,
      },
    });
  } catch (err) {
    logger.warn('handoff-recovery: failed to create user notification', {
      handoffId: record.id,
      error: (err as Error).message,
    });
  }
}

function deliverRecoveredResult(
  record: HandoffRecord,
  text: string,
  isOrphan: boolean,
  staleAfterMs: number,
): void {
  const targetName = agentName(record.target_agent_id);
  const deliveryTarget = record.caller_session_id ?? '';

  // Gate: a recovered result must be delivered into a target session exactly once.
  // Without this, a nested A→B→C chain recovered in one sweep can be delivered
  // twice into A's session (the sweep recovers C, cascades through B, then later
  // iterates B directly). The ledger is the same tts_deliveries pattern.
  if (wasHandoffDelivered(record.id, deliveryTarget)) {
    logger.debug('handoff-recovery: recovered result already delivered, skipping', {
      handoffId: record.id,
      callerSessionId: record.caller_session_id,
    });
    return;
  }

  // 1) Update the durable linked rows that the two tool handlers already own.
  if (record.agent_message_id) {
    try {
      updateAgentMessageResponse(
        record.agent_message_id,
        text,
        isOrphan ? 'failed' : 'responded',
      );
    } catch (err) {
      logger.warn('handoff-recovery: failed to update agent_messages', {
        handoffId: record.id,
        error: (err as Error).message,
      });
    }
  }

  if (record.task_id) {
    try {
      if (isOrphan) {
        updateTask(record.task_id, { status: 'failed', last_error: text });
      } else {
        updateTask(record.task_id, { status: 'review', output: text });
      }
    } catch (err) {
      logger.warn('handoff-recovery: failed to update task', {
        handoffId: record.id,
        taskId: record.task_id,
        error: (err as Error).message,
      });
    }
  }

  // 2) Deliver into the caller's session so a re-attached dashboard/comms view sees it.
  if (record.caller_session_id) {
    try {
      saveMessage(
        record.caller_session_id,
        'assistant',
        text,
        record.target_agent_id,
      );

      if (record.caller_run_id) {
        agentBus.emitAgent({
          type: 'meta',
          sessionId: record.caller_session_id,
          runId: record.caller_run_id,
          event: {
            type: isOrphan ? 'handoff_orphaned' : 'handoff_recovered',
            handoff_id: record.id,
            source: record.source,
            target_agent_id: record.target_agent_id,
            target_name: targetName,
            preview: text.slice(0, 200),
          },
        });
      }
    } catch (err) {
      logger.warn('handoff-recovery: failed to deliver to caller session', {
        handoffId: record.id,
        error: (err as Error).message,
      });
    }
  }

  // 3) Surface an explicit notification for failures / orphans.
  if (isOrphan || !record.caller_session_id) {
    notifyUser(
      record,
      isOrphan
        ? `Hand-off to ${targetName} was interrupted and could not be recovered: no peer output was found.`
        : text,
      isOrphan ? 'alert' : 'update',
    );
  }

  // Record successful delivery (or best-effort attempt) so a later sweep in the
  // same recovery cycle cannot duplicate it.
  markHandoffDelivered(record.id, deliveryTarget);

  // 4) Cascade through evaporated intermediate frames (A→B→C).
  //    The innermost child recovered first. Walk up the chain while each parent
  //    is also stale (i.e. its process frame evaporated). Use the parent's own
  //    harvested output if it has one; otherwise forward the child's result.
  if (record.parent_handoff_id) {
    const parent = getHandoffRecord(record.parent_handoff_id);
    if (parent && parent.status === 'running' && Date.now() - parent.heartbeat_at > staleAfterMs) {
      const parentResponse = harvestResponse(parent) ?? text;
      completeHandoffRecord(parent.id, parentResponse);

      // Leave a breadcrumb in the intermediate agent's own work session.
      try {
        saveMessage(
          parent.target_session_id,
          'assistant',
          `Recovered hand-off result forwarded from ${targetName}: ${parentResponse.slice(0, 500)}`,
          record.target_agent_id,
        );
      } catch (err) {
        logger.warn('handoff-recovery: failed to leave cascade breadcrumb', {
          handoffId: record.id,
          parentHandoffId: parent.id,
          error: (err as Error).message,
        });
      }

      deliverRecoveredResult(parent, parentResponse, isOrphan, staleAfterMs);
    }
  }
}

function recoverOneHandoff(record: HandoffRecord, staleAfterMs: number): void {
  // Re-fetch: another recovery pass (or an in-sweep cascade) may have already
  // completed this record. If it is no longer running, do not harvest again and
  // do not re-deliver.
  const live = getHandoffRecord(record.id);
  if (!live || live.status !== 'running') {
    logger.debug('handoff-recovery: record already terminal, skipping', { handoffId: record.id, status: live?.status });
    return;
  }

  const response = harvestResponse(record);
  const targetName = agentName(record.target_agent_id);

  if (response) {
    completeHandoffRecord(record.id, response);
    logHive(
      'handoff_recovered',
      `handoff-recovery: recovered ${record.source} output from ${targetName} (session ${record.target_session_id})`,
      record.caller_agent_id ?? undefined,
      { handoffId: record.id, source: record.source, targetSessionId: record.target_session_id },
      record.caller_run_id ?? undefined,
      record.caller_session_id ?? undefined,
    );
    deliverRecoveredResult(record, response, false, staleAfterMs);
  } else {
    const error = `Hand-off to ${targetName} produced no recoverable peer output`;
    getDb().prepare(`
      UPDATE handoff_recovery
      SET status = 'orphaned', error = ?, completed_at = ?
      WHERE id = ? AND status = 'running'
    `).run(error, new Date().toISOString(), record.id);

    logHive(
      'handoff_orphaned',
      `handoff-recovery: orphaned ${record.source} to ${targetName} — no assistant turn in child session`,
      record.caller_agent_id ?? undefined,
      { handoffId: record.id, source: record.source, targetSessionId: record.target_session_id },
      record.caller_run_id ?? undefined,
      record.caller_session_id ?? undefined,
    );
    deliverRecoveredResult(record, error, true, staleAfterMs);
  }
}

/**
 * Find hand-offs whose heartbeat went stale and harvest their peer output.
 * Safe to call repeatedly: records in a terminal state are ignored, and the
 * UPDATE is gated on status='running' so a concurrent recovery never double-runs.
 */
export function recoverStuckHandoffs(staleAfterMs: number = HANDOFF_STALE_MS): number {
  const cutoff = Date.now() - staleAfterMs;
  const rows = getDb().prepare(`
    SELECT * FROM handoff_recovery
    WHERE status = 'running' AND heartbeat_at < ?
    ORDER BY depth DESC, created_at DESC
  `).all(cutoff) as HandoffRecord[];

  if (rows.length > 0) {
    logger.info('handoff-recovery: recovering stale hand-offs', {
      count: rows.length,
      staleAfterMs,
    });
  }

  for (const record of rows) {
    try {
      recoverOneHandoff(record, staleAfterMs);
    } catch (err) {
      logger.error('handoff-recovery: recovery failed for record', {
        handoffId: record.id,
        error: (err as Error).message,
      });
    }
  }

  return rows.length;
}

const RECOVERY_SWEEP_INTERVAL_MS = HANDOFF_STALE_MS; // 60s
let recoverySweepTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic recovery sweep. Runs an immediate sweep and then every
 * 60s so wedge-without-crash cases are recovered, not just restart cases.
 */
export function startHandoffRecoverySweep(intervalMs: number = RECOVERY_SWEEP_INTERVAL_MS): number {
  if (recoverySweepTimer) {
    logger.warn('handoff-recovery: sweep already running — skipping duplicate start');
    return 0;
  }
  const initial = recoverStuckHandoffs();
  recoverySweepTimer = setInterval(() => {
    try {
      recoverStuckHandoffs();
    } catch (err) {
      logger.error('handoff-recovery: periodic sweep failed', { error: (err as Error).message });
    }
  }, intervalMs);
  logger.info('handoff-recovery: periodic sweep started', { intervalMs });
  return initial;
}

export function stopHandoffRecoverySweep(): void {
  if (recoverySweepTimer) {
    clearInterval(recoverySweepTimer);
    recoverySweepTimer = null;
  }
}
