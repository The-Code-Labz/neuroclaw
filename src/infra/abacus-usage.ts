// src/infra/abacus-usage.ts
// Abacus (ChatLLM / RouteLLM) compute-point meter.
//
// Abacus has NO programmatic usage/credit endpoint (re-verified live 2026-07-14:
// describeUser has no credit field; getComputePointUsage/getCreditUsage → 404;
// RouteLLM returns no x-ratelimit headers). The real remaining balance lives only
// in the abacus.ai web dashboard. So instead of reading their balance, we METER
// our own consumption: every abacus_image / abacus_speech call records the
// provider-reported compute points (resp.usage.compute_points_used) into the
// durable model_spend ledger. This fetcher sums them over the billing cycle.
//
// Plan facts (user-supplied 2026-07-14, from the ChatLLM dashboard):
//   • allowance : 20,000 credits / month
//   • reset     : the 7th of each month (e.g. next reset Aug 07)
// Both are env-overridable. NOTE the credit-vs-token distinction: Abacus credits
// are NOT tokens — 10K credits can be ~70M tokens on some LLMs.
//
// HONEST CAVEAT (surfaced on the tile): this is a LOCAL meter of what we consumed
// through our tools, NOT Abacus's authoritative remaining balance. Out-of-band
// dashboard usage (manual web chats, images) is not captured, so this reads LOWER
// than the dashboard's "used" figure. Directionally accurate for "how hard is the
// system burning Abacus this cycle"; the true remaining number lives in the
// dashboard until the optional Phase-2 headless reconciler is built.
import { logger } from '../utils/logger';
import { getDb } from '../db';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const CACHE_TTL_MS = 60_000;

// Plan allowance + reset day — env-overridable, defaults from the dashboard.
const ALLOWANCE = Number(process.env.ABACUS_MONTHLY_CREDITS ?? '20000') || 20_000;
const RESET_DAY = Math.min(28, Math.max(1, Number(process.env.ABACUS_RESET_DAY ?? '7') || 7));

// Providers written by the instrumented abacus tools (abacus_video was removed).
const ABACUS_PROVIDERS = ['abacus_image', 'abacus_speech', 'abacus'] as const;

let cache: { at: number; value: ProviderLimits } | null = null;

/** Compute the current billing-cycle window: [most-recent RESET_DAY, next RESET_DAY) in UTC. */
function billingCycle(now = new Date()): { start: Date; resetAt: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11
  const d = now.getUTCDate();
  // Date.UTC normalizes month over/underflow (m-1 = -1 → prior-year Dec).
  const start = d >= RESET_DAY
    ? new Date(Date.UTC(y, m, RESET_DAY, 0, 0, 0))
    : new Date(Date.UTC(y, m - 1, RESET_DAY, 0, 0, 0));
  const resetAt = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, RESET_DAY, 0, 0, 0));
  return { start, resetAt };
}

export async function fetchAbacusUsage(): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const { start, resetAt } = billingCycle();
  const startIso = start.toISOString();

  let pointsUsed = 0;
  try {
    const placeholders = ABACUS_PROVIDERS.map(() => '?').join(',');
    // SUM(compute_points) DIRECTLY — do NOT reuse spendByProvider's token-rate
    // JOIN; it returns 0 for 0-token image/speech rows (compute_points is a raw
    // ledger column, not derived from tokens).
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(compute_points), 0) AS pts, COUNT(*) AS calls
      FROM model_spend
      WHERE provider IN (${placeholders}) AND created_at >= ?
    `).get(...ABACUS_PROVIDERS, startIso) as { pts: number; calls: number };
    pointsUsed = Number(row?.pts) || 0;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('abacus-usage: query failed', { error: message });
    return { ok: false, provider: 'abacus', windows: [], error: `ledger query failed: ${message}` };
  }

  const usedPercent = ALLOWANCE > 0
    ? Math.min(100, Math.max(0, Math.round((pointsUsed / ALLOWANCE) * 100)))
    : 0;

  const window: LimitWindow = { label: 'Compute Credits', usedPercent, resetAt: resetAt.getTime() };
  const value: ProviderLimits = { ok: true, provider: 'abacus', windows: [window] };
  value.note = ALLOWANCE > 0
    ? `~${pointsUsed.toLocaleString()} / ${ALLOWANCE.toLocaleString()} credits · local meter (not authoritative)`
    : `~${pointsUsed.toLocaleString()} credits this cycle · set ABACUS_MONTHLY_CREDITS`;

  cache = { at: Date.now(), value };
  return value;
}
