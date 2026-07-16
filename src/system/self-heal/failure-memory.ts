// Self-heal: failure-memory — the LEARN store (Hermes core).
//
// Source of truth = the `self_heal_memory` SQLite table (atomic upsert-by-
// signature, hit-count/demote state machine). A human-readable copy is mirrored
// into the vault on each NEWLY-verified learn, as an audit trail only (ASAGI Q1).
//
// Hard invariants (ASAGI blocking #5, #6):
//   • 'recoverable'-class failures are NEVER recorded (backoff ≠ learned fix).
//   • phases in config.selfHeal.neverLearnPhases (vcs, …) are NEVER learned —
//     they may be OBSERVED for telemetry but can never produce a verified_fix.
//   • Verify GATES Learn: verified_fix is set only when Verify re-confirms the
//     original symptom is gone (recordVerify(passed=true)).

import { getDb } from '../../db';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { writeVaultNoteTool } from '../../memory/memory-tools';
import { FailureEvent, isRecoverable } from './failure-event';

export interface HealMemoryRow {
  signature:       string;
  phase:           string;
  error_class:     string;
  module_ident:    string | null;
  sample_msg:      string | null;
  observations:    number;
  verify_pass:     number;
  verify_fail:     number;
  verify_sessions: string;          // JSON array of distinct session/run ids that verified this fix
  verified_fix:    string | null;
  status:          'observing' | 'learned' | 'demoted';
  first_seen:      string;
  last_seen:       string;
  last_verified:   string | null;
}

const MAX_SESSIONS_STORED = 10;

function parseDistinctSessions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
  } catch { /* malformed JSON — treat as empty */ }
  return [];
}

function addDistinctSession(raw: string | null | undefined, sessionId: string): string {
  const sessions = new Set(parseDistinctSessions(raw));
  sessions.add(sessionId);
  return JSON.stringify([...sessions].slice(-MAX_SESSIONS_STORED));
}

/** True when this phase may never produce a trusted, auto-injectable fix. */
export function isNeverLearnPhase(phase: string): boolean {
  return config.selfHeal.neverLearnPhases.includes(phase.toLowerCase());
}

/**
 * Record one observation of a failure. Returns the current row, or null when the
 * event is deliberately not persisted (recoverable transient — pure noise).
 */
export function recordObservation(ev: FailureEvent): HealMemoryRow | null {
  if (!config.selfHeal.enabled) return null;
  // #6 — transient/recoverable never enters memory.
  if (isRecoverable(ev.raw ?? ev.message)) return null;

  const db = getDb();
  db.prepare(
    `INSERT INTO self_heal_memory (signature, phase, error_class, module_ident, sample_msg, observations, last_seen)
     VALUES (?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(signature) DO UPDATE SET
       observations = observations + 1,
       last_seen    = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       sample_msg   = COALESCE(self_heal_memory.sample_msg, excluded.sample_msg)`,
  ).run(ev.signature, ev.phase, ev.errorClass, ev.moduleIdent, ev.message);

  return lookup(ev.signature);
}

export function lookup(signature: string): HealMemoryRow | null {
  return (getDb()
    .prepare('SELECT * FROM self_heal_memory WHERE signature = ?')
    .get(signature) as HealMemoryRow | undefined) ?? null;
}

export interface TrustedFix {
  /** The stored guidance, if any. */
  fix:     string | null;
  /**
   * 'trusted' → confidence gate passed, safe to inject directly.
   * 'prior'   → a fix exists but below the gate: feed as CONTEXT to a fresh
   *             diagnosis pass, never blind-inject (ASAGI §3 / blocking #4).
   * 'none'    → nothing learned for this signature.
   */
  kind:    'trusted' | 'prior' | 'none';
  row:     HealMemoryRow | null;
}

/**
 * Confidence-gated fix lookup. A stored fix is blind-trusted only when it is
 * 'learned', has hit trustHitCount verified passes from DISTINCT sessions, and
 * has NEVER failed verify. Below that bar the fix is returned as a 'prior'.
 * never-learn phases can never be 'trusted'.
 */
export function getFix(ev: FailureEvent): TrustedFix {
  const row = lookup(ev.signature);
  if (!row || !row.verified_fix) return { fix: null, kind: 'none', row };

  const gate = config.selfHeal.trustHitCount;
  const clean = row.verify_fail === 0;
  const distinctSessions = parseDistinctSessions(row.verify_sessions).length;
  const trusted =
    row.status === 'learned' &&
    !isNeverLearnPhase(row.phase) &&
    row.verify_pass >= gate &&
    distinctSessions >= gate &&
    clean;

  return { fix: row.verified_fix, kind: trusted ? 'trusted' : 'prior', row };
}

/**
 * Verify-gated Learn. Call AFTER Verify has run on a repair.
 *   passed=true  → the fix held: record verified_fix + promote to 'learned',
 *                  and (on the FIRST time it becomes learned) mirror to vault.
 *   passed=false → the fix did not hold: bump verify_fail and DEMOTE a
 *                  previously-learned entry so a bad fix stops being trusted.
 *
 * never-learn phases accrue verify counts for telemetry but never get a
 * verified_fix / 'learned' status (footgun immunity).
 */
