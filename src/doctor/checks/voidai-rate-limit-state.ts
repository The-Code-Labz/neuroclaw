// mcp.voidai-429-storm — flag a recent burst of VoidAI 429 / rate-limit events.
//
// Real source of truth lives in hive_mind, written via logHive() from
// src/agent/alfred.ts when the OpenAI/VoidAI SDK throws. We look for the
// llm_rate_limit action and/or summary lines that mention VoidAI 429.
//
// Threshold: 5 events in the last hour. Above that, recommend the documented
// containment procedure (disable voice on non-essential bots, switch Oracle /
// Alfred TTS to ElevenLabs, add backoff).

import { register } from '../registry';

const THRESHOLD = 5;
const WINDOW_HOURS = 1;

register({
  id: 'mcp.voidai-429-storm',
  scope: 'mcp',
  severity: 'warn',
  description: 'VoidAI 429 errors not above storm threshold in last hour',
  async run(ctx) {
    let count = 0;
    let sample: Array<{ summary: string; created_at: string }> = [];

    try {
      const row = ctx.db.prepare(`
        SELECT COUNT(*) AS n FROM hive_mind
        WHERE created_at > datetime('now', '-${WINDOW_HOURS} hour')
          AND (
            action = 'llm_rate_limit'
            OR action LIKE '%rate_limit%'
            OR summary LIKE '%429%'
            OR summary LIKE '%rate limit%'
            OR summary LIKE '%RateLimitError%'
          )
          AND (summary LIKE '%VoidAI%' OR summary LIKE '%voidai%')
      `).get() as { n: number } | undefined;
      count = row?.n ?? 0;

      if (count > 0) {
        sample = ctx.db.prepare(`
          SELECT summary, created_at FROM hive_mind
          WHERE created_at > datetime('now', '-${WINDOW_HOURS} hour')
            AND (action LIKE '%rate_limit%' OR summary LIKE '%429%' OR summary LIKE '%rate limit%')
            AND (summary LIKE '%VoidAI%' OR summary LIKE '%voidai%')
          ORDER BY created_at DESC
          LIMIT 3
        `).all() as Array<{ summary: string; created_at: string }>;
      }
    } catch {
      // hive_mind schema might differ; return ok-with-warning rather than failing.
      return {
        ok: true,
        detail: 'hive_mind query unavailable — skipped',
        meta: { skipped: true },
      };
    }

    return {
      ok: count < THRESHOLD,
      detail: `${count} VoidAI 429/rate-limit event(s) in last ${WINDOW_HOURS}h (threshold ${THRESHOLD})`,
      fix: count >= THRESHOLD ? {
        suggestion:
          'Apply VoidAI containment: disable voice on non-essential bots, switch Oracle/Alfred TTS to ElevenLabs, '
          + 'add exponential backoff. See procedures/2026-05-07--dream-cycle--immediate-containment-for-voidai-429-rate-limiting.md',
        automated: false,
      } : undefined,
      meta: { count, threshold: THRESHOLD, windowHours: WINDOW_HOURS, sample },
    };
  },
});
