import { getDb } from '../db';

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

export function getAnalyticsSummary(): AnalyticsSummary {
  const db = getDb();

  const total_messages = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  const total_sessions = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;
  const total_tokens   = (db.prepare("SELECT COALESCE(SUM(tokens_used), 0) as total FROM messages").get() as { total: number }).total;
  const messages_today = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE date(created_at) = date('now')").get() as { count: number }).count;
  const messages_7d    = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE created_at >= datetime('now', '-7 days')").get() as { count: number }).count;
  const active_agents  = (db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'active'").get() as { count: number }).count;
  const temp_agents    = (db.prepare("SELECT COUNT(*) as count FROM agents WHERE temporary = 1 AND status = 'active'").get() as { count: number }).count;
  const tasks_todo     = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status IN ('todo', 'doing')").get() as { count: number }).count;
  const tasks_done     = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'done'").get() as { count: number }).count;
  const memories_count = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
  
  const events_by_type = db.prepare(
    'SELECT event_type, COUNT(*) as count FROM analytics_events GROUP BY event_type ORDER BY count DESC LIMIT 10'
  ).all() as Array<{ event_type: string; count: number }>;
  
  const messages_by_day = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count 
    FROM messages 
    WHERE created_at >= datetime('now', '-14 days')
    GROUP BY date(created_at) 
    ORDER BY day DESC
  `).all() as Array<{ day: string; count: number }>;
  
  const top_agents = db.prepare(`
    SELECT a.name, COUNT(m.id) as messages
    FROM agents a
    LEFT JOIN messages m ON m.agent_id = a.id
    WHERE a.status = 'active' AND a.temporary = 0
    GROUP BY a.id
    ORDER BY messages DESC
    LIMIT 5
  `).all() as Array<{ name: string; messages: number }>;
  
  const hive_recent = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM hive_mind
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY action
    ORDER BY count DESC
    LIMIT 10
  `).all() as Array<{ action: string; count: number }>;

  return { 
    total_messages, total_sessions, total_tokens, messages_today, messages_7d,
    active_agents, temp_agents, tasks_todo, tasks_done, memories_count,
    events_by_type, messages_by_day, top_agents, hive_recent 
  };
}
