import { randomUUID } from 'crypto';
import { getDb, logAudit, getAllAgents, getDefaultProject } from '../db';
import { classifyRoute } from './router';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

export type TaskStatus    = 'todo' | 'doing' | 'review' | 'done';
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
  created_at:     string;
  updated_at:     string;
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

  logHive(
    'task_created',
    `Task "${title}" auto-assigned to ${decision.agent.name} (${Math.round(decision.confidence * 100)}%) — ${decision.reason}`,
    decision.agent.id,
    { title, confidence: decision.confidence },
  );
  logger.info('Task auto-assigned', { title, agent: decision.agent.name, confidence: decision.confidence });
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
      sources, code_examples, priority_level
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
  logAudit('task_created', 'task', id, { title, agentId: resolvedAgentId, projectId });
  if (!opts.agentId && resolvedAgentId) {
    logHive('task_created', `Task "${title}" created and auto-assigned`, resolvedAgentId, { taskId: id });
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as AppTask;
}

export function updateTask(
  id: string,
  fields: {
    status?:          TaskStatus;
    agent_id?:        string | null;
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
  },
): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (fields.status         !== undefined) { sets.push('status = ?');         params.push(fields.status); }
  if (fields.agent_id       !== undefined) { sets.push('agent_id = ?');       params.push(fields.agent_id); }
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

  if (sets.length === 1) return;
  params.push(id);
  getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logAudit('task_updated', 'task', id, fields);
  if (fields.status) {
    logHive('task_updated', `Task status → ${fields.status}`, undefined, { taskId: id, status: fields.status });
  }
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
  logHive('task_updated', `Task archived`, undefined, { taskId: id, archived: true });
}

// TODO [task queue workers]: When status → 'doing', push to BullMQ/Redis for async execution
