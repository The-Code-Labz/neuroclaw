import { getDb } from '../db';
import type { DowntimeEvent } from '../db';
import { logger } from '../utils/logger';

export interface AnalyticsSummary {
  total_messages:     number;
  total_sessions:     number;
  total_tokens:       number;
  messages_today:     number;
  messages_7d:        number;
  active_agents:      number;
  temp_agents:        number;
  tasks_todo:         number;
  tasks_done:         number;
  memories_count:     number;
  events_by_type:     Array<{ event_type: string; count: number }>;
  messages_by_day:    Array<{ day: string; count: number }>;
  top_agents:         Array<{ name: string; messages: number }>;
  hive_recent:        Array<{ action: string; count: number }>;
}

export interface HealthSummary {
  uptime_pct:       number;
  downtime_count:   number;
  errors_24h:       number;
  warnings_24h:     number;
  last_incident_at: string | null;
}

export interface UptimeSegment {
  started_at:  string;
  ended_at:    string;
  status:      'up' | 'down' | 'degraded';
  event_type?: string;
  duration_minutes?: number;
}

export interface SystemHealthStats {
  server_starts:      number;
  server_errors_24h:  number;
  discord_connects:   number;
  discord_errors_24h: number;
  discord_restarts:   number;
  heartbeat_ok_rate:  number;
  log_errors_24h:     number;
  log_warnings_24h:   number;
  errors_by_source:   Array<{ source: string; count: number }>;
  discord_events:     Array<{ event_type: string; count: number }>;
  heartbeat_history:  Array<{ hour: string; ok: number; fail: number; avgLatency: number }>;
}

function safeCount(db: ReturnType<typeof getDb>, sql: string): number {
  try {
    return (db.prepare(sql).get() as { count: number })?.count ?? 0;
  } catch (err) {
    logger.warn('analytics: query failed', { sql, err: err instanceof Error ? err.message : err });
    return 0;
  }
}

function safeSum(db: ReturnType<typeof getDb>, sql: string): number {
  try {
    return (db.prepare(sql).get() as { total: number })?.total ?? 0;
  } catch (err) {
    logger.warn('analytics: query failed', { sql, err: err instanceof Error ? err.message : err });
    return 0;
  }
}

function safeAll<T>(db: ReturnType<typeof getDb>, sql: string): T[] {
  try {
    return db.prepare(sql).all() as T[];
  } catch (err) {
    logger.warn('analytics: query failed', { sql, err: err instanceof Error ? err.message : err });
    return [];
  }
}

export function getAnalyticsSummary(): AnalyticsSummary {
  const db = getDb();

  const total_messages = safeCount(db, 'SELECT COUNT(*) as count FROM messages');
  const total_sessions = safeCount(db, 'SELECT COUNT(*) as count FROM sessions');
  const total_tokens   = safeSum(db, "SELECT COALESCE(SUM(tokens_used), 0) as total FROM messages");
  const messages_today = safeCount(db, "SELECT COUNT(*) as count FROM messages WHERE date(created_at) = date('now')");
  const messages_7d    = safeCount(db, "SELECT COUNT(*) as count FROM messages WHERE created_at >= datetime('now', '-7 days')");
  const active_agents  = safeCount(db, "SELECT COUNT(*) as count FROM agents WHERE status = 'active'");
  const temp_agents    = safeCount(db, "SELECT COUNT(*) as count FROM agents WHERE temporary = 1 AND status = 'active'");
  const tasks_todo     = safeCount(db, "SELECT COUNT(*) as count FROM tasks WHERE status IN ('todo', 'doing')");
  const tasks_done     = safeCount(db, "SELECT COUNT(*) as count FROM tasks WHERE status = 'done'");
  const memories_count = safeCount(db, 'SELECT COUNT(*) as count FROM memories');
  
  const events_by_type = safeAll<{ event_type: string; count: number }>(db,
    'SELECT event_type, COUNT(*) as count FROM analytics_events GROUP BY event_type ORDER BY count DESC LIMIT 10'
  );
  
  const messages_by_day = safeAll<{ day: string; count: number }>(db, `
    SELECT date(created_at) as day, COUNT(*) as count 
    FROM messages 
    WHERE created_at >= datetime('now', '-14 days')
    GROUP BY date(created_at) 
    ORDER BY day DESC
  `);
  
  const top_agents = safeAll<{ name: string; messages: number }>(db, `
    SELECT a.name, COUNT(m.id) as messages
    FROM agents a
    LEFT JOIN messages m ON m.agent_id = a.id
    WHERE a.status = 'active' AND a.temporary = 0
    GROUP BY a.id
    ORDER BY messages DESC
    LIMIT 5
  `);
  
  const hive_recent = safeAll<{ action: string; count: number }>(db, `
    SELECT action, COUNT(*) as count
    FROM hive_mind
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY action
    ORDER BY count DESC
    LIMIT 10
  `);

  return { 
    total_messages, total_sessions, total_tokens, messages_today, messages_7d,
    active_agents, temp_agents, tasks_todo, tasks_done, memories_count,
    events_by_type, messages_by_day, top_agents, hive_recent 
  };
}

