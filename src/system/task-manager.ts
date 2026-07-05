import { randomUUID } from 'crypto';
import { getDb, logAudit, getAllAgents, getDefaultProject, bumpFailureCount, getAgentById, deactivateAgent, enqueueJob } from '../db';
import { classifyRoute } from './router';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { runHoldoutReview } from './holdout-reviewer';

export type TaskStatus    = 'todo' | 'doing' | 'review' | 'done' | 'failed' | 'blocked' | 'cancelled';
/** Canonical task status set — mirrors the tasks.status CHECK constraint in db.ts.
 *  Single source of truth for runtime validation (API + tools). */
export const TASK_STATUSES: readonly string[] = ['todo', 'doing', 'review', 'done', 'failed', 'blocked', 'cancelled'];
export type PriorityLevel = 'low' | 'medium' | 'high' | 'critical';

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
  status?:          TaskStatus;        // initial status (defaults to 'todo')
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

  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO tasks (
      id, title, description, session_id, agent_id, priority,
      project_id, parent_task_id, assignee, task_order, feature,
      sources, code_examples, priority_level, status, task_source, archon_task_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title,
    opts.description ?? null,
    opts.sessionId ?? null,
    resolvedAgentId ?? null,
    priority,
    projectId,
    opts.parent_task_id ?? null,
    opts.assignee?.trim() || 'User',
    opts.task_order ?? 0,
    opts.feature ?? null,
    JSON.stringify(opts.sources       ?? []),
    JSON.stringify(opts.code_examples ?? []),
    priorityLevel,
    opts.status ?? 'todo',
    opts.task_source ?? 'dashboard',
    opts.archon_task_id ?? null,
  );
  logAudit('task_created', 'task', id, { title, agentId: resolvedAgentId, projectId });
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

async function applyHoldoutVerdict(id: string, task: AppTask): Promise<void> {
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
    updateTask(id, { status: 'done' });
    deactivateIdleTempAgent(task.agent_id, id);
    return;
  }

  const maxRetries = task.max_retries ?? 3;
  // `task` is a snapshot captured before the multi-second review LLM call — read
  // failure_count fresh so a concurrent bump isn't lost, and increment atomically.
  const cur = (getDb().prepare('SELECT failure_count FROM tasks WHERE id = ?')
    .get(id) as { failure_count: number } | undefined)?.failure_count ?? task.failure_count;
  if (cur < maxRetries) {
    bumpFailureCount(id);
    updateTask(id, {
      status:            'todo',
      reviewer_feedback: verdict.feedback,
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

// TODO [task queue workers]: When status → 'doing', push to BullMQ/Redis for async execution