export async function recordVerify(
  ev: FailureEvent,
  passed: boolean,
  fix: string | null,
): Promise<void> {
  if (!config.selfHeal.enabled || !config.selfHeal.learnEnabled) return;
  const db = getDb();
  const before = lookup(ev.signature);
  if (!before) return; // must have been observed first

  if (passed) {
    const sessionId = ev.runId ?? ev.taskId ?? '_ambient';
    const verifySessions = addDistinctSession(before.verify_sessions, sessionId);

    if (isNeverLearnPhase(ev.phase)) {
      db.prepare(
        `UPDATE self_heal_memory SET verify_pass = verify_pass + 1,
           verify_sessions = ?,
           last_verified = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE signature = ?`,
      ).run(verifySessions, ev.signature);
      logger.info('self-heal: verify pass on never-learn phase — NOT persisting fix', {
        signature: ev.signature, phase: ev.phase,
      });
      return;
    }
    db.prepare(
      `UPDATE self_heal_memory SET
         verify_pass   = verify_pass + 1,
         verify_sessions = ?,
         verified_fix  = COALESCE(?, verified_fix),
         status        = 'learned',
         last_verified = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE signature = ?`,
    ).run(verifySessions, fix, ev.signature);

    // Mirror to vault only on the FIRST transition into 'learned'.
    if (before.status !== 'learned') {
      void mirrorLearnToVault(ev, fix);
    }
  } else {
    db.prepare(
      `UPDATE self_heal_memory SET
         verify_fail = verify_fail + 1,
         status      = CASE WHEN status = 'learned' THEN 'demoted' ELSE status END
       WHERE signature = ?`,
    ).run(ev.signature);
    if (before.status === 'learned') {
      logger.warn('self-heal: learned fix failed verify — DEMOTED', {
        signature: ev.signature, phase: ev.phase,
      });
    }
  }
}

async function mirrorLearnToVault(ev: FailureEvent, fix: string | null): Promise<void> {
  try {
    await writeVaultNoteTool({
      title:   `self-heal: ${ev.errorClass} in ${ev.moduleIdent}`,
      type:    'procedural',
      summary: `Verified fix learned for ${ev.phase}-phase failure "${ev.message.slice(0, 120)}".`,
      content: `**Signature:** \`${ev.signature}\`\n**Phase:** ${ev.phase}\n**Error class:** ${ev.errorClass}\n**Module:** ${ev.moduleIdent}\n\n**Verified fix guidance:**\n${fix ?? '(none recorded)'}`,
      tags:    ['self-heal', 'procedural', ev.phase, ev.errorClass],
      importance: 0.75,
      source:  'self-heal',
    });
  } catch (err) {
    logger.warn('self-heal: vault mirror failed (non-fatal)', { error: (err as Error).message });
  }
}

/** Telemetry snapshot for the autonomous report / dashboard. */
export function healMemoryStats(): { total: number; learned: number; observing: number; demoted: number } {
  const db = getDb();
  const row = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status='learned'   THEN 1 ELSE 0 END) AS learned,
       SUM(CASE WHEN status='observing' THEN 1 ELSE 0 END) AS observing,
       SUM(CASE WHEN status='demoted'   THEN 1 ELSE 0 END) AS demoted
     FROM self_heal_memory`,
  ).get() as { total: number; learned: number; observing: number; demoted: number };
  return {
    total:     row.total ?? 0,
    learned:   row.learned ?? 0,
    observing: row.observing ?? 0,
    demoted:   row.demoted ?? 0,
  };
}

export interface HealCandidateFix {
  signature:        string;
  phase:            string;
  error_class:      string;
  module_ident:     string | null;
  verify_pass:      number;
  verify_fail:      number;
  distinct_sessions: number;
  status:           string;
  first_seen:       string;
  last_seen:        string;
  verified_fix:     string;
}

/** Read-only telemetry: every stored fix a human can review before arming injection. */
export function candidateFixes(): HealCandidateFix[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT signature, phase, error_class, module_ident, verify_pass, verify_fail,
            verify_sessions, status, first_seen, last_seen, verified_fix
     FROM self_heal_memory
     WHERE verified_fix IS NOT NULL
     ORDER BY last_verified DESC`
  ).all() as HealMemoryRow[];
  return rows.map((r) => ({
    signature:         r.signature,
    phase:             r.phase,
    error_class:       r.error_class,
    module_ident:      r.module_ident,
    verify_pass:       r.verify_pass,
    verify_fail:       r.verify_fail,
    distinct_sessions: parseDistinctSessions(r.verify_sessions).length,
    status:            r.status,
    first_seen:        r.first_seen,
    last_seen:         r.last_seen,
    verified_fix:      r.verified_fix ?? '',
  }));
}
