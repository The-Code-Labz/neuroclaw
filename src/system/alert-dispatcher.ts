// AlertDispatcher — central notification router for all background systems.
//
// Delivery chain per severity:
//   info     → hive_mind only
//   warn     → hive_mind + Discord/Gotify (dedup 30 min)
//   error    → hive_mind + notify_user DB + Discord/Gotify (dedup 10 min)
//   critical → hive_mind + notify_user DB + Discord/Gotify (no dedup)
//
// Discord: direct bot client call (no LLM). Composio Discord fires as
// fallback only when no native bot is available.

import { config } from '../config';
import { getDb, createAgentUserMessage } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

export interface Alert {
  severity:  'info' | 'warn' | 'error' | 'critical';
  title:     string;
  body:      string;
  source:    string;
  dedupKey?: string;
}

const dedupMap = new Map<string, number>();

function isDuped(key: string, windowMin: number): boolean {
  const last = dedupMap.get(key);
  if (last === undefined) return false;
  return Date.now() - last < windowMin * 60_000;
}

function markFired(key: string): void {
  dedupMap.set(key, Date.now());
}

function formatDiscordMessage(alert: Alert): string {
  const emoji   = { info: '⚪', warn: '🟡', error: '🔴', critical: '🚨' }[alert.severity];
  const ts      = new Date().toLocaleString();
  const divider = '─'.repeat(40);
  return `${emoji} [${alert.severity.toUpperCase()}] ${alert.source}: ${alert.title}\n${divider}\n${alert.body}\n${ts}`;
}

async function sendDiscord(text: string): Promise<void> {
  const { discordChannelId, discordBotId } = config.alerts;
  if (!discordChannelId) return;

  const { sendToChannel } = await import('../integrations/discord-bot');
  const result = await sendToChannel(discordChannelId, text, discordBotId ?? undefined);

  if (!result.ok) {
    logger.warn('alert-dispatcher: Discord direct failed, trying Composio fallback', { error: result.error });
    await sendComposioDiscord(discordChannelId, text);
  }
}

async function sendComposioDiscord(channelId: string, text: string): Promise<void> {
  const { enabled, apiKey } = config.composio;
  if (!enabled || !apiKey) return;

  const db  = getDb();
  const row = db.prepare(
    `SELECT composio_user_id FROM agents
     WHERE status = 'active' AND composio_enabled = 1 AND composio_user_id IS NOT NULL
     LIMIT 1`,
  ).get() as { composio_user_id: string } | undefined;
  if (!row) return;

  try {
    const { Composio } = await import('@composio/core');
    const client = new Composio({ apiKey });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).actions.execute({
      actionName:  'DISCORD_SEND_MESSAGE_TO_CHANNEL',
      requestBody: {
        entityId: row.composio_user_id,
        input:    { channel_id: channelId, message: text },
      },
    });
  } catch (err) {
    logger.warn('alert-dispatcher: Composio Discord fallback failed', { error: (err as Error).message });
  }
}

async function sendGotify(alert: Alert): Promise<void> {
  const { gotifyUrl, gotifyToken } = config.alerts;
  if (!gotifyUrl || !gotifyToken) return;

  const priority = { info: 1, warn: 4, error: 7, critical: 10 }[alert.severity];
  try {
    const res = await fetch(`${gotifyUrl}/message?token=${gotifyToken}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        title:    `[${alert.severity.toUpperCase()}] ${alert.source}: ${alert.title}`,
        message:  alert.body,
        priority,
      }),
    });
    if (!res.ok) {
      logger.warn('alert-dispatcher: Gotify returned non-ok', { status: res.status });
    }
  } catch (err) {
    logger.warn('alert-dispatcher: Gotify error', { error: (err as Error).message });
  }
}

export async function sendAlert(alert: Alert): Promise<void> {
  const key = alert.dedupKey ?? alert.title;

  // 1. Always log to hive_mind
  logHive(
    'alert_sent',
    `alert-dispatcher: ${alert.title}`,
    undefined,
    { severity: alert.severity, source: alert.source, body: alert.body.slice(0, 500) },
  );

  // 2. notify_user DB write for error and critical
  if (alert.severity === 'error' || alert.severity === 'critical') {
    try {
      createAgentUserMessage({
        fromAgentId: 'alert-dispatcher',
        fromName:    alert.source,
        kind:        'alert',
        body:        `**${alert.title}**\n\n${alert.body}`,
      });
    } catch (err) {
      logger.warn('alert-dispatcher: notify_user write failed', { error: (err as Error).message });
    }
  }

  // 3. info stops here — no external channels
  if (alert.severity === 'info') return;

  // 4. Dedup check (critical always fires)
  if (alert.severity !== 'critical') {
    const { dedupWarnMin, dedupErrorMin } = config.alerts;
    const windowMin = alert.severity === 'warn' ? dedupWarnMin : dedupErrorMin;
    if (isDuped(key, windowMin)) {
      logger.debug('alert-dispatcher: suppressed by dedup', { key, severity: alert.severity });
      return;
    }
  }

  markFired(key);
  const text = formatDiscordMessage(alert);

  // 5. Discord + Gotify in parallel (failures are logged, never thrown)
  await Promise.allSettled([
    sendDiscord(text),
    sendGotify(alert),
  ]);
}
