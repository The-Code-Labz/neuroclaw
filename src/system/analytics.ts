import { getDb } from '../db';

export interface AnalyticsSummary {
  total_messages:  number;
  total_sessions:  number;
  total_tokens:    number;
  messages_today:  number;
  events_by_type:  Array<{ event_type: string; count: number }>;
}

export function getAnalyticsSummary(): AnalyticsSummary {
  const db = getDb();

  const total_messages = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  const total_sessions = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;
  const total_tokens   = (db.prepare("SELECT COALESCE(SUM(tokens_used), 0) as total FROM messages").get() as { total: number }).total;
  const messages_today = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE date(created_at) = date('now')").get() as { count: number }).count;
  const events_by_type = db.prepare('SELECT event_type, COUNT(*) as count FROM analytics_events GROUP BY event_type ORDER BY count DESC').all() as Array<{ event_type: string; count: number }>;

  return { total_messages, total_sessions, total_tokens, messages_today, events_by_type };
}
