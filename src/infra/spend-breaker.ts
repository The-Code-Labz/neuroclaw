import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface SpendBreakerResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
  inFlightId?: string;
}

export interface QuotaState {
  usedCalls: number;
  limitCalls: number;
  usedUsd: number;
  limitUsd: number;
  orgUsedUsd: number;
  orgLimitUsd: number;
  resetAt: string; // ISO UTC midnight
}

/** Look up the estimated USD cost for a tool/model/operation. */
export function estimateCost(tool: string, model?: string, _operation?: string): number {
  const costMap = config.studio.costMap;
  if (model) {
    const key = `${tool}/${model}`;
    if (typeof costMap[key] === 'number') return costMap[key];
  }
  if (typeof costMap[tool] === 'number') return costMap[tool];
  return 0;
}

function dayBucket(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Log a breaker trip to the ledger for reconciliation. */
function logTrip(userId: string, reason: string, spendAtTrip: number): void {
  try {
    getDb()
      .prepare(
        'INSERT INTO spend_breaker_trips (id, user_id, reason, spend_at_trip, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), userId, reason, spendAtTrip, Date.now());
  } catch (err) {
    logger.warn('spend-breaker: failed to log trip', { error: (err as Error).message, userId, reason });
  }
}

/** Remove in-flight rows older than the stale threshold (crashed processes). */
export function cleanupStaleInFlight(maxAgeMs: number): void {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  try {
    db.prepare('DELETE FROM spend_in_flight WHERE started_at < ?').run(cutoff);
  } catch (err) {
    logger.warn('spend-breaker: cleanupStaleInFlight failed', { error: (err as Error).message });
  }
}

/** Atomically check all caps and reserve an in-flight slot if allowed. */
export function checkSpendBreaker({
  userId,
  tool,
  model,
  operation,
  estUsd,
}: {
  userId: string;
  tool: string;
  model?: string;
  operation?: string;
  estUsd?: number;
}): SpendBreakerResult {
  const db = getDb();
  const cfg = config.studio.spendBreaker;
  if (!cfg.enabled) {
    return { allowed: true, inFlightId: randomUUID() };
  }

  const now = Date.now();
  const dayBucketStr = dayBucket();
  const burstBucket = String(Math.floor(now / cfg.burstWindowMs));
  const cost = estUsd ?? estimateCost(tool, model, operation);

  return db.transaction(() => {
    // Sweep rows left behind by crashes before counting.
    cleanupStaleInFlight(Math.max(cfg.burstWindowMs * 2, 300000));

    const userInFlight = (
      db.prepare('SELECT COUNT(*) as n FROM spend_in_flight WHERE user_id = ?').get(userId) as { n: number }
    ).n;

    if (userInFlight >= cfg.maxConcurrent) {
      logTrip(userId, 'user_concurrent_limit', 0);
      return { allowed: false, reason: 'user_concurrent_limit', retryAfterMs: 60000 };
    }

    // User burst (calls)
    const burstRow = db
      .prepare(
        'SELECT calls, usd FROM spend_counters WHERE scope = ? AND user_id = ? AND window = ? AND bucket = ?'
      )
      .get('user', userId, 'burst', burstBucket) as { calls: number; usd: number } | undefined;
    if ((burstRow?.calls ?? 0) >= cfg.burstMaxCalls) {
      logTrip(userId, 'user_burst_limit', burstRow?.usd ?? 0);
      return {
        allowed: false,
        reason: 'user_burst_limit',
        retryAfterMs: cfg.burstWindowMs - (now % cfg.burstWindowMs),
      };
    }

    // User daily (calls + USD) — OR logic: first trip wins.
    const dailyRow = db
      .prepare(
        'SELECT calls, usd FROM spend_counters WHERE scope = ? AND user_id = ? AND window = ? AND bucket = ?'
      )
      .get('user', userId, 'day', dayBucketStr) as { calls: number; usd: number } | undefined;
    if ((dailyRow?.calls ?? 0) >= cfg.dailyMaxCalls) {
      logTrip(userId, 'user_daily_calls_limit', dailyRow?.usd ?? 0);
      return { allowed: false, reason: 'user_daily_calls_limit', retryAfterMs: nextUtcMidnight().getTime() - now };
    }
    if ((dailyRow?.usd ?? 0) + cost > cfg.dailyMaxUsd) {
      logTrip(userId, 'user_daily_usd_limit', dailyRow?.usd ?? 0);
      return { allowed: false, reason: 'user_daily_usd_limit', retryAfterMs: nextUtcMidnight().getTime() - now };
    }

    // Org-wide daily USD ceiling
    const globalRow = db
      .prepare(
        'SELECT calls, usd FROM spend_counters WHERE scope = ? AND user_id = ? AND window = ? AND bucket = ?'
      )
      .get('global', '', 'day', dayBucketStr) as { calls: number; usd: number } | undefined;
    if ((globalRow?.usd ?? 0) + cost > cfg.globalDailyMaxUsd) {
      logTrip(userId, 'global_daily_usd_limit', globalRow?.usd ?? 0);
      return { allowed: false, reason: 'global_daily_usd_limit', retryAfterMs: nextUtcMidnight().getTime() - now };
    }

    // Reserve the slot.
    const inFlightId = randomUUID();
    db.prepare('INSERT INTO spend_in_flight (id, user_id, tool, model, started_at, est_usd) VALUES (?, ?, ?, ?, ?, ?)')
      .run(inFlightId, userId, tool, model ?? null, now, cost);

    // Increment counters (calls + USD). Pollinations cost=0 still increments calls.
    const upsert = db.prepare(`
      INSERT INTO spend_counters (scope, user_id, window, bucket, calls, usd, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, user_id, window, bucket)
      DO UPDATE SET calls = calls + excluded.calls,
                    usd   = usd   + excluded.usd,
                    updated_at = excluded.updated_at
    `);
    upsert.run('user', userId, 'burst', burstBucket, 1, cost, now);
    upsert.run('user', userId, 'day', dayBucketStr, 1, cost, now);
    upsert.run('global', '', 'day', dayBucketStr, 1, cost, now);

    return { allowed: true, inFlightId };
  })();
}

/** Release an in-flight slot after the outbound call completes or fails.
 *  Optionally adjust counters if the actual cost differed from the estimate.
 */
export function releaseSpendBreaker(inFlightId: string, actualUsd?: number): void {
  const db = getDb();
  try {
    const row = db
      .prepare('SELECT user_id, tool, model, started_at, est_usd FROM spend_in_flight WHERE id = ?')
      .get(inFlightId) as
      | { user_id: string; tool: string; model: string | null; started_at: number; est_usd: number }
      | undefined;
    if (!row) return;

    db.prepare('DELETE FROM spend_in_flight WHERE id = ?').run(inFlightId);

    if (typeof actualUsd === 'number' && actualUsd !== row.est_usd) {
      const delta = actualUsd - row.est_usd;
      const now = Date.now();
      const dayBucketStr = dayBucket();
      const burstBucket = String(Math.floor(now / config.studio.spendBreaker.burstWindowMs));
      const upsert = db.prepare(`
        INSERT INTO spend_counters (scope, user_id, window, bucket, calls, usd, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, user_id, window, bucket)
        DO UPDATE SET usd = usd + excluded.usd,
                      updated_at = excluded.updated_at
      `);
      upsert.run('user', row.user_id, 'burst', burstBucket, 0, delta, now);
      upsert.run('user', row.user_id, 'day', dayBucketStr, 0, delta, now);
      upsert.run('global', '', 'day', dayBucketStr, 0, delta, now);
    }
  } catch (err) {
    logger.warn('spend-breaker: release failed', { inFlightId, error: (err as Error).message });
  }
}

/** Check whether the org-wide soft-warning threshold has been crossed. */
export function checkOrgSpendWarning(): { warning: boolean; orgUsedUsd: number; orgWarnUsd: number } {
  const cfg = config.studio.spendBreaker;
  if (!cfg.enabled) return { warning: false, orgUsedUsd: 0, orgWarnUsd: cfg.orgWarnUsd };
  try {
    const row = getDb()
      .prepare('SELECT usd FROM spend_counters WHERE scope = ? AND user_id = ? AND window = ? AND bucket = ?')
      .get('global', '', 'day', dayBucket()) as { usd: number } | undefined;
    const orgUsedUsd = row?.usd ?? 0;
    return { warning: orgUsedUsd >= cfg.orgWarnUsd, orgUsedUsd, orgWarnUsd: cfg.orgWarnUsd };
  } catch (err) {
    logger.warn('spend-breaker: warning check failed', { error: (err as Error).message });
    return { warning: false, orgUsedUsd: 0, orgWarnUsd: cfg.orgWarnUsd };
  }
}

/** Return the current user/session quota for the Gen tab UI. */
export function getQuota(userId: string): QuotaState {
  const cfg = config.studio.spendBreaker;
  const dayBucketStr = dayBucket();
  const userRow = getDb()
    .prepare('SELECT calls, usd FROM spend_counters WHERE scope = ? AND user_id = ? AND window = ? AND bucket = ?')
    .get('user', userId, 'day', dayBucketStr) as { calls: number; usd: number } | undefined;
  const globalRow = getDb()
    .prepare('SELECT usd FROM spend_counters WHERE scope = ? AND user_id = ? AND window = ? AND bucket = ?')
    .get('global', '', 'day', dayBucketStr) as { usd: number } | undefined;
  return {
    usedCalls: userRow?.calls ?? 0,
    limitCalls: cfg.dailyMaxCalls,
    usedUsd: userRow?.usd ?? 0,
    limitUsd: cfg.dailyMaxUsd,
    orgUsedUsd: globalRow?.usd ?? 0,
    orgLimitUsd: cfg.globalDailyMaxUsd,
    resetAt: nextUtcMidnight().toISOString(),
  };
}

/** Middleware-style helper: runs breaker and returns either a Hono-style
 *  error payload or the inFlightId to be released after the handler. */
export function gateSpendBreaker(props: {
  userId: string;
  tool: string;
  model?: string;
  operation?: string;
  estUsd?: number;
}): { ok: true; inFlightId: string } | { ok: false; status: 429 | 503; body: object } {
  const result = checkSpendBreaker(props);
  if (result.allowed && result.inFlightId) {
    return { ok: true, inFlightId: result.inFlightId };
  }
  return {
    ok: false,
    status: result.reason?.includes('concurrent') ? 503 : 429,
    body: {
      ok: false,
      error: `Studio spend breaker: ${result.reason}`,
      reason: result.reason,
      retryAfterSec: Math.ceil((result.retryAfterMs ?? 60000) / 1000),
      retryAfterMs: result.retryAfterMs,
    },
  };
}
