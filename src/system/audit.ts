import { getDb } from '../db';

export interface AuditLog {
  id:          string;
  action:      string;
  entity_type: string | null;
  entity_id:   string | null;
  details:     string | null;
  created_at:  string;
}

export function getRecentLogs(limit = 50): AuditLog[] {
  return getDb()
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AuditLog[];
}
