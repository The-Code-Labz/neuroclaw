import { getDb } from '../db';
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

function safeCount(db: ReturnType<typeof getDb>, sql: string): number {
  try {
    return (db.prepare(sql).get() as { count: number })?.count ?? 0;
  } catch (err) {
    logger.warn('Analytics query failed', { sql, err: err instanceof Error ? err.message : err });
    return 0;
  }
}

function safeSum(db: ReturnType<typeof getDb>, sql: string): number {
  try {
    return (db.prepare(sql).get() as { total: number })?.total ?? 0;
  } catch (err) {
    logger.warn('Analytics query failed', { sql, err: err instanceof Error ? err.message : err });
    return 0;
  }
}

function safeAll<T>(db: ReturnType<typeof getDb>, sql: string): T[] {
  try {
    return db.prepare(sql).all() as T[];
  } catch (err) {
    logger.warn('Analytics query failed', { sql, err: err instanceof Error ? err.message : err });
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
