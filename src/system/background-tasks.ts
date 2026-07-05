/**
 * Background task runner for async sub-agent execution.
 * Allows the main chat to continue while spawned agents work.
 *
 * spec: task-management-overhaul — tasks are now persisted to SQLite with
 * task_source='background' so they appear in the dashboard and survive restarts.
 * The in-memory Map is kept as a fast lookup layer for SSE emission within the
 * same process lifetime; SQLite is the durable store.
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { deactivateAgent, getAgentById } from '../db';
import { logHive } from './hive-mind';
import { createTask, updateTask as dbUpdateTask, getTaskById } from './task-manager';

export interface BackgroundTask {
  id: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  sqliteTaskId?: string;
}

// In-process SSE state — fast, but not durable across restarts.
// The authoritative state is in SQLite (task_source='background').
const tasks = new Map<string, BackgroundTask>();
export const taskEvents = new EventEmitter();

export async function createBackgroundTask(
  id: string,
  agentId: string,
  agentName: string,
  sessionId: string,
  description?: string,
): Promise<BackgroundTask> {
  const task: BackgroundTask = {
    id,
    agentId,
    agentName,
    sessionId,
    status: 'running',
    startedAt: new Date(),
  };
  tasks.set(id, task);

  // Persist to SQLite so the dashboard can show it and it survives restarts.
  try {
    const sqliteTask = await createTask(
      `background: ${(description ?? agentName).slice(0, 80)}`,
      {
        description:  description ?? `Background agent task for ${agentName}`,
        status:       'doing',
        task_source:  'background',
        assignee:     agentName,
        sessionId,
        agentId,
      },
    );
    task.sqliteTaskId = sqliteTask?.id;
  } catch (err) {
    // Non-fatal — the in-memory map still works for SSE
    logger.warn('bg-tasks: failed to persist task to SQLite', { taskId: id, error: (err as Error).message });
  }

  logger.info('bg-tasks: task started', { taskId: id, agentName });
  return task;
}

/**
 * Persistent agents (temporary=0) must never be auto-deactivated by background
 * task lifecycle — only ephemeral spawned agents (temporary=1) are. A missing
 * agent row resolves to false (don't deactivate), which is the safe default.
 */
function isTemporaryAgent(agentId: string): boolean {
  try {
    return getAgentById(agentId)?.temporary === 1;
  } catch {
    return false;
  }
}

export function completeBackgroundTask(
  taskId: string,
  result: string,
  deactivateAgentAfter: boolean = true,
): void {
  const task = tasks.get(taskId);
  if (!task) return;

  task.status = 'completed';
  task.result = result;
  task.completedAt = new Date();

  logger.info('bg-tasks: task completed', { taskId, agentName: task.agentName, chars: result.length });

  // Persist completion to SQLite
  try {
    const sqliteId = task.sqliteTaskId ?? taskId;
    const sqliteTask = getTaskById(sqliteId);
    if (sqliteTask) {
      dbUpdateTask(sqliteTask.id, { status: 'done', output: result.slice(0, 10_000) });
    }
  } catch (err) {
    logger.warn('bg-tasks: failed to update SQLite task on completion', { taskId, error: (err as Error).message });
  }

  // Auto-deactivate temp agent after task completion. Guard on temporary=1 —
  // persistent agents (Jarvis/Friday/Liese/etc.) run background/agent_task work
  // too and must NEVER be deactivated by it. The auto-deactivate is only for
  // ephemeral spawned agents.
  if (deactivateAgentAfter && isTemporaryAgent(task.agentId)) {
    const deactivateResult = deactivateAgent(task.agentId);
    if (deactivateResult.ok) {
      logHive('agent_deactivated', `bg-tasks: Temp agent "${task.agentName}" auto-deactivated after task completion`, task.agentId);
      logger.info('bg-tasks: temp agent deactivated after task', { agentId: task.agentId, agentName: task.agentName });
    }
  }

  // Emit completion event for SSE listeners
  taskEvents.emit('task_complete', task);
}

export function failBackgroundTask(taskId: string, error: string): void {
  const task = tasks.get(taskId);
  if (!task) return;

  task.status = 'failed';
  task.error = error;
  task.completedAt = new Date();

  logger.error('bg-tasks: task failed', { taskId, agentName: task.agentName, error });

  // Persist failure to SQLite
  try {
    const sqliteId = task.sqliteTaskId ?? taskId;
    const sqliteTask = getTaskById(sqliteId);
    if (sqliteTask) {
      dbUpdateTask(sqliteTask.id, { status: 'failed', last_error: error.slice(0, 2000) });
    }
  } catch (err) {
    logger.warn('bg-tasks: failed to update SQLite task on failure', { taskId, error: (err as Error).message });
  }

  // Still deactivate on failure — but only temp agents (see completeBackgroundTask).
  if (isTemporaryAgent(task.agentId)) {
    deactivateAgent(task.agentId);
    logHive('agent_deactivated', `bg-tasks: Temp agent "${task.agentName}" deactivated after task failure`, task.agentId);
  }

  taskEvents.emit('task_failed', task);
}

export function getTask(taskId: string): BackgroundTask | undefined {
  return tasks.get(taskId);
}

export function getTasksBySession(sessionId: string): BackgroundTask[] {
  return Array.from(tasks.values()).filter(t => t.sessionId === sessionId);
}

export function cleanupOldTasks(maxAgeMs: number = 3600000): void {
  const cutoff = Date.now() - maxAgeMs;
  // A 'running' task whose completion callback never fires (process crash mid-run,
  // a hung worker promise) has no completedAt and would otherwise live forever,
  // growing the map monotonically. Evict by startedAt past a generous TTL so the
  // map stays bounded; the authoritative state is SQLite, not this in-process map.
  const runningCutoff = Date.now() - Math.max(maxAgeMs, 6 * 3600000);
  for (const [id, task] of tasks) {
    if (task.completedAt && task.completedAt.getTime() < cutoff) {
      tasks.delete(id);
    } else if (!task.completedAt && task.startedAt.getTime() < runningCutoff) {
      logger.warn('background-tasks: evicting never-finalized running task', { id, agentId: task.agentId, ageMs: Date.now() - task.startedAt.getTime() });
      tasks.delete(id);
    }
  }
}
