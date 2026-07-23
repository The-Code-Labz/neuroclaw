import { randomUUID } from 'crypto';
import { getDb, logAudit, getAllAgents, getDefaultProject, bumpFailureCount, getAgentById, deactivateAgent, enqueueJob, unmetBlockerCount, addTaskDependency } from '../db';
import { classifyRoute } from './router';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { runHoldoutReview } from './holdout-reviewer';
import { onReviewFailed, onReviewPassed } from './self-heal/heal-loop';
import { classifyVerificationMode } from './task-classification';

export type TaskStatus    = 'todo' | 'doing' | 'review' | 'done' | 'failed' | 'blocked' | 'cancelled';
/** Canonical task status set — mirrors the tasks.status CHECK constraint in db.ts.
 *  Single source of truth for runtime validation (API + tools). */
export const TASK_STATUSES: readonly string[] = ['todo', 'doing', 'review', 'done', 'failed', 'blocked', 'cancelled'];
export type PriorityLevel = 'low' | 'medium' | 'high' | 'critical';
export type TaskVerificationMode = 'reconcile' | 'review';

export interface AppTask {
  id:             string;
  title:          string;
  description:    string | null;
  status:         TaskStatus;
  priority:       number;            // legacy 0-100 score (kept one release)
  priority_level: PriorityLevel;     // Archon-style enum (drives the new UI)
  session_id:     string | null;
  agent_id:       string | null;
  // Archon-port additions (v1.9). Strings for JSON columns to match the
  // SQLite shape; callers JSON.parse when they actually need structured form.
  project_id:     string | null;
  parent_task_id: string | null;
  assignee:       string;            // free text — accepts agents, humans, "User", "AI IDE Agent"
  task_order:     number;            // drag-reorder position within (status) column
  feature:        string | null;
  sources:        string;             // JSON array
  code_examples:  string;             // JSON array
  archived:       number;             // 0/1
  archived_at:    string | null;
  archived_by:    string | null;
  output:            string | null;
  failure_count:     number;
  last_error:        string | null;
  reviewer_feedback: string;
  max_retries:       number;
  task_source:       string;           // 'dashboard' | 'subtask' | 'background'
  archon_task_id:    string | null;    // legacy cross-reference column (unused; retained for schema compat)
  verification_mode: TaskVerificationMode | null; // 'reconcile' | 'review' — set at creation by dispatcher
  created_at:        string;
  updated_at:        string;
}

/**
 * Auto-assigns a task to the best agent via the LLM classifier.
 * Falls back silently if routing is disabled or classification fails.
 */
async function autoAssign(title: string, description?: string): Promise<string | undefined> {
  const candidates = getAllAgents().filter(a => a.status === 'active' && a.name !== 'Alfred');
  if (candidates.length === 0) return undefined;

  const query = description ? `${title}: ${description}` : title;
  const decision = await classifyRoute(query, candidates);
  if (!decision) return undefined;

  logHive('task_created', `task-mgr: Task "${title}" auto-assigned to ${decision.agent.name} (${Math.round(decision.confidence * 100)}%) — ${decision.reason}`, decision.agent.id, { title, confidence: decision.confidence });
  logger.info('task-mgr: auto-assigned', { title, agent: decision.agent.name, confidence: decision.confidence });
  return decision.agent.id;
}

export interface CreateTaskOptions {
  description?:     string;
  sessionId?:       string;
  agentId?:         string;
  priority?:        number;            // legacy 0-100; mapped → priority_level if level not given
  priority_level?:  PriorityLevel;
  project_id?:      string;            // omit → default NeuroClaw project
  parent_task_id?:  string;
  assignee?:        string;            // free text; defaults to "User"
  task_order?:      number;
  feature?:         string;
  sources?:         unknown;           // JSON-serialized into `sources`
  code_examples?:   unknown;           // JSON-serialized into `code_examples`
  task_source?:     string;            // 'dashboard' | 'archon' | 'subtask' | 'background'
  archon_task_id?:  string;            // cross-reference to Archon/Supabase task ID
  verification_mode?: TaskVerificationMode; // dispatcher-only: 'reconcile' asserts main moved, 'review' bypasses
  status?:          TaskStatus;        // initial status (defaults to 'todo')
  dependsOn?:       string[];          // Wave-2 Item D: blocker task ids (must be 'done' before this can be claimed)
  routine_key?:     string;            // Wave-2 Item E: routine coalescing key (routine-spawned tasks only)
}

