/**
 * system/pending-confirmation.ts — one shared "Pending Human Confirmation"
 * primitive (spec: ssh-machines-feature §4.3, deliverable #2).
 *
 * WHY THIS EXISTS
 *   `notify_user` is fire-and-forget — it writes a record and returns
 *   immediately. Two SSH flows need a real BLOCK-until-a-human-responds gate:
 *     • §4.2 critical-host confirm-before-run
 *     • §10  TOFU host-key first-connect pin approval
 *   Rather than build two, this is the single mechanism both consume.
 *
 * CONTRACT
 *   • Creates a `pending_confirmations` row, surfaces it to the human via the
 *     notifications channel (kind:"question") AND leaves it queryable for a
 *     dashboard approve/deny control (Connect → Machines, deliverable #6).
 *   • Blocks (polling) until the row is approved/denied, OR a hard ~10-min TTL
 *     elapses → **fail-closed deny** (no answer is a NO).
 *   • Cooperative-cancel aware: while waiting it bumps the run heartbeat so the
 *     orphan-run sweeper / Sentinel treat a legitimately-blocked turn as LIVE,
 *     not stalled (ties into isTaskLive semantics, §4.3).
 *
 *   v1 = per-call confirm. Session-scoped pre-issued grants are v2 (§4.3).
 */
import {
  createAgentUserMessage,
  createPendingConfirmation,
  expireStalePendingConfirmations,
  getPendingConfirmation,
  resolvePendingConfirmation,
  updateRunHeartbeat,
} from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

export type ConfirmationKind = 'ssh_critical_run' | 'ssh_tofu_pin';

export interface ConfirmationRequest {
  kind:        ConfirmationKind;
  /** Human-facing question shown in the notification + dashboard control. */
  title:       string;
  /** Optional extra context appended under the question. */
  detail?:     string;
  /** Reference to the subject being confirmed (e.g. machine id). */
  subjectRef?: string | null;
  agentId?:    string | null;
  agentName?:  string | null;
  sessionId?:  string | null;
  /** When provided, the waiting turn's run heartbeat is kept fresh. */
  runId?:      string | null;
  turnNumber?: number;
  payload?:    unknown;
  /** Hard timeout; default ~10 min per §4.3. */
  ttlMs?:      number;
}

export interface ConfirmationOutcome {
  approved:       boolean;
  status:         'approved' | 'denied' | 'expired';
  confirmationId: string;
  resolvedBy?:    string | null;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const POLL_MS        = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Request human confirmation and BLOCK until it is granted, denied, or times
 * out. Fail-closed: timeout / missing row / deny all resolve to approved=false.
 */
export async function requestConfirmation(req: ConfirmationRequest): Promise<ConfirmationOutcome> {
  const ttlMs = Math.max(30_000, req.ttlMs ?? DEFAULT_TTL_MS);

  const row = createPendingConfirmation({
    kind:       req.kind,
    subjectRef: req.subjectRef ?? null,
    agentId:    req.agentId ?? null,
    sessionId:  req.sessionId ?? null,
    payload:    req.payload,
    ttlMs,
  });

  // Surface to the human (notifications channel — Comms → Notifications).
  try {
    createAgentUserMessage({
      fromAgentId: req.agentId ?? 'ssh',
      fromName:    req.agentName ?? 'SSH',
      kind:        'question',
      body:        req.title + (req.detail ? `\n\n${req.detail}` : ''),
      metadata:    {
        pendingConfirmationId: row.id,
        confirmationKind:      req.kind,
        subjectRef:            req.subjectRef ?? null,
      },
      sessionId:   req.sessionId ?? null,
    });
  } catch (err) {
    // A notify failure must NOT bypass the gate — the dashboard control still
    // exposes the pending row, and timeout still fail-closes.
    logger.warn('pending-confirmation: notify failed', { err: String(err) });
  }

  logHive(
    'ssh_confirm_requested',
    `pending-confirmation: ${req.kind} — ${req.title.slice(0, 80)}`,
    req.agentId ?? undefined,
    { confirmationId: row.id, kind: req.kind, subjectRef: req.subjectRef ?? null },
  );

  const deadline = Date.now() + ttlMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);

    // Fail-closed sweep — marks any row past its TTL as expired (incl. this one).
    try { expireStalePendingConfirmations(); } catch { /* non-fatal */ }

    // Keep the blocked turn alive so Sentinel / the orphan sweeper don't kill it.
    if (req.runId) {
      try {
        updateRunHeartbeat(req.runId, `awaiting human confirmation (${req.kind})`, req.turnNumber ?? 0);
      } catch { /* non-fatal */ }
    }

    const cur = getPendingConfirmation(row.id);
    if (!cur) {
      // Row vanished (manual delete) → treat as deny, never as pass.
      return { approved: false, status: 'denied', confirmationId: row.id, resolvedBy: null };
    }
    if (cur.status === 'approved') {
      logHive('ssh_confirm_resolved', `pending-confirmation: APPROVED ${req.kind}`, req.agentId ?? undefined,
        { confirmationId: row.id, status: 'approved', resolvedBy: cur.resolved_by });
      return { approved: true, status: 'approved', confirmationId: row.id, resolvedBy: cur.resolved_by };
    }
    if (cur.status === 'denied' || cur.status === 'expired') {
      logHive('ssh_confirm_resolved', `pending-confirmation: ${cur.status.toUpperCase()} ${req.kind}`, req.agentId ?? undefined,
        { confirmationId: row.id, status: cur.status, resolvedBy: cur.resolved_by });
      return { approved: false, status: cur.status as 'denied' | 'expired', confirmationId: row.id, resolvedBy: cur.resolved_by };
    }
    // still pending → keep waiting
  }

  // Hard timeout → fail-closed deny. resolve() is race-safe (only if still pending).
  try { resolvePendingConfirmation(row.id, 'denied', 'system:timeout'); } catch { /* already resolved */ }
  logHive('ssh_confirm_resolved', `pending-confirmation: TIMEOUT→deny ${req.kind}`, req.agentId ?? undefined,
    { confirmationId: row.id, status: 'expired' });
  return { approved: false, status: 'expired', confirmationId: row.id, resolvedBy: null };
}
