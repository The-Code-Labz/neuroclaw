import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { getDb, getSharedCommsNotesForAgent } from '../db';

export const hiveEvents = new EventEmitter();
hiveEvents.setMaxListeners(50);

// ── In-memory ring buffer for recent hive events (instant dashboard queries) ──
const HIVE_RING_SIZE = 500;
const hiveRing: HiveEvent[] = [];
const errorRing: HiveEvent[] = [];

function pushToHiveRing(ev: HiveEvent): void {
  if (hiveRing.length >= HIVE_RING_SIZE) hiveRing.shift();
  hiveRing.push(ev);

  // Also maintain the error subset
  const errorActions = new Set([
    'llm_error', 'llm_auth_error', 'llm_rate_limit', 'llm_server_error',
    'tool_error', 'mcp_probe_failed', 'mcp_agent_call_failed',
    'background_task_failed', 'dream_cycle_failed', 'review_failed',
  ]);
  if (errorActions.has(ev.action)) {
    if (errorRing.length >= HIVE_RING_SIZE) errorRing.shift();
    errorRing.push(ev);
  }
}

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
  | 'memory_graph_attached'
  | 'triage_llm_used'
  | 'triage_depth_penalty'
  | 'triage_budget_downgrade'
  | 'dream_cycle_start'
  | 'dream_cycle_complete'
  | 'dream_cycle_failed'
  | 'memories_created'
  | 'memories_promoted'
  | 'memories_merged'
  | 'memories_pruned'
  | 'procedures_created'
  | 'plan_created'
  | 'agent_heartbeat'
  | 'mcp_probe_ok'
  | 'mcp_probe_failed'
  | 'kb_ingested'
  | 'skill_created'
  | 'skill_authored'
  | 'skill_forge_failed'
  | 'skill_forge_fallback'
  | 'skill_promoted_from_memory'
  | 'skill_updated'
  | 'skill_deleted'
  | 'skill_script_run'
  | 'skill_script_written'
  | 'skill_script_deleted'
  | 'mcp_agent_call_ok'
  | 'mcp_agent_call_failed'
  | 'review_passed'
  | 'review_failed'
  | 'browser_action'
  | 'web_search'
  | 'provider_cooldown_set'
  | 'provider_recovered'
  | 'tool_call'
  | 'tool_start'
  | 'tool_end'
  | 'tool_error'
  | 'llm_error'
  | 'llm_auth_error'
  | 'llm_rate_limit'
  | 'llm_server_error'
  | 'task_monitor_alert'
  | 'sentinel_check_in'
  | 'sentinel_reassign'
  | 'sentinel_blocked'
  | 'archivist_extracted'
  | 'agent_thought'
  | 'tool_result'
  | 'agent_response'
  | 'cron_job_created'
  | 'cron_job_updated'
  | 'cron_job_deleted'
  | 'cron_run_started'
  | 'cron_run_complete'
  | 'cron_run_error'
  | 'cron_inbound_trigger'
  | 'analyst_run_ok'
  | 'analyst_error'
  | 'user_message_sent'
  | 'user_note_added'
  | 'user_note_deleted'
  | 'agent_notified_user'
  | 'agent_image_sent'
  | 'user_dismissed_notification'
  | 'alert_sent'
  | 'task_health_alert'
  | 'sessions_cleaned_up'
  | 'job_claimed'
  | 'job_done'
  | 'job_failed'
  | 'job_quota_requeued'
  | 'voidai_fallback'
  | 'task_recovered'
  | 'orphaned_doing_task_requeued'
  | 'agent_introduced'
  | 'tasks_archived'
  | 'subtask_started'
  | 'subtask_triage'
  | 'subtask_complete'
  | 'subtask_failed'
  | 'subtask_blocked'
  | 'subtask_global_limit_hit'
  | 'subtask_overflow_sequential'
  | 'subtask_continuation'
  // NC Broker / MCP supervisor lifecycle (see src/mcp/mcpSpawner.ts)
  | 'mcp_spawned'
  | 'mcp_exited'
  | 'mcp_rotation_applied'
  | 'mcp_rotation_failed'
  | 'session_archived'
  | 'cleanup_force_deleted_unarchived'
  | 'memory_sweep_started'
  | 'memory_sweep_completed'
  | 'sentinel_reset_agentless'
  | 'agent_file_sent'
  | 'vision_describe'
  | 'tool_loop_break'
  | 'agy_respond'
  // Autonomous Mission Control loop (see src/system/autonomous-loop.ts)
  | 'autonomous_started'
  | 'autonomous_task_done'
  | 'autonomous_task_failed'
  | 'autonomous_stopped'
  | 'task_claimed'
  | 'task_self_updated';

