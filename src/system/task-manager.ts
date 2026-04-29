import { randomUUID } from 'crypto';
import { getDb, logAudit } from '../db';

export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';

export interface AppTask {
  id:          string;
  title:       string;
  description: string | null;
  status:      TaskStatus;
  priority:    number;
  session_id:  string | null;
  agent_id:    string | null;
  created_at:  string;
  updated_at:  string;
}

export function createTask(
  title:       string,
  description?: string,
  sessionId?:  string,
  agentId?:    string,
  priority = 50,
): AppTask {
  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO tasks (id, title, description, session_id, agent_id, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title, description ?? null, sessionId ?? null, agentId ?? null, priority);
  logAudit('task_created', 'task', id, { title, agentId });
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as AppTask;
}

export function updateTask(
  id: string,
  fields: {
    status?:   TaskStatus;
    agent_id?: string | null;
    title?:    string;
    description?: string;
    priority?: number;
  },
): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (fields.status      !== undefined) { sets.push('status = ?');      params.push(fields.status); }
  if (fields.agent_id    !== undefined) { sets.push('agent_id = ?');    params.push(fields.agent_id); }
  if (fields.title       !== undefined) { sets.push('title = ?');       params.push(fields.title); }
  if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
  if (fields.priority    !== undefined) { sets.push('priority = ?');    params.push(fields.priority); }

  if (sets.length === 1) return;
  params.push(id);
  getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logAudit('task_updated', 'task', id, fields);
}

export function getTasks(status?: TaskStatus): AppTask[] {
  if (status) {
    return getDb()
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC')
      .all(status) as AppTask[];
  }
  return getDb()
    .prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at DESC')
    .all() as AppTask[];
}

// TODO [task queue workers]: When status → 'doing', push to BullMQ/Redis for async execution
