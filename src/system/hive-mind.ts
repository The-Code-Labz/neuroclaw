import { randomUUID } from 'crypto';
import { getDb } from '../db';

export type HiveAction =
  | 'manual_delegation'
  | 'auto_route'
  | 'route_fallback'
  | 'spawn_request'
  | 'spawn_success'
  | 'spawn_denied'
  | 'agent_spawned'
  | 'agent_expired'
  | 'task_created'
  | 'task_updated'
  | 'agent_activated'
  | 'agent_deactivated'
  | 'task_decomposed'
  | 'multi_agent_step'
  | 'result_merged'
  | 'spawn_evaluated'
  | 'background_task_complete'
  | 'background_task_failed'
  | 'agent_message_sent'
  | 'agent_task_assigned'
  | 'claude_cli_throttled'
  | 'memory_extracted'
  | 'memory_skipped'
  | 'memory_capped'
  | 'triage_llm_used'
  | 'triage_depth_penalty'
  | 'triage_budget_downgrade';

export interface HiveEvent {
  id:         string;
  agent_id:   string | null;
  agent_name: string | null;
  action:     string;
  summary:    string;
  metadata:   string | null;
  created_at: string;
}

export function logHive(
  action: HiveAction,
  summary: string,
  agentId?: string,
  metadata?: unknown,
): void {
  try {
    getDb().prepare(`
      INSERT INTO hive_mind (id, agent_id, action, summary, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      agentId ?? null,
      action,
      summary,
      metadata !== undefined ? JSON.stringify(metadata) : null,
    );
  } catch {
    // Never let hive logging crash the main flow
  }
}

export function getHiveEvents(limit = 100): HiveEvent[] {
  return getDb().prepare(`
    SELECT hm.*, a.name AS agent_name
    FROM hive_mind hm
    LEFT JOIN agents a ON hm.agent_id = a.id
    ORDER BY hm.created_at DESC
    LIMIT ?
  `).all(limit) as HiveEvent[];
}