function priorityLevelFor(score: number, override?: PriorityLevel): PriorityLevel {
  if (override) return override;
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

export async function createTask(
  title:    string,
  optsOrDescription?: CreateTaskOptions | string,
  legacySessionId?:   string,
  legacyAgentId?:     string,
  legacyPriority = 50,
): Promise<AppTask> {
  // Backward-compatible signature: createTask(title, "desc", sessionId, agentId, 75)
  // still works; new callers pass an options object instead.
  const opts: CreateTaskOptions = typeof optsOrDescription === 'string'
    ? { description: optsOrDescription, sessionId: legacySessionId, agentId: legacyAgentId, priority: legacyPriority }
    : (optsOrDescription ?? {});

  const priority      = opts.priority ?? 50;
  const priorityLevel = priorityLevelFor(priority, opts.priority_level);
  const resolvedAgentId = opts.agentId ?? await autoAssign(title, opts.description);
  const projectId       = opts.project_id ?? getDefaultProject().id;

  // L1 — attribution sync at source. Precedence:
  //   1. explicit caller-provided assignee (respects non-agent owners like "AI IDE Agent")
  //   2. resolved agent's name (the real doer) — keeps card/table/monitors in agreement
  //   3. "User" only when genuinely unassigned
  const explicitAssignee = opts.assignee?.trim();
  const resolvedAssignee = explicitAssignee
    || (resolvedAgentId ? (getAgentById(resolvedAgentId)?.name ?? 'User') : 'User');

  // Durable reconcile-gate discriminator. Precedence:
  //   1. explicit dispatcher-provided verification_mode wins
  //   2. else auto-classify from title+description (shared classifier — identical
  //      logic to the review-time path, so the two can never drift)
  //   3. classifier returns null for non-gate tasks → stored as null (unchanged)
  // This makes verification_mode a real, populated, auditable column instead of a
  // field nothing ever wrote. Frozen at creation (the update path strips it).
  const resolvedVerificationMode =
    opts.verification_mode ?? classifyVerificationMode(title, opts.description);

  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO tasks (
      id, title, description, session_id, agent_id, priority,
      project_id, parent_task_id, assignee, task_order, feature,
      sources, code_examples, priority_level, status, task_source, archon_task_id,
      verification_mode, routine_key, doing_since
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title,
    opts.description ?? null,
    opts.sessionId ?? null,
    resolvedAgentId ?? null,
    priority,
    projectId,
    opts.parent_task_id ?? null,
    resolvedAssignee,
    opts.task_order ?? 0,
    opts.feature ?? null,
    JSON.stringify(opts.sources       ?? []),
    JSON.stringify(opts.code_examples ?? []),
    priorityLevel,
    opts.status ?? 'todo',
    opts.task_source ?? 'dashboard',
    opts.archon_task_id ?? null,
    resolvedVerificationMode,
    opts.routine_key ?? null,
    // Wave-2 Item C4 (ASAGI MAJOR): a task that starts life already in 'doing'
    // (e.g. background_agent createTask) must carry a start-stamp or it is
    // permanently invisible to Sentinel's runaway pass (which requires
    // doing_since IS NOT NULL). Stamp on the doing edge only.
    (opts.status ?? 'todo') === 'doing' ? Date.now() : null,
  );
  // Wave-2 Item D: register blocker edges. addTaskDependency guards self-edges,
  // cycles, and unknown ids — a bad blocker id is logged-and-skipped, not fatal.
  if (opts.dependsOn?.length) {
    for (const blockerId of opts.dependsOn) {
      const r = addTaskDependency(id, blockerId);
      if (!r.ok) logger.warn('task-mgr: dependency edge skipped on create', { taskId: id, blockerId, error: r.error });
    }
  }
  logAudit('task_created', 'task', id, { title, agentId: resolvedAgentId, projectId });
  // Traceability: record when the gate discriminator was auto-derived (vs. an
  // explicit dispatcher override or a non-gate null).
  if (opts.verification_mode == null && resolvedVerificationMode != null) {
    logAudit('task_verification_mode_autoset', 'task', id, { title, mode: resolvedVerificationMode });
  }
  if (!opts.agentId && resolvedAgentId) {
    logHive('task_created', `task-mgr: Task "${title}" created and auto-assigned`, resolvedAgentId, { taskId: id });
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as AppTask;
}

export function updateTask(
  id: string,
  fields: {
    status?:          TaskStatus;
    agent_id?:        string | null;
    session_id?:      string | null;
    title?:           string;
    description?:     string;
    priority?:        number;
    priority_level?:  PriorityLevel;
    project_id?:      string | null;
    parent_task_id?:  string | null;
    assignee?:        string;
    task_order?:      number;
    feature?:         string | null;
    sources?:         unknown;
    code_examples?:   unknown;
    archived?:        boolean;
    archived_by?:     string | null;
    failure_count?:      number;
    last_error?:         string | null;
    output?:             string | null;
    reviewer_feedback?:  string;
    max_retries?:        number;
    archon_task_id?:     string | null;
  },
): void {
  // Wave-2 Item D (ASAGI FATAL fix): the claim-SQL gate alone is NOT airtight —
  // manage_task(update, status='doing') calls here directly, bypassing the claim
  // path. So the SAME unmet-blocker check MUST gate the transition-to-'doing'
  // here too, or Item D is decorative. Strip only the illegal status flip; keep
  // any other field edits in the same call.
  if (fields.status === 'doing') {
    const unmet = unmetBlockerCount(id);
    if (unmet > 0) {
      logger.warn('task-mgr: refused doing-transition — task has unmet blockers', { taskId: id, unmetBlockers: unmet });
      logAudit('task_doing_blocked_by_deps', 'task', id, { unmetBlockers: unmet });
      fields = { ...fields, status: undefined };
    }
  }

  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"];
  const params: unknown[] = [];

  if (fields.status         !== undefined) { sets.push('status = ?');         params.push(fields.status); }
  if (fields.agent_id       !== undefined) { sets.push('agent_id = ?');       params.push(fields.agent_id); }
  if (fields.session_id     !== undefined) { sets.push('session_id = ?');     params.push(fields.session_id); }
  if (fields.title          !== undefined) { sets.push('title = ?');          params.push(fields.title); }
  if (fields.description    !== undefined) { sets.push('description = ?');    params.push(fields.description); }
  if (fields.priority       !== undefined) { sets.push('priority = ?');       params.push(fields.priority); }
  if (fields.priority_level !== undefined) { sets.push('priority_level = ?'); params.push(fields.priority_level); }
  if (fields.project_id     !== undefined) { sets.push('project_id = ?');     params.push(fields.project_id); }
  if (fields.parent_task_id !== undefined) { sets.push('parent_task_id = ?'); params.push(fields.parent_task_id); }
  if (fields.assignee       !== undefined) { sets.push('assignee = ?');       params.push(fields.assignee.trim() || 'User'); }
  if (fields.task_order     !== undefined) { sets.push('task_order = ?');     params.push(fields.task_order); }
  if (fields.feature        !== undefined) { sets.push('feature = ?');        params.push(fields.feature); }
  if (fields.sources        !== undefined) { sets.push('sources = ?');        params.push(JSON.stringify(fields.sources)); }
  if (fields.code_examples  !== undefined) { sets.push('code_examples = ?');  params.push(JSON.stringify(fields.code_examples)); }
  if (fields.archived       !== undefined) {
    sets.push('archived = ?');    params.push(fields.archived ? 1 : 0);
    sets.push('archived_at = ?'); params.push(fields.archived ? new Date().toISOString() : null);
  }
  if (fields.archived_by    !== undefined) { sets.push('archived_by = ?');    params.push(fields.archived_by); }
  if (fields.failure_count  !== undefined) { sets.push('failure_count = ?');  params.push(fields.failure_count); }
  if (fields.last_error     !== undefined) { sets.push('last_error = ?');     params.push(fields.last_error); }
  if (fields.output            !== undefined) { sets.push('output = ?');            params.push(fields.output); }
  if (fields.reviewer_feedback !== undefined) { sets.push('reviewer_feedback = ?'); params.push(fields.reviewer_feedback); }
  if (fields.max_retries       !== undefined) { sets.push('max_retries = ?');       params.push(fields.max_retries); }
  if (fields.archon_task_id    !== undefined) { sets.push('archon_task_id = ?');    params.push(fields.archon_task_id); }
  // Reset the retry budget when a task is verified done, so a later re-open or a
  // watchdog stuck-event on the same row starts from a clean count (M1).
  if (fields.status === 'done' && fields.failure_count === undefined) {
    sets.push('failure_count = ?'); params.push(0);
  }
  // Wave-2 Item C4: maintain the runaway start-stamp on status transitions.
  //   → 'doing': stamp ONLY on the null→value edge (COALESCE keeps an existing
  //     start time, so a re-entrant update while already 'doing' can NOT reset
  //     the clock and let a runaway escape).
  //   → any other status: clear it, so a later retry re-stamps fresh.
  // (The claim path stamps unconditionally; this covers the manage_task
  //  update(status='doing') path and every exit transition.)
  if (fields.status === 'doing') {
    sets.push('doing_since = COALESCE(doing_since, ?)'); params.push(Date.now());
  } else if (fields.status !== undefined) {
    sets.push('doing_since = ?'); params.push(null);
  }

  if (sets.length === 1) return;
  params.push(id);
  getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logAudit('task_updated', 'task', id, fields);
  if (fields.status) {
    logHive('task_updated', `task-mgr: Task status → ${fields.status}`, undefined, { taskId: id, status: fields.status });
  }

  if (fields.status === 'review') {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as AppTask;
    setImmediate(() => void applyHoldoutVerdict(id, task));
  }
}

/** Deactivate a temporary agent once its task reaches a terminal state and it
 *  has no other open work. The job-worker already does this on the permanent-
 *  FAIL path, but a SUCCESS that routes through review→done previously left the
 *  temp agent active until its 6h TTL, holding a spawn-limit slot. */
function deactivateIdleTempAgent(agentId: string | null, exceptTaskId: string): void {
  if (!agentId) return;
  if (getAgentById(agentId)?.temporary !== 1) return;
  const open = (getDb().prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('todo','doing','review') AND id != ?`,
  ).get(agentId, exceptTaskId) as { n: number }).n;
  if (open === 0) {
    deactivateAgent(agentId);
    logHive('agent_deactivated', 'temp agent deactivated after task reached terminal state', agentId, { taskId: exceptTaskId });
  }
}

/** Tasks whose holdout verdict is currently being computed (reentrancy guard). */
const inFlightHoldout = new Set<string>();

async function applyHoldoutVerdict(id: string, task: AppTask): Promise<void> {
  // Reentrancy guard: the 5-min recoverStuckReviewTasks sweep can re-fire this
  // for a task still in 'review'; without it, two passes race failure_count /
  // status writes on the same row. In-process only — a restart clears it, which
  // is correct because the boot sweep re-drives anything genuinely stranded.
  if (inFlightHoldout.has(id)) {
    logger.info('task-mgr: holdout verdict already in flight — skipping duplicate', { taskId: id });
    return;
  }
  inFlightHoldout.add(id);
  try {
  let verdict;
  try {
    verdict = await runHoldoutReview(task);
  } catch (err) {
    logger.warn('task-mgr: holdout-reviewer unexpected error (fail-open)', { taskId: id, err: String(err) });
    updateTask(id, { status: 'done' });
    deactivateIdleTempAgent(task.agent_id, id);
    return;
  }

  if (verdict.passed) {
    // Self-heal LEARN: if this task carried a prior critique, the re-review just
    // verified (function-level) that the fix held — credit it. Shadow-safe:
    // observe/learn only, never alters control flow.
    onReviewPassed({
      taskId:        id,
      title:         task.title,
      priorFeedback: task.reviewer_feedback,
      runId:         task.session_id ?? undefined,
    });
    updateTask(id, { status: 'done' });
    deactivateIdleTempAgent(task.agent_id, id);
    return;
  }

  // Self-heal OBSERVE + STORM. In shadow mode this only records + logs; the
  // returned decision cannot alter behavior (suppress=false, injectFix=null).
  const heal = onReviewFailed({
    taskId:      id,
    title:       task.title,
    description: task.description ?? undefined,
    feedback:    verdict.feedback,
    runId:       task.session_id ?? undefined,
  });

  const maxRetries = task.max_retries ?? 3;
  // `task` is a snapshot captured before the multi-second review LLM call — read
  // failure_count fresh so a concurrent bump isn't lost, and increment atomically.
  const cur = (getDb().prepare('SELECT failure_count FROM tasks WHERE id = ?')
    .get(id) as { failure_count: number } | undefined)?.failure_count ?? task.failure_count;

  // Live-mode storm breaker: a systemic signature (same failure ≥ threshold this
  // run) is parked as `blocked` (not `failed`) so a human sees the systemic
  // blocker instead of it being silently auto-archived as a failure.
  // In shadow mode heal.suppress is always false, so this is inert.
  if (heal.suppress) {
    updateTask(id, { status: 'blocked', last_error: `[self-heal: systemic signature ${heal.signature}] ${verdict.feedback}` });
    deactivateIdleTempAgent(task.agent_id, id);
    return;
  }

  if (cur < maxRetries) {
    bumpFailureCount(id);
    // Live-mode only: fold a confidence-gated stored fix into the critique fed
    // back to the agent. In shadow mode heal.injectFix is null (no change).
    const feedbackOut = heal.injectFix
      ? `${verdict.feedback}\n\n---\nKNOWN FIX (self-heal, previously verified):\n${heal.injectFix}`
      : verdict.feedback;
    updateTask(id, {
      status:            'todo',
      reviewer_feedback: feedbackOut,
    });
    // Re-dispatch immediately. The job that produced this output already
    // completed (status was 'review'), so without this the bounced task strands
    // in 'todo' until the next reboot. enqueueJob dedups, so this is safe.
    if (task.agent_id) {
      const ag = getAgentById(task.agent_id);
      if (ag && ag.status === 'active') {
        enqueueJob('agent_task', {
          taskId:          id,
          agentId:         task.agent_id,
          agentName:       ag.name,
          taskTitle:       task.title,
          taskDescription: task.description ?? '',
        });
      }
    }
  } else {
    updateTask(id, {
      status:     'failed',
      last_error: verdict.feedback,
    });
    deactivateIdleTempAgent(task.agent_id, id);
  }
  } finally {
    inFlightHoldout.delete(id);
  }
}

/**
 * Recover tasks stranded in 'review'. The holdout verdict is fired via a
 * non-durable setImmediate (updateTask), so a process death between the
 * status='review' commit and the verdict write leaves the task in 'review'
 * with nothing to advance it — no other recovery sweep covers 'review'.
 *
 * At boot call with minAgeMs=0 (every review task is stranded — no setImmediate
 * survived the restart). For the periodic sweep pass an age threshold so a
 * freshly-set review whose verdict is still pending in-process isn't double-fired.
 * Re-firing applyHoldoutVerdict re-grades the existing output and advances the
 * task to done/todo/failed, preserving the completed work.
 */
export function recoverStuckReviewTasks(minAgeMs = 0): number {
  const cutoff = new Date(Date.now() - minAgeMs).toISOString();
  const rows = getDb().prepare(
    `SELECT * FROM tasks WHERE status = 'review' AND archived = 0 AND updated_at < ?`,
  ).all(cutoff) as AppTask[];
  for (const task of rows) {
    logger.warn('task-mgr: recovering stranded review task — re-firing holdout verdict', { taskId: task.id });
    setImmediate(() => void applyHoldoutVerdict(task.id, task));
  }
  return rows.length;
}

/**
 * Marker for the reviewer fail-closed bug (fixed in review-service `assertGradable`).
 *
 * When the reviewer returned ungradable output, `safeParse` yielded `{}`, so
 * `obj.passed === true` evaluated FALSE — producing a *failing* verdict that
 * listed ZERO blocking issues. That renders as `### tier1 (none)` in the
 * feedback. Repeated `maxRetries` times it produced an identical failure
 * signature, tripping the self-heal storm breaker, which parks the task at
 * `blocked` — a terminal state nothing ever retries.
 *
 * This selector is deliberately NARROW and POSITIVE. It matches only that
 * provably-safe class. It must never be widened to "all blocked tasks":
 *   - `deterministic gate` failures are REAL failures the reviewer fix does not
 *     address — requeuing them just re-fails them.
 *   - unmarked blocked rows have an unknown cause and are excluded by default.
 */
const SELF_HEAL_PARSE_BUG_MARKER = '%tier1 (none)%';

export interface RequeueBlockedResult {
  dryRun:   boolean;
  matched:  number;
  requeued: number;
  tasks:    Array<{ id: string; title: string; agent_id: string | null; failure_count: number }>;
}

/**
 * Recover tasks buried by the reviewer fail-closed bug: reset them to `todo`
 * and clear the failure counter so they are eligible to be worked again.
 *
 * Deliberately does NOT enqueue jobs. Setting status to `todo` returns the task
 * to the board, where the autonomous loop and `claim_next_task` pick it up at
 * their own pace — that natural drain IS the stagger. Dispatching N jobs here
 * would stampede the queue with the whole backlog at once.
 *
 * Defaults to a DRY RUN: callers must pass `dryRun: false` to mutate anything.
 * Running this before the `assertGradable` fix is deployed is pointless — the
 * requeued tasks would hit the same bug and be re-buried.
 */
export function requeueSelfHealBlockedTasks(
  opts: { dryRun?: boolean; limit?: number } = {},
): RequeueBlockedResult {
  const dryRun = opts.dryRun !== false;           // fail-safe: mutate only on explicit false
  const limit  = Number.isFinite(opts.limit) && (opts.limit as number) > 0
    ? Math.floor(opts.limit as number)
    : null;

  const db   = getDb();
  const rows = db.prepare(
    `SELECT id, title, agent_id, failure_count
       FROM tasks
      WHERE status = 'blocked'
        AND archived = 0
        AND last_error LIKE ?
      ORDER BY updated_at ASC
      ${limit ? 'LIMIT ?' : ''}`,
  ).all(...(limit ? [SELF_HEAL_PARSE_BUG_MARKER, limit] : [SELF_HEAL_PARSE_BUG_MARKER])) as
    Array<{ id: string; title: string; agent_id: string | null; failure_count: number }>;

  if (dryRun || rows.length === 0) {
    return { dryRun: true, matched: rows.length, requeued: 0, tasks: rows };
  }

  // Two mutations only: return to the board, and clear the counter so the task
  // gets a full retry budget instead of instantly re-tripping the breaker.
  // `last_error` is cleared so a stale marker can't re-match on a later sweep.
  const reset = db.prepare(
    `UPDATE tasks
        SET status = 'todo', failure_count = 0, last_error = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'blocked'`,
  );
  const runAll = db.transaction((ids: string[]) => {
    let n = 0;
    for (const id of ids) n += reset.run(id).changes;
    return n;
  });
  const requeued = runAll(rows.map(r => r.id));

  logger.warn('task-mgr: requeued self-heal-blocked tasks (reviewer fail-closed recovery)', {
    matched: rows.length, requeued,
  });
  return { dryRun: false, matched: rows.length, requeued, tasks: rows };
}

/**
 * List tasks. Defaults exclude archived rows (Archon-style soft delete).
 *   getTasks() — every active task across every project, status-grouped order
 *   getTasks('todo') — just one status
 *   getTasks(undefined, { project_id, include_archived }) — filtered listing
 */
export function getTasks(
  status?: TaskStatus,
  opts: { project_id?: string; include_archived?: boolean; parent_task_id?: string | null } = {},
): AppTask[] {
  const where: string[] = [];
  const args:  unknown[] = [];
  if (!opts.include_archived)         { where.push('archived = 0'); }
  if (status)                          { where.push('status = ?');           args.push(status); }
  if (opts.project_id)                 { where.push('project_id = ?');       args.push(opts.project_id); }
  if (opts.parent_task_id !== undefined) {
    if (opts.parent_task_id === null) where.push('parent_task_id IS NULL');
    else { where.push('parent_task_id = ?'); args.push(opts.parent_task_id); }
  }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY task_order ASC, priority DESC, created_at DESC`;
  return getDb().prepare(sql).all(...args) as AppTask[];
}

/** Soft-delete a task (Archon style). Sets archived=1, stamps archived_at,
 *  optionally records who archived it. The task still exists in the DB so it
 *  can be restored or referenced by historical audit log entries. */
export function archiveTask(id: string, archivedBy?: string | null): void {
  updateTask(id, { archived: true, archived_by: archivedBy ?? null });
  logHive('task_updated', `task-mgr: Task archived`, undefined, { taskId: id, archived: true });
}

/** Look up a single non-archived task by its local SQLite UUID. */
export function getTaskById(id: string): AppTask | null {
  return (getDb().prepare('SELECT * FROM tasks WHERE id = ? AND archived = 0').get(id) as AppTask) ?? null;
}

/** Look up a single non-archived task by its cross-reference archon_task_id. */
export function getTaskByArchonId(archonId: string): AppTask | null {
  return (getDb().prepare('SELECT * FROM tasks WHERE archon_task_id = ? AND archived = 0').get(archonId) as AppTask) ?? null;
}

/**
 * Build a compact goal-ancestry block for a task so the working agent sees the
 * *why* (Paperclip: "every task traces back to the mission"), not just a flat
 * title. Walks parent_task_id upward (hard depth cap 5 + cycle guard) and
 * resolves the owning project's title/description.
 *
 * Returns '' when the task has neither a parent nor a project — so flat tasks
 * add ZERO prompt noise and the dispatched user message stays byte-identical to
 * before. The caller places this on the volatile user message (never the stable
 * system prefix), so the prompt-cache stable-prefix split (WS1) is untouched.
 * Kill-switch: TASK_ANCESTRY_ENABLED=false.
 */
export function buildTaskAncestry(taskId: string): string {
  if (process.env.TASK_ANCESTRY_ENABLED === 'false') return '';
  const db = getDb();
  const trunc = (s: string): string => (s.length > 120 ? s.slice(0, 117) + '…' : s);

  const self = db.prepare('SELECT id, title, parent_task_id, project_id FROM tasks WHERE id = ?')
    .get(taskId) as { id: string; title: string; parent_task_id: string | null; project_id: string | null } | undefined;
  if (!self) return '';

  // Walk parent chain upward → [root … parent, self], depth-capped + cycle-guarded.
  const chain: string[] = [trunc(self.title)];
  const seen = new Set<string>([self.id]);
  let cursor = self.parent_task_id;
  let depth = 0;
  while (cursor && depth < 5) {
    if (seen.has(cursor)) break;               // cycle guard
    seen.add(cursor);
    const row = db.prepare('SELECT title, parent_task_id FROM tasks WHERE id = ?')
      .get(cursor) as { title: string; parent_task_id: string | null } | undefined;
    if (!row) break;
    chain.unshift(trunc(row.title));           // prepend → root ends up first
    cursor = row.parent_task_id;
    depth++;
  }

  // Owning project: title = name line, description = goal line (projects has NO
  // name/goal columns — confirmed schema uses title/description).
  // CRITICAL [ASAGI]: exclude the seeded default/catch-all project. Every task
  // without an explicit project is auto-assigned getDefaultProject() (the
  // "NeuroClaw" row, which HAS a description), so without this guard a genuinely
  // flat task would emit "Project: NeuroClaw — Default project…" — anti-signal
  // boilerplate on every dispatch. Only surface a REAL user-created project.
  let projectLine = '';
  if (self.project_id && self.project_id !== getDefaultProject().id) {
    const proj = db.prepare('SELECT title, description FROM projects WHERE id = ?')
      .get(self.project_id) as { title: string | null; description: string | null } | undefined;
    if (proj?.title) {
      projectLine = `Project: ${trunc(proj.title)}${proj.description ? ` — ${trunc(proj.description)}` : ''}`;
    }
  }

  const hasParent = chain.length > 1;
  if (!hasParent && !projectLine) return '';   // flat task → no ancestry, no noise

  const lines = ['<goal-context>'];
  if (projectLine) lines.push(projectLine);
  if (hasParent) lines.push(`Goal chain: ${chain.join(' → ')}`);
  lines.push('</goal-context>');
  return lines.join('\n');
}

// TODO [task queue workers]: When status → 'doing', push to BullMQ/Redis for async execution
