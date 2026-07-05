// Detached Task Lifecycle Runtime — registry + default implementation.
// Spec: /home/specs/detached-task-runtime.md
//
// REFACTOR-TO-INTERFACE ONLY. The default runtime preserves ALL current
// behavior. Zero behavior change on deploy. Plugins (e.g. discord-bot)
// can override by calling registerDetachedTaskRuntime().

import { getDb } from '../db';
import { logger } from '../utils/logger';
import type { DetachedTaskLifecycleRuntime } from './detached-task-runtime-contract';

// ── Default runtime ───────────────────────────────────────────────────────────
// Inlines the same DB operations as resolveSubAgentTask / failSubAgentTask to
// avoid a circular import with sub-agent-runner.ts.

const DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME: DetachedTaskLifecycleRuntime = {
  finalizeTaskRunByRunId({ taskId, status, output, error }) {
    const db = getDb();
    if (status === 'done') {
      db.prepare(
        `UPDATE tasks SET status='done', output=?, terminal_outcome=NULL, updated_at=datetime('now') WHERE id=?`,
      ).run(output ?? '', taskId);
    } else if (status === 'blocked') {
      // Phase 1: store as status='done' + terminal_outcome='blocked' per sub-agent-blocked-outcome spec.
      // Phase 2 (task-status-extension spec): update to status='blocked' natively once that migration lands.
      db.prepare(
        `UPDATE tasks SET status='done', output=?, terminal_outcome='blocked', updated_at=datetime('now') WHERE id=?`,
      ).run(output ?? '', taskId);
    } else {
      // 'failed' or 'dropped' — both map to tasks.status='failed'
      db.prepare(
        `UPDATE tasks SET status='failed', output=?, terminal_outcome=NULL, updated_at=datetime('now') WHERE id=?`,
      ).run(JSON.stringify({ error: error ?? `Task ended with status: ${status}` }), taskId);
    }
  },

  async tryRecoverTaskBeforeMarkLost({ taskId, runId, ageMs }) {
    // Default: no recovery — let the sweeper mark the run lost.
    logger.info('detached-task-runtime: no recovery registered — will mark lost', { taskId, runId, ageMs });
    return { recovered: false };
  },

  async deliverTaskResult({ taskId, status, channel }) {
    // Default: no-op. Dashboard surfaces self-poll; Discord delivery is
    // handled by the discord-bot plugin registered via registerDetachedTaskRuntime().
    logger.info('detached-task-runtime: deliverTaskResult no-op (no plugin registered)', {
      taskId, status, channel,
    });
  },
};

// ── Singleton registry ────────────────────────────────────────────────────────

let registeredRuntime: { pluginId: string; runtime: DetachedTaskLifecycleRuntime } | null = null;

export function registerDetachedTaskRuntime(
  pluginId: string,
  runtime: DetachedTaskLifecycleRuntime,
): void {
  if (registeredRuntime) {
    logger.warn('detached-task-runtime: replacing existing runtime registration', {
      previous: registeredRuntime.pluginId,
      next: pluginId,
    });
  }
  registeredRuntime = { pluginId, runtime };
  logger.info('detached-task-runtime: runtime registered', { pluginId });
}

export function getDetachedTaskLifecycleRuntime(): DetachedTaskLifecycleRuntime {
  return registeredRuntime?.runtime ?? DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME;
}

/** Remove custom registration — reverts to default runtime. Useful in tests. */
export function clearDetachedTaskLifecycleRuntimeRegistration(): void {
  registeredRuntime = null;
}
