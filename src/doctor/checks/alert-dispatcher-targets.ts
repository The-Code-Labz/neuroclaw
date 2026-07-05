// alert-dispatcher.targets — verify the alert dispatcher's configured Discord
// targets are usable.
//
// The dispatcher (src/system/alert-dispatcher.ts) reads ALERT_DISCORD_CHANNEL_ID
// + optional ALERT_DISCORD_BOT_ID from env, then calls sendToChannel on a
// running Discord bot. Failure modes:
//   - channel id is a placeholder ("your_channel_id_here") → warning storm.
//   - channel id is missing while bot is referenced → silent drop.
//   - bot id is referenced but no row exists in discord_bots → silent drop.
//   - Gotify URL set without token (or vice versa) → silent drop.

import { register } from '../registry';

const SNOWFLAKE = /^\d{17,20}$/;
const DISCORD_WEBHOOK = /^https:\/\/(?:discord(?:app)?|ptb\.discord|canary\.discord)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

register({
  id: 'alert-dispatcher.targets',
  scope: 'config',
  severity: 'fail',
  description: 'Alert dispatcher targets (Discord channel/bot, Gotify) are valid',
  async run(ctx) {
    const env = ctx.env;
    const problems: string[] = [];

    // ── Discord channel ─────────────────────────────────────────────────
    const chId = (env.ALERT_DISCORD_CHANNEL_ID ?? '').trim();
    const botId = (env.ALERT_DISCORD_BOT_ID ?? '').trim();

    if (chId) {
      if (!SNOWFLAKE.test(chId)) {
        problems.push(`ALERT_DISCORD_CHANNEL_ID is not a Discord snowflake: "${chId}"`);
      }
    } else if (botId) {
      // bot referenced but no channel — alerts will never deliver.
      problems.push('ALERT_DISCORD_BOT_ID is set but ALERT_DISCORD_CHANNEL_ID is empty');
    }

    if (botId) {
      try {
        const row = ctx.db.prepare('SELECT id, enabled FROM discord_bots WHERE id = ?').get(botId) as
          | { id: string; enabled: number }
          | undefined;
        if (!row) {
          problems.push(`ALERT_DISCORD_BOT_ID="${botId}" does not match any row in discord_bots`);
        } else if (!row.enabled) {
          problems.push(`ALERT_DISCORD_BOT_ID="${botId}" references a disabled bot`);
        }
      } catch { /* table may not exist on partial schema */ }
    }

    // ── Notify Discord (mirror) ─────────────────────────────────────────
    const notifyEnabled = (env.NOTIFY_DISCORD_ENABLED ?? 'false').trim().toLowerCase() === 'true';
    if (notifyEnabled) {
      const notifyCh = (env.NOTIFY_DISCORD_CHANNEL_ID ?? env.ALERT_DISCORD_CHANNEL_ID ?? '').trim();
      if (!notifyCh) {
        problems.push('NOTIFY_DISCORD_ENABLED=true but no NOTIFY_DISCORD_CHANNEL_ID (or ALERT_DISCORD_CHANNEL_ID) configured');
      } else if (!SNOWFLAKE.test(notifyCh)) {
        problems.push(`Notify Discord channel id is not a snowflake: "${notifyCh}"`);
      }
    }

    // ── Gotify ──────────────────────────────────────────────────────────
    const gotifyUrl = (env.GOTIFY_URL ?? '').trim();
    const gotifyTok = (env.GOTIFY_TOKEN ?? '').trim();
    if ((gotifyUrl && !gotifyTok) || (!gotifyUrl && gotifyTok)) {
      problems.push('GOTIFY_URL and GOTIFY_TOKEN must both be set (or both unset)');
    }
    if (gotifyUrl) {
      try {
        new URL(gotifyUrl);
      } catch {
        problems.push(`GOTIFY_URL is not a valid URL: "${gotifyUrl}"`);
      }
    }

    // ── Cron job outbound webhook URLs (a related Discord-ish surface) ──
    try {
      const jobs = ctx.db
        .prepare(`SELECT id, name, on_complete_webhook_url FROM cron_jobs
                  WHERE on_complete_webhook_url IS NOT NULL AND on_complete_webhook_url != ''`)
        .all() as Array<{ id: string; name: string; on_complete_webhook_url: string }>;
      for (const j of jobs) {
        const u = j.on_complete_webhook_url.trim();
        let host = '';
        try { host = new URL(u).hostname; } catch {
          problems.push(`cron_jobs[${j.id} "${j.name}"] on_complete_webhook_url is not a URL: "${u}"`);
          continue;
        }
        // Discord webhooks have a strict shape; non-discord webhooks just need
        // to be a syntactically valid URL.
        if (/discord(app)?\.com$/.test(host) && !DISCORD_WEBHOOK.test(u)) {
          problems.push(`cron_jobs[${j.id} "${j.name}"] Discord webhook URL malformed`);
        }
      }
    } catch { /* skip if table missing */ }

    return {
      ok: problems.length === 0,
      detail: problems.length === 0
        ? 'All alert dispatcher targets resolve cleanly'
        : `${problems.length} alert-target problem(s)`,
      fix: problems.length > 0 ? {
        suggestion: problems.join(' | '),
        automated: false,
      } : undefined,
      meta: { problems, channelId: chId || null, botId: botId || null },
    };
  },
});
