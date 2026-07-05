// Per-task notification policy for sub-agent tasks.
// Spec: /home/specs/task-notify-policy.md
//
// Controls when a sub-agent task delivers proactive updates.
// This does NOT affect task execution or get_subtask_result queryability.

export type TaskNotifyPolicy = 'done_only' | 'all_updates' | 'never';

type NotifyPolicyCarrier = {
  notify_policy?: string | null;
  notifyPolicy?:  string | null;
};

/**
 * Normalise any raw notify_policy value to the canonical enum.
 * Unknown or missing values default to 'done_only' (preserves current behavior).
 */
export function normalizeTaskNotifyPolicy(task: NotifyPolicyCarrier): TaskNotifyPolicy {
  const raw = task.notify_policy ?? task.notifyPolicy ?? 'done_only';
  return raw === 'all_updates' || raw === 'never' ? raw : 'done_only';
}

/**
 * Returns true if the task should emit an update for the given event type.
 *
 * Policy semantics:
 *   done_only  — only emit on terminal events (done / failed / blocked)
 *   all_updates — emit both progress heartbeats and terminal events
 *   never       — never emit proactively; task remains queryable via get_subtask_result
 */
export function shouldDeliverTaskUpdate(
  task: NotifyPolicyCarrier,
  event: 'progress' | 'terminal',
): boolean {
  switch (normalizeTaskNotifyPolicy(task)) {
    case 'never':       return false;
    case 'all_updates': return true;
    case 'done_only':
    default:            return event === 'terminal';
  }
}
