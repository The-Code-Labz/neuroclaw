/**
 * Background task runner for async sub-agent execution.
 * Allows the main chat to continue while spawned agents work.
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { deactivateAgent } from '../db';
import { logHive } from './hive-mind';

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
}

// In-memory task store (could be Redis/DB for persistence)
const tasks = new Map<string, BackgroundTask>();
export const taskEvents = new EventEmitter();

export function createBackgroundTask(
  id: string,
  agentId: string,
  agentName: string,
  sessionId: string,
): BackgroundTask {
  const task: BackgroundTask = {
    id,
    agentId,
    agentName,
    sessionId,
    status: 'running',
    startedAt: new Date(),
  };
  tasks.set(id, task);
  logger.info('Background task started', { taskId: id, agentName });
  return task;
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
  
  logger.info('Background task completed', { taskId, agentName: task.agentName, chars: result.length });

  // Auto-deactivate temp agent after task completion
  if (deactivateAgentAfter) {
    const deactivateResult = deactivateAgent(task.agentId);
    if (deactivateResult.ok) {
      logHive('agent_deactivated', `Temp agent "${task.agentName}" auto-deactivated after task completion`, task.agentId);
      logger.info('Temp agent deactivated after task', { agentId: task.agentId, agentName: task.agentName });
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
  
  logger.error('Background task failed', { taskId, agentName: task.agentName, error });

  // Still deactivate on failure
  deactivateAgent(task.agentId);
  logHive('agent_deactivated', `Temp agent "${task.agentName}" deactivated after task failure`, task.agentId);

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
  for (const [id, task] of tasks) {
    if (task.completedAt && task.completedAt.getTime() < cutoff) {
      tasks.delete(id);
    }
  }
}