/**
 * Get system health statistics from analytics events
 * Focuses on errors, disconnects, restarts, and overall system stability
 */
export function getSystemHealthStats(): SystemHealthStats {
  const db = getDb();

  // Server lifecycle
  const server_starts = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events 
    WHERE event_type = 'server_started'
  `);
  
  const server_errors_24h = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events 
    WHERE event_type = 'server_error' 
    AND created_at >= datetime('now', '-24 hours')
  `);

  // Discord bot stats
  const discord_connects = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events 
    WHERE event_type = 'discord_connected'
    AND created_at >= datetime('now', '-24 hours')
  `);
  
  const discord_errors_24h = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events 
    WHERE event_type = 'discord_error'
    AND created_at >= datetime('now', '-24 hours')
  `);
  
  const discord_restarts = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events 
    WHERE event_type = 'discord_restart'
    AND created_at >= datetime('now', '-24 hours')
  `);

  // Heartbeat stats
  const heartbeatStats = safeAll<{ ok: number; fail: number }>(db, `
    SELECT 
      SUM(json_extract(data, '$.ok')) as ok,
      SUM(json_extract(data, '$.fail')) as fail
    FROM analytics_events 
    WHERE event_type = 'heartbeat_batch'
    AND created_at >= datetime('now', '-24 hours')
  `);
  const okTotal = heartbeatStats[0]?.ok ?? 0;
  const failTotal = heartbeatStats[0]?.fail ?? 0;
  const heartbeat_ok_rate = (okTotal + failTotal) > 0 ? Math.round((okTotal / (okTotal + failTotal)) * 100) : 100;

  // Log errors (from logger integration)
  const log_errors_24h = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events 
    WHERE event_type = 'log_error'
    AND json_extract(data, '$.level') = 'error'
    AND created_at >= datetime('now', '-24 hours')
  `);
  
  const log_warnings_24h = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events 
    WHERE event_type = 'log_error'
    AND json_extract(data, '$.level') = 'warn'
    AND created_at >= datetime('now', '-24 hours')
  `);

  // Errors by source (from log_error events)
  const errors_by_source = safeAll<{ source: string; count: number }>(db, `
    SELECT json_extract(data, '$.source') as source, COUNT(*) as count
    FROM analytics_events 
    WHERE event_type = 'log_error'
    AND created_at >= datetime('now', '-24 hours')
    GROUP BY json_extract(data, '$.source')
    ORDER BY count DESC
    LIMIT 10
  `);

  // Discord events breakdown
  const discord_events = safeAll<{ event_type: string; count: number }>(db, `
    SELECT event_type, COUNT(*) as count
    FROM analytics_events 
    WHERE event_type LIKE 'discord_%'
    AND created_at >= datetime('now', '-24 hours')
    GROUP BY event_type
    ORDER BY count DESC
  `);

  // Heartbeat history by hour
  const heartbeat_history = safeAll<{ hour: string; ok: number; fail: number; avgLatency: number }>(db, `
    SELECT 
      strftime('%Y-%m-%d %H:00', created_at) as hour,
      COALESCE(SUM(json_extract(data, '$.ok')), 0) as ok,
      COALESCE(SUM(json_extract(data, '$.fail')), 0) as fail,
      COALESCE(AVG(json_extract(data, '$.avgLatencyMs')), 0) as avgLatency
    FROM analytics_events 
    WHERE event_type = 'heartbeat_batch'
    AND created_at >= datetime('now', '-24 hours')
    GROUP BY strftime('%Y-%m-%d %H:00', created_at)
    ORDER BY hour DESC
    LIMIT 24
  `);

  return {
    server_starts,
    server_errors_24h,
    discord_connects,
    discord_errors_24h,
    discord_restarts,
    heartbeat_ok_rate,
    log_errors_24h,
    log_warnings_24h,
    errors_by_source,
    discord_events,
    heartbeat_history,
  };
}

/**
 * Get recent errors for display in dashboard
 */
export function getRecentErrors(limit = 50): Array<{
  id: string;
  event_type: string;
  source: string;
  message: string;
  level: string;
  created_at: string;
}> {
  const db = getDb();
  return safeAll(db, `
    SELECT 
      id,
      event_type,
      json_extract(data, '$.source') as source,
      COALESCE(json_extract(data, '$.message'), json_extract(data, '$.reason'), '') as message,
      COALESCE(json_extract(data, '$.level'), 'error') as level,
      created_at
    FROM analytics_events 
    WHERE event_type IN ('log_error', 'server_error', 'discord_error')
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
}