export interface HiveEvent {
  id:         string;
  agent_id:   string | null;
  agent_name: string | null;
  action:     string;
  summary:    string;
  metadata:   string | null;
  created_at: string;
  run_id?:    string | null;
  session_id?: string | null;
}

// Agent name cache to avoid repeated DB lookups during logHive
const agentNameCache = new Map<string, string>();

export function logHive(
  action: HiveAction,
  summary: string,
  agentId?: string,
  metadata?: unknown,
  runId?: string,
  sessionId?: string,
): void {
  try {
    const id  = randomUUID();
    const db  = getDb();
    db.prepare(`
      INSERT INTO hive_mind (id, agent_id, action, summary, metadata, run_id, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      agentId ?? null,
      action,
      summary,
      metadata !== undefined ? JSON.stringify(metadata) : null,
      runId ?? null,
      sessionId ?? null,
    );
    // Emit for live SSE stream (best-effort — never crashes main flow)
    try {
      let agentName: string | null = null;
      if (agentId) {
        agentName = agentNameCache.get(agentId) ?? null;
        if (!agentName) {
          const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
          agentName = row?.name ?? null;
          if (agentName) agentNameCache.set(agentId, agentName);
        }
      }
      const ev: HiveEvent = {
        id,
        agent_id:   agentId ?? null,
        agent_name: agentName,
        action,
        summary,
        metadata:   metadata !== undefined ? JSON.stringify(metadata) : null,
        created_at: new Date().toISOString(),
        run_id:     runId ?? null,
        session_id: sessionId ?? null,
      };
      pushToHiveRing(ev);
      hiveEvents.emit('event', ev);
    } catch { /* ignore */ }
  } catch {
    // Never let hive logging crash the main flow
  }
}

// ── Per-turn tool trace (Phase 4) ────────────────────────────────────────────
// Emits `tool_call` hive events from the shared tool-dispatch chokepoints so the
// Traces panel shows what each agent actually did. Fire-and-forget and fully
// guarded — a trace failure must NEVER break tool dispatch (the hottest path in
// the system). run_id/session_id are threaded through so events attach to their
// run in the Traces view; without them the event still lands on the live timeline.

export interface ToolTraceCtx {
  agentId?:   string | null;
  runId?:     string | null;
  sessionId?: string | null;
}

/**
 * Defense-in-depth redaction of obviously secret-shaped tokens from a trace
 * preview. Tool args normally never carry broker secrets (those are injected at
 * execution time and are never model-visible), but a user could paste a key into
 * a prompt-style arg — so scrub the common shapes before they hit the feed.
 */
function redactTracePreview(s: string): string {
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|GOCSPX-[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g, '‹redacted›')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1‹redacted›');
}

/**
 * Emit a `tool_call` trace event for a single tool invocation. Serializes,
 * secret-redacts, and truncates the args to keep the feed light. Never throws.
 */
export function logToolCall(name: string, args: unknown, ctx: ToolTraceCtx): void {
  try {
    let preview = '';
    try {
      const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
      preview = redactTracePreview(raw).slice(0, 240);
    } catch { preview = '(unserializable)'; }
    const summary = (preview ? `${name} ${preview}` : name).slice(0, 300);
    logHive(
      'tool_call',
      summary,
      ctx.agentId ?? undefined,
      { tool: name, args: preview },
      ctx.runId ?? undefined,
      ctx.sessionId ?? undefined,
    );
  } catch { /* never break tool dispatch */ }
}

export function getHiveEvents(limit = 100): HiveEvent[] {
  // Serve from in-memory ring when possible (instant, no DB hit)
  if (limit <= hiveRing.length) {
    return hiveRing.slice(-limit).reverse();
  }
  return getDb().prepare(`
    SELECT hm.*, a.name AS agent_name
    FROM hive_mind hm
    LEFT JOIN agents a ON hm.agent_id = a.id
    ORDER BY hm.created_at DESC
    LIMIT ?
  `).all(limit) as HiveEvent[];
}

export function getHiveErrors(limit = 50): HiveEvent[] {
  if (limit <= errorRing.length) {
    return errorRing.slice(-limit).reverse();
  }
  return getDb().prepare(`
    SELECT hm.*, a.name AS agent_name
    FROM hive_mind hm
    LEFT JOIN agents a ON hm.agent_id = a.id
    WHERE hm.action IN (
      'llm_error', 'llm_auth_error', 'llm_rate_limit', 'llm_server_error',
      'tool_error', 'mcp_probe_failed', 'mcp_agent_call_failed',
      'background_task_failed', 'dream_cycle_failed', 'review_failed'
    )
    ORDER BY hm.created_at DESC
    LIMIT ?
  `).all(limit) as HiveEvent[];
}

export function getCrossSessionContext(agentId: string, currentSessionId: string, limit = 10): string {
  if (!agentId || !currentSessionId) return '';
  try {
    const rows = getDb().prepare(`
      SELECT hm.summary, hm.created_at, s.title AS session_title
      FROM hive_mind hm
      LEFT JOIN sessions s ON hm.session_id = s.id
      WHERE hm.agent_id = ?
        AND hm.session_id IS NOT NULL
        AND hm.session_id != ?
        AND hm.created_at > datetime('now', '-2 hours')
      ORDER BY hm.created_at DESC
      LIMIT ?
    `).all(agentId, currentSessionId, limit) as Array<{
      summary: string;
      created_at: string;
      session_title: string | null;
    }>;

    if (rows.length === 0) return '';

    const lines = rows.map(row => {
      const label = row.session_title ?? '(unnamed session)';
      return `- [${label} | ${formatHiveAge(row.created_at)}] ${row.summary}`;
    });

    return `\n\n## Your other active sessions\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * Build a system-prompt block containing user-authored "shared" comms notes
 * targeted at this agent (or broadcast to all agents). Returns '' when no
 * applicable notes exist. Capped at 8 notes / ~2KB to keep prompts bounded.
 *
 * Mirrors the getCrossSessionContext call-site pattern: append the returned
 * string to activeSystemPrompt so the agent reads the notes on every turn.
 */
export function getSharedCommsNotesContext(agentId: string | null | undefined): string {
  if (!agentId) return '';
  try {
    const notes = getSharedCommsNotesForAgent(agentId, 8);
    if (notes.length === 0) return '';
    const lines = notes.map(n => {
      const tag = n.pinned ? '📌 ' : '';
      const body = n.body.length > 240 ? n.body.slice(0, 237) + '…' : n.body;
      return `- ${tag}${body}`;
    });
    return `\n\n## Notes from the user (Comms)\nThese are operator-authored notes — treat as guidance from the human user.\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

function formatHiveAge(isoOrSqlite: string): string {
  const ts = isoOrSqlite.endsWith('Z') ? isoOrSqlite : isoOrSqlite.replace(' ', 'T') + 'Z';
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} hr ago`;
}
