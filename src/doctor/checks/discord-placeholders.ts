// discord.placeholder-ids — flag any Discord channel/guild IDs that look like
// placeholders rather than real snowflakes.
//
// Discord snowflakes are 17-20 digit numbers. Anything else (literal
// "your_channel_id_here", "xxx", "replace_me", empty strings, alphabetic
// junk) is a sign of mis-configuration and causes warning storms from the
// alert dispatcher.

import { register } from '../registry';

const SNOWFLAKE = /^\d{17,20}$/;

interface BadRow {
  table: string;
  field: string;
  row_id: string;
  value: string;
}

register({
  id: 'discord.placeholder-ids',
  scope: 'discord',
  severity: 'fail',
  description: 'No placeholder strings in Discord channel/guild IDs',
  async run(ctx) {
    const bad: BadRow[] = [];

    // discord_bots — bots themselves don't have channel ids in this schema,
    // but they do have an application_id and bot_user_id that should be
    // snowflakes once the bot has connected. Tolerate NULLs.
    try {
      const bots = ctx.db
        .prepare(`SELECT id, application_id, bot_user_id FROM discord_bots`)
        .all() as Array<{ id: string; application_id: string | null; bot_user_id: string | null }>;
      for (const b of bots) {
        if (b.application_id !== null && b.application_id !== '' && !SNOWFLAKE.test(b.application_id)) {
          bad.push({ table: 'discord_bots', field: 'application_id', row_id: b.id, value: b.application_id });
        }
        if (b.bot_user_id !== null && b.bot_user_id !== '' && !SNOWFLAKE.test(b.bot_user_id)) {
          bad.push({ table: 'discord_bots', field: 'bot_user_id', row_id: b.id, value: b.bot_user_id });
        }
      }
    } catch { /* table may not exist on a partial schema */ }

    // discord_channel_routes — channel_id is NOT NULL and must be a snowflake.
    try {
      const routes = ctx.db
        .prepare(`SELECT id, channel_id FROM discord_channel_routes`)
        .all() as Array<{ id: string; channel_id: string }>;
      for (const r of routes) {
        if (!SNOWFLAKE.test(r.channel_id)) {
          bad.push({ table: 'discord_channel_routes', field: 'channel_id', row_id: r.id, value: r.channel_id });
        }
      }
    } catch { /* skip */ }

    // alert_targets — historical / future table. Schema-tolerant query.
    try {
      const alerts = ctx.db
        .prepare(`SELECT id, channel_id FROM alert_targets WHERE channel_id IS NOT NULL`)
        .all() as Array<{ id: string; channel_id: string }>;
      for (const a of alerts) {
        if (!SNOWFLAKE.test(a.channel_id)) {
          bad.push({ table: 'alert_targets', field: 'channel_id', row_id: a.id, value: a.channel_id });
        }
      }
    } catch { /* table doesn't exist — skip */ }

    return {
      ok: bad.length === 0,
      detail: bad.length === 0
        ? 'All Discord IDs are valid snowflakes'
        : `${bad.length} invalid channel/guild id(s) found`,
      fix: bad.length > 0 ? {
        suggestion: 'Replace or delete the offending rows: '
          + bad.map(b => `${b.table}#${b.row_id}.${b.field}="${b.value}"`).join(', '),
        automated: false,
      } : undefined,
      meta: { bad },
    };
  },
});
