// Scenario-specific grace periods for stale task detection.
// Spec: /home/specs/task-sweep-grace-periods.md
//
// Keep independent from config.dashboard.runStaleMs — that governs
// runs-table heartbeat expiry; this governs task-table stale decisions.

export const TASK_SWEEP_CONFIG = {
  /** Standard task — backing session gone → mark lost after 5 min */
  RECONCILE_GRACE_MS:               5  * 60_000,

  /** Codex native sub-agents — extra time for CLI startup + session attachment */
  CODEX_NATIVE_RECONCILE_GRACE_MS:  30 * 60_000,

  /** Any running task with no progress heartbeat → stale after 30 min */
  STALE_RUNNING_MS:                 30 * 60_000,

  /** Wedged sub-agent recovery — wait before declaring recovery failed */
  SUBAGENT_RECOVERY_WEDGE_GRACE_MS: 10 * 60_000,

  /** Task record retention — prune after 7 days */
  RETENTION_MS:                     7 * 24 * 60 * 60_000,

  /** How often the task sweep maintenance loop runs */
  SWEEP_INTERVAL_MS:                60_000,
} as const;
