import { EventEmitter } from 'events';

/**
 * Shared event bus for all dashboard user-facing notifications.
 * Fires whenever a notification surface gets a new item so that
 * external listeners (Discord, push, etc.) can forward it.
 */
export const notificationEvents = new EventEmitter();
notificationEvents.setMaxListeners(50);

export interface DashboardNotificationEvent {
  type: 'agent_user_message' | 'approval' | 'analyst_alert';
  id: string;
  source: string;   // agent name, 'system', etc.
  title: string;
  body: string;
  severity?: 'info' | 'warn' | 'error' | 'critical' | 'question' | 'update';
  metadata?: Record<string, unknown>;
  url?: string;     // deep-link into dashboard
}
