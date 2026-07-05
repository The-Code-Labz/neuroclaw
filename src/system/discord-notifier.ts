import { config } from '../config';
import { logger } from '../utils/logger';
import { notificationEvents, type DashboardNotificationEvent } from './notification-events';

/**
 * Subscribe to dashboard notification events and mirror them to Discord.
 * Uses the same sendToChannel helper as AlertDispatcher (no LLM in path).
 */
export function startDiscordNotifier(): void {
  const cfg = config.notifications;
  if (!cfg.discordEnabled || !cfg.discordChannelId) {
    logger.info('discord-notifier: disabled (set NOTIFY_DISCORD_ENABLED=true + channel id to enable)');
    return;
  }

  notificationEvents.on('new', async (event: DashboardNotificationEvent) => {
    try {
      const { sendToChannel } = await import('../integrations/discord-bot');
      const text = formatNotification(event);
      const result = await sendToChannel(cfg.discordChannelId!, text, cfg.discordBotId ?? undefined);
      if (!result.ok) {
        logger.warn('discord-notifier: send failed', { error: result.error, eventId: event.id });
      } else {
        logger.debug('discord-notifier: sent', { type: event.type, id: event.id });
      }
    } catch (err) {
      logger.warn('discord-notifier: unexpected error', { error: (err as Error).message, eventId: event.id });
    }
  });

  logger.info('discord-notifier: listening', { channelId: cfg.discordChannelId });
}

function formatNotification(event: DashboardNotificationEvent): string {
  const emojiMap: Record<string, string> = {
    agent_user_message: '📬',
    approval:         '⏸️',
    analyst_alert:    '🔔',
  };
  const severityEmoji: Record<string, string> = {
    info:     '⚪',
    warn:     '🟡',
    error:    '🔴',
    critical: '🚨',
    question: '❓',
    update:   '📝',
  };

  const icon = emojiMap[event.type] ?? '📌';
  const sev  = severityEmoji[event.severity ?? 'info'] ?? '⚪';

  const lines: string[] = [
    `${icon} **${event.title}**  ${sev}`,
    `> ${event.body.slice(0, 1800)}`,
  ];

  if (event.url) {
    const base = `http://localhost:${config.dashboard.port}`;
    lines.push(`\n[Open Dashboard](${base}${event.url})`);
  }

  return lines.join('\n');
}
