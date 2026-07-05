// Detached Task Lifecycle Runtime — interface contract.
// Spec: /home/specs/detached-task-runtime.md
//
// Interface only — no implementation here.
// Default runtime + registry live in detached-task-runtime.ts.

export interface DetachedTaskFinalizeParams {
  taskId:   string;
  runId:    string;
  status:   'done' | 'failed' | 'blocked' | 'dropped';
  output?:  string;
  error?:   string;
}

export interface DetachedTaskRecoveryAttemptParams {
  taskId: string;
  runId:  string;
  ageMs:  number;
}

export interface DetachedTaskRecoveryAttemptResult {
  recovered: boolean;
  reason?:   string;
}

export interface DetachedTaskLifecycleRuntime {
  /**
   * Called when a task transitions to a terminal state.
   * Responsible for persisting the final task status to the DB.
   */
  finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams): void;

  /**
   * Called by the stale sweeper before marking a task/run lost.
   * Return { recovered: true } to prevent the item from being marked lost.
   */
  tryRecoverTaskBeforeMarkLost(
    params: DetachedTaskRecoveryAttemptParams,
  ): Promise<DetachedTaskRecoveryAttemptResult>;

  /**
   * Called to deliver the final result to the requester's surface
   * (Discord channel, webhook, etc). No-op for surfaces that self-poll.
   */
  deliverTaskResult(params: {
    taskId:  string;
    output:  string;
    status:  'done' | 'blocked' | 'failed';
    channel: string;
  }): Promise<void>;
}
