// In-memory registry of in-flight agent_task runs, keyed by their dedicated work
// sessionId. Lets a tool-dispatch choke point cheaply ask "does this run still
// own its task?" so a run that was reassigned (Sentinel) or force-failed
// (immortal-live sweep) STOPS executing side-effecting tools instead of running
// to completion with only its status write suppressed (stillOwner guards the
// write, not the work). This is the cheap alternative to threading an AbortSignal
// through all execution planes — it interrupts at the next tool call.
import { getDb } from '../db';

interface RunOwner { taskId: string; agentId: string }
const runOwners = new Map<string, RunOwner>();

export function registerRunOwner(sessionId: string, taskId: string, agentId: string): void {
  runOwners.set(sessionId, { taskId, agentId });
}

export function clearRunOwner(sessionId: string): void {
  runOwners.delete(sessionId);
}

/** True if the run owning `sessionId` has lost its task — reassigned to another
 *  agent, or the task already reached a terminal state. Returns false for any
 *  session that isn't a tracked agent_task run (normal chat, background, etc.),
 *  so it never interferes with non-board work. */
export function isRunSuperseded(sessionId: string, agentId: string): boolean {
  const owner = runOwners.get(sessionId);
  if (!owner || owner.agentId !== agentId) return false;
  const t = getDb()
    .prepare('SELECT agent_id, status FROM tasks WHERE id = ?')
    .get(owner.taskId) as { agent_id: string | null; status: string } | undefined;
  if (!t) return false;
  return t.agent_id !== agentId || t.status === 'failed' || t.status === 'cancelled' || t.status === 'done';
}