/**
 * Get message activity sparkline data (24 hours, hourly)
 */
export function getMessageSparkline(): Array<{ hour: string; count: number }> {
  const db = getDb();
  return safeAll(db, `
    SELECT 
      strftime('%Y-%m-%d %H:00', created_at) as hour,
      COUNT(*) as count
    FROM messages 
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY strftime('%Y-%m-%d %H:00', created_at)
    ORDER BY hour ASC
  `);
}

/**
 * Get top tools used (from hive_mind tool_call events)
 */
export function getTopTools(limit = 10): Array<{ tool: string; count: number }> {
  const db = getDb();
  return safeAll(db, `
    SELECT 
      COALESCE(json_extract(metadata, '$.tool'), json_extract(metadata, '$.toolName'), 'unknown') as tool,
      COUNT(*) as count
    FROM hive_mind 
    WHERE action = 'tool_call'
    AND created_at >= datetime('now', '-7 days')
    GROUP BY tool
    ORDER BY count DESC
    LIMIT ${limit}
  `);
}

/**
 * Get activity heatmap data (day of week × hour)
 */
export function getActivityHeatmap(): Array<{ dayOfWeek: number; hour: number; count: number }> {
  const db = getDb();
  return safeAll(db, `
    SELECT
      CAST(strftime('%w', created_at) AS INTEGER) as dayOfWeek,
      CAST(strftime('%H', created_at) AS INTEGER) as hour,
      COUNT(*) as count
    FROM messages
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY dayOfWeek, hour
    ORDER BY dayOfWeek, hour
  `);
}

export function getHealthSummary(): HealthSummary {
  const db = getDb();

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const downtimeRows = safeAll<{ started_at: string; ended_at: string | null; duration_minutes: number | null }>(db, `
    SELECT started_at, ended_at, duration_minutes FROM downtime_events
    WHERE started_at >= '${sevenDaysAgo}'
  `);

  const totalMinutes = 7 * 24 * 60;
  const downMinutes = downtimeRows.reduce((sum, r) => sum + (r.duration_minutes ?? 0), 0);
  const uptime_pct = Math.max(0, Math.min(100, ((totalMinutes - downMinutes) / totalMinutes) * 100));

  const errors_24h = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events
    WHERE event_type IN ('log_error', 'server_error', 'discord_error')
      AND json_extract(data, '$.level') != 'warn'
      AND created_at >= datetime('now', '-24 hours')
  `);

  const warnings_24h = safeCount(db, `
    SELECT COUNT(*) as count FROM analytics_events
    WHERE event_type = 'log_error'
      AND json_extract(data, '$.level') = 'warn'
      AND created_at >= datetime('now', '-24 hours')
  `);

  const lastIncident = safeAll<{ started_at: string }>(db,
    "SELECT started_at FROM downtime_events ORDER BY started_at DESC LIMIT 1"
  );

  return {
    uptime_pct: Math.round(uptime_pct * 10) / 10,
    downtime_count: downtimeRows.length,
    errors_24h,
    warnings_24h,
    last_incident_at: lastIncident[0]?.started_at ?? null,
  };
}

export function getDowntimeEvents(days = 30): DowntimeEvent[] {
  const db = getDb();
  return safeAll<DowntimeEvent>(db, `
    SELECT * FROM downtime_events
    WHERE started_at >= datetime('now', '-${days} days')
    ORDER BY started_at DESC
    LIMIT 100
  `);
}

export function getUptimeTimeline(days = 7): UptimeSegment[] {
  const db = getDb();
  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const events = safeAll<DowntimeEvent>(db, `
    SELECT * FROM downtime_events
    WHERE started_at >= '${windowStart}'
    ORDER BY started_at ASC
  `);

  if (events.length === 0) {
    return [{ started_at: windowStart, ended_at: now, status: 'up' }];
  }

  const segments: UptimeSegment[] = [];
  let cursor = windowStart;

  for (const ev of events) {
    if (ev.started_at > cursor) {
      segments.push({ started_at: cursor, ended_at: ev.started_at, status: 'up' });
    }
    const status: 'down' | 'degraded' = ev.severity === 'critical' ? 'down' : 'degraded';
    segments.push({
      started_at: ev.started_at,
      ended_at: ev.ended_at ?? now,
      status,
      event_type: ev.type,
      duration_minutes: ev.duration_minutes ?? undefined,
    });
    cursor = ev.ended_at ?? now;
  }

  if (cursor < now) {
    segments.push({ started_at: cursor, ended_at: now, status: 'up' });
  }

  return segments;
}
