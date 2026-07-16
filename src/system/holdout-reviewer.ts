// Holdout reviewer — the task-board's review→done gate.
//
// This is now a thin ADAPTER: it builds a ReviewInput from an AppTask and hands
// it to the in-process tiered review-service (pre-gate → Tier-1 → Tier-2). It is
// the ONLY task-board entry point into review; task-manager calls this and
// nothing else calls the service in v1.

import { execFileSync } from 'child_process';
import type { AppTask } from './task-manager';
import { AggregateVerdict } from './review-types';
import { reviewInput } from './review-service';
import { getDb } from '../db';
import { logger } from '../utils/logger';
import { RECONCILE_RE, textReadsAsReview } from './task-classification';

const MAX_ARTIFACT_CHARS = 6000;

// ── Deterministic git-reconcile gate ──────────────────────────────────────────
// A task that claims to reconcile the git tree / merge worktrees CANNOT pass
// review→done if `main` was never touched. This is the durable fix for the
// "false-done" pattern where Keeper (Shorekeeper) marked a reconcile task done
// while main's HEAD sat unchanged and every branch stayed unmerged.
//
// The whole review pipeline is fail-OPEN; this single gate is deliberately the
// exception — it is a cheaply, deterministically verifiable claim, so it is
// fail-CLOSED on a positive detection and fail-OPEN only on tooling error.
// The RECONCILE_RE / review-marker regexes live in ./task-classification — the
// SINGLE source of truth shared with task-manager.createTask (which now stores
// verification_mode at creation), so the two paths can never drift.

function isReconcileTask(task: AppTask): boolean {
  const text = `${task.title} ${task.description ?? ''}`;
  return RECONCILE_RE.test(text);
}

/** main's HEAD commit timestamp (ISO) + short SHA, or null if git is unreadable. */
function mainHead(): { iso: string; sha: string } | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', 'main'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', 'main'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
    return iso && sha ? { iso, sha } : null;
  } catch {
    return null;
  }
}

/** Returns a BLOCKING verdict if a reconcile/merge task is being marked complete
 *  while main's HEAD predates the task's creation (i.e. main was never touched).
 *  Returns null to proceed to the normal review path. */
function verifyReconcileClaim(task: AppTask): AggregateVerdict | null {
  if (!isReconcileTask(task)) return null;

  // A review-only task is *supposed* to leave main untouched. The dispatcher
  // sets verification_mode='review' at creation; this bypasses the HEAD-moved
  // assertion while keeping all other integrity checks.
  if (task.verification_mode === 'review') {
    logger.info('holdout: reconcile regex matched but verification_mode=review — skipping HEAD-moved gate', {
      taskId: task.id,
    });
    return null;
  }

  // Current-text authority (ASAGI v2): if the task's CURRENT title/description
  // reads as a review/audit/gate, bypass — regardless of the stored mode. A task
  // auto-classified 'reconcile' at creation but later retitled to review-only
  // must still be honored as a review (the stored mode is a stale creation-time
  // guess; the current reading wins). This restores full parity with the pre-
  // populate hotfix and keeps the design strictly monotonic — it can only RELAX
  // the gate, never deadlock. An explicit dispatcher 'reconcile' whose text does
  // NOT read as review still fail-closes below.
  if (textReadsAsReview(task.title, task.description)) {
    logger.info('holdout: reconcile regex matched but current text reads as review — skipping HEAD-moved gate', {
      taskId: task.id, title: task.title, storedMode: task.verification_mode ?? null,
    });
    return null;
  }

  // Fail-closed: explicit 'reconcile' mode, or an untagged task whose title reads
  // as an actual merge, still asserts main HEAD advanced during the task's life.
  const head = mainHead();
  if (!head) return null; // can't verify → don't block (fail-open on tooling error)
  const createdAt = Date.parse(task.created_at);
  const mainAt = Date.parse(head.iso);
  if (!Number.isFinite(createdAt) || !Number.isFinite(mainAt)) return null;
  if (mainAt >= createdAt) return null; // main advanced during the task's life → legit

  const feedback =
    `Reconcile/merge verification FAILED (deterministic gate): main HEAD ${head.sha} ` +
    `(committed ${head.iso}) predates this task's creation (${task.created_at}). ` +
    `main was never touched, so no merge or reconciliation actually landed. ` +
    `Either (a) perform the merges and re-submit for review, or (b) if there was ` +
    `genuinely nothing to merge, say so explicitly in the output and note that main ` +
    `was intentionally left unchanged — do not report a reconcile as complete when ` +
    `the tree is unchanged.`;
  logger.warn('holdout: reconcile gate BLOCKED review→done (main untouched)', {
    taskId: task.id, mainSha: head.sha, mainAt: head.iso, createdAt: task.created_at,
  });
  const issue = {
    location: `git main @ ${head.sha}`,
    problem:  'Reconcile/merge task marked complete while main HEAD is unchanged since task creation — no merge actually landed.',
    fix:      'Perform the merges (or explicitly report there was nothing to merge and that main was left unchanged), then re-submit for review.',
    severity: 'high' as const,
  };
  return {
    passed:   false,
    verdicts: [{ reviewer: 'tier1', passed: false, severity: 'high', issues: [issue], summary: 'deterministic reconcile gate: main HEAD unchanged since task creation' }],
    blocking: [issue],
    feedback,
  };
}

function buildArtifact(task: AppTask): string {
  // Prefer the task's own recorded output — it is the literal produced artifact
  // (set on the review transition). Reading the session's last assistant
  // messages is a fallback that is WRONG for subtasks, whose session_id is the
  // PARENT session: it would grade the parent agent's chatter, not the subtask's
  // result. task.output is correct for both agent_tasks and subtasks.
  if (task.output && task.output.trim()) {
    return task.output.length > MAX_ARTIFACT_CHARS
      ? task.output.slice(-MAX_ARTIFACT_CHARS)
      : task.output;
  }
  if (!task.session_id) return '(no session output available — fail-open)';
  const rows = getDb()
    .prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 3"
    )
    .all(task.session_id) as { content: string }[];
  if (rows.length === 0) return '(no agent output found — fail-open)';
  const combined = rows.reverse().map(r => r.content).join('\n\n---\n\n');
  return combined.length > MAX_ARTIFACT_CHARS
    ? combined.slice(-MAX_ARTIFACT_CHARS)
    : combined;
}

export async function runHoldoutReview(task: AppTask): Promise<AggregateVerdict> {
  // Deterministic pre-gate: block a reconcile/merge "done" when main is untouched.
  const reconcileBlock = verifyReconcileClaim(task);
  if (reconcileBlock) return reconcileBlock;

  const artifact = buildArtifact(task);
  try {
    // Task-board tasks carry no diff (see review-service §diff-acquisition) — the
    // artifact is a narrative summary, so this routes through the prose path.
    return await reviewInput({
      request:       `${task.title}\n${task.description ?? ''}`,
      artifact,
      artifactKind:  'unknown',
      priorFeedback: task.reviewer_feedback ?? undefined,
      taskType:      (task as { type?: string }).type,
    });
  } catch (err) {
    // reviewInput never throws, but keep a fail-open backstop.
    logger.warn('holdout: review-service threw (fail-open)', { taskId: task.id, error: (err as Error).message });
    return {
      passed:   true,
      verdicts: [{ reviewer: 'tier1', passed: true, severity: 'none', issues: [], summary: 'review-service error (fail-open)' }],
      blocking: [],
      feedback: '',
    };
  }
}
