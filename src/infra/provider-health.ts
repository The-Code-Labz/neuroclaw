// src/infra/provider-health.ts
// WS2 — Provider health & cooldown layer (hermes credential_pool-inspired).
//
// The router was memoryless: a provider that just returned 429 with a 30-minute
// retry-after was retried as FIRST candidate on the very next message, burning a
// failed attempt every turn until the window reset. This module remembers.
//
// Model (per .planning/specs/2026-06-12-hermes-upgrade-audit-v2.md):
//   - 3 states: ok | cooldown | dead. dead is reserved for explicit revocation
//     signals (auth_permanent) — plain auth errors cool down for 5 min instead,
//     because keys get rotated/fixed.
//   - Typed cooldowns: auth 5m; rate_limit retry-after-or-60m; billing 60m;
//     server_error/overloaded/timeout 2m with exponential bump (cap 30m).
//   - Request-specific classes (context_overflow, content_blocked,
//     model_not_found, unknown) do NOT poison provider health.
//   - Candidates are REORDERED, never removed: a fully-cooled roster still
//     attempts something (we have far fewer fallbacks per agent than hermes).
//   - State survives restarts via the provider_health table.
//   - Usage-window bridge: when a Claude/MiniMax 5h/weekly window crosses the
//     threshold (default 95%), a soft cooldown is applied until its resetAt.
import { getDb } from '../db';
import { logHive } from '../system/hive-mind';
import { logger } from '../utils/logger';
import { config } from '../config';
import type { ClassifiedError, FailoverReason } from '../agent/provider-error';

export type ProviderHealthState = 'ok' | 'cooldown' | 'dead';

export interface ProviderHealth {
  provider:            string;
  state:               ProviderHealthState;
  cooldownUntil:       number | null;   // unix ms
  lastErrorClass:      string | null;   // FailoverReason or 'usage_window'
  lastErrorAt:         number | null;   // unix ms
  consecutiveFailures: number;
  requestCount:        number;
  updatedAt:           number;          // unix ms
}

// ── Pure cooldown policy (unit-testable, no I/O) ───────────────────────────

const MIN = 60_000;

/**
 * Cooldown duration for a classified failure, or null when the error class is
 * request-specific and must not poison provider health.
 */
export function computeCooldownMs(
  reason: FailoverReason,
  consecutiveFailures: number,
  retryAfterMs?: number | null,
): number | null {
  switch (reason) {
    case 'auth':
      return 5 * MIN;                            // keys get rotated — not dead
    case 'billing':
      return 60 * MIN;
    case 'rate_limit':
      return retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 60 * MIN;
    case 'server_error':
    case 'overloaded':
    case 'timeout': {
      // 2m base, doubling per consecutive failure, capped at 30m.
      const base = 2 * MIN * 2 ** Math.max(0, consecutiveFailures - 1);
      return Math.min(base, 30 * MIN);
    }
    case 'auth_permanent':
      return Number.POSITIVE_INFINITY;           // caller maps to 'dead'
    default:
      return null;                               // request-specific — no cooldown
  }
}

/**
 * Best-effort retry-after extraction from a provider error: standard header
 * (seconds or HTTP-date) on SDK errors, else "try again in Ns" message text.
 */
export function extractRetryAfterMs(err: unknown): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr: any = err ?? {};
  const header = anyErr.headers?.['retry-after'] ?? anyErr.headers?.get?.('retry-after');
  if (header != null) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
    const at = Date.parse(String(header));
    if (Number.isFinite(at) && at > Date.now()) return at - Date.now();
  }
  const msg = (err instanceof Error ? err.message : String(anyErr.message ?? '')).toLowerCase();
  const m = /(?:retry|try again)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes|h|hours)\b/.exec(msg);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2];
    const factor = unit === 'ms' ? 1 : unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') && unit !== 'ms' ? 60_000 : 1000;
    const v = Math.round(n * factor);
    if (v > 0 && v < 24 * 3_600_000) return v;
  }
  return null;
}

// ── State store (in-memory map, SQLite-backed for restart survival) ────────

const health = new Map<string, ProviderHealth>();
let loaded = false;

function ensureTable(): void {
  getDb().prepare(`
    CREATE TABLE IF NOT EXISTS provider_health (
      provider             TEXT PRIMARY KEY,
      state                TEXT NOT NULL DEFAULT 'ok',
      cooldown_until       INTEGER,
      last_error_class     TEXT,
      last_error_at        INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      request_count        INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL
    )
  `).run();
}

function loadAll(): void {
  if (loaded) return;
  loaded = true;
  try {
    ensureTable();
    const rows = getDb().prepare('SELECT * FROM provider_health').all() as Array<{
      provider: string; state: string; cooldown_until: number | null;
      last_error_class: string | null; last_error_at: number | null;
      consecutive_failures: number; request_count: number; updated_at: number;
    }>;
    for (const r of rows) {
      health.set(r.provider, {
        provider:            r.provider,
        state:               (r.state as ProviderHealthState) ?? 'ok',
        cooldownUntil:       r.cooldown_until,
        lastErrorClass:      r.last_error_class,
        lastErrorAt:         r.last_error_at,
        consecutiveFailures: r.consecutive_failures ?? 0,
        requestCount:        r.request_count ?? 0,
        updatedAt:           r.updated_at ?? Date.now(),
      });
    }
    if (rows.length > 0) logger.info('provider-health: restored state', { providers: rows.length });
  } catch (err) {
    logger.warn('provider-health: failed to load persisted state — starting fresh', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function persist(h: ProviderHealth): void {
  try {
    ensureTable();
    getDb().prepare(`
      INSERT INTO provider_health (provider, state, cooldown_until, last_error_class, last_error_at, consecutive_failures, request_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        state = excluded.state,
        cooldown_until = excluded.cooldown_until,
        last_error_class = excluded.last_error_class,
        last_error_at = excluded.last_error_at,
        consecutive_failures = excluded.consecutive_failures,
        request_count = excluded.request_count,
        updated_at = excluded.updated_at
    `).run(
      h.provider, h.state, h.cooldownUntil, h.lastErrorClass, h.lastErrorAt,
      h.consecutiveFailures, h.requestCount, h.updatedAt,
    );
  } catch (err) {
    logger.warn('provider-health: persist failed (state stays in-memory)', {
      provider: h.provider, error: err instanceof Error ? err.message : String(err),
    });
  }
}

function getOrInit(provider: string): ProviderHealth {
  loadAll();
  let h = health.get(provider);
  if (!h) {
    h = {
      provider, state: 'ok', cooldownUntil: null, lastErrorClass: null,
      lastErrorAt: null, consecutiveFailures: 0, requestCount: 0, updatedAt: Date.now(),
    };
    health.set(provider, h);
  }
  return h;
}

/** Lazily transition cooldown→ok when the window has passed. */
function refresh(h: ProviderHealth): ProviderHealth {
  if (h.state === 'cooldown' && h.cooldownUntil != null && Date.now() >= h.cooldownUntil) {
    h.state = 'ok';
    h.cooldownUntil = null;
    h.consecutiveFailures = 0;
    h.updatedAt = Date.now();
    persist(h);
    logHive('provider_recovered', `provider-health: ${h.provider} cooldown expired — back in rotation`, undefined, { provider: h.provider });
    logger.info('provider-health: recovered', { provider: h.provider });
  }
  return h;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function reportProviderSuccess(provider: string): void {
  if (!config.providerHealth.enabled || !provider) return;
  const h = getOrInit(provider);
  h.requestCount++;
  const wasUnhealthy = h.state !== 'ok';
  h.state = 'ok';
  h.cooldownUntil = null;
  h.consecutiveFailures = 0;
  h.updatedAt = Date.now();
  persist(h);
  if (wasUnhealthy) {
    logHive('provider_recovered', `provider-health: ${provider} succeeded — cooldown cleared`, undefined, { provider });
  }
}

export function reportProviderFailure(provider: string, classified: ClassifiedError, retryAfterMs?: number | null): void {
  if (!config.providerHealth.enabled || !provider) return;
  const h = getOrInit(provider);
  h.requestCount++;
  h.lastErrorClass = classified.reason;
  h.lastErrorAt = Date.now();
  h.consecutiveFailures++;
  h.updatedAt = Date.now();

  const cooldown = computeCooldownMs(classified.reason, h.consecutiveFailures, retryAfterMs);
  if (cooldown == null) { persist(h); return; }   // request-specific — counted, not cooled

  if (!Number.isFinite(cooldown)) {
    h.state = 'dead';
    h.cooldownUntil = null;
    persist(h);
    logHive('provider_cooldown_set', `provider-health: ${provider} marked DEAD (${classified.reason})`, undefined, {
      provider, reason: classified.reason, state: 'dead',
    });
    logger.error('provider-health: provider marked dead', { provider, reason: classified.reason });
    return;
  }

  h.state = 'cooldown';
  // Never SHORTEN an existing cooldown (e.g. a usage-window cooldown until
  // tomorrow shouldn't shrink to 2 min because of one 500).
  const until = Date.now() + cooldown;
  h.cooldownUntil = Math.max(h.cooldownUntil ?? 0, until);
  persist(h);
  logHive('provider_cooldown_set', `provider-health: ${provider} cooling down ${Math.round(cooldown / 1000)}s (${classified.reason})`, undefined, {
    provider, reason: classified.reason, cooldownMs: cooldown, until: new Date(h.cooldownUntil).toISOString(),
    consecutiveFailures: h.consecutiveFailures,
  });
  logger.warn('provider-health: cooldown set', {
    provider, reason: classified.reason, cooldownMs: cooldown, consecutiveFailures: h.consecutiveFailures,
  });
}

/**
 * Soft cooldown from a usage-limit window (e.g. Claude 5h window at 97%).
 * Only ever EXTENDS a cooldown; success reports clear it as usual.
 */
export function setUsageWindowCooldown(provider: string, untilMs: number, label: string, usedPercent: number): void {
  if (!config.providerHealth.enabled || !provider) return;
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return;
  const h = getOrInit(provider);
  if (h.state === 'dead') return;
  if ((h.cooldownUntil ?? 0) >= untilMs && h.state === 'cooldown') return;  // already covered
  h.state = 'cooldown';
  h.cooldownUntil = Math.max(h.cooldownUntil ?? 0, untilMs);
  h.lastErrorClass = 'usage_window';
  h.lastErrorAt = Date.now();
  h.updatedAt = Date.now();
  persist(h);
  logHive('provider_cooldown_set', `provider-health: ${provider} ${label} window at ${usedPercent}% — soft cooldown until reset`, undefined, {
    provider, reason: 'usage_window', label, usedPercent, until: new Date(h.cooldownUntil).toISOString(),
  });
  logger.warn('provider-health: usage-window cooldown', { provider, label, usedPercent, until: new Date(untilMs).toISOString() });
}

export function isProviderAvailable(provider: string): boolean {
  if (!config.providerHealth.enabled) return true;
  loadAll();
  const h = health.get(provider);
  if (!h) return true;
  refresh(h);
  return h.state === 'ok';
}

export function getProviderHealth(provider: string): ProviderHealth | null {
  loadAll();
  const h = health.get(provider);
  return h ? { ...refresh(h) } : null;
}

export function getAllProviderHealth(): ProviderHealth[] {
  loadAll();
  return [...health.values()].map(h => ({ ...refresh(h) }));
}

/** Manual reset (dashboard) — clears cooldown/dead state for a provider. */
export function resetProviderHealth(provider: string): void {
  const h = getOrInit(provider);
  h.state = 'ok';
  h.cooldownUntil = null;
  h.consecutiveFailures = 0;
  h.updatedAt = Date.now();
  persist(h);
  logHive('provider_recovered', `provider-health: ${provider} manually reset`, undefined, { provider, manual: true });
}

/**
 * Reorder candidates by health: available providers keep their relative order
 * first; cooled providers sink to the end (soonest-recovering first); dead
 * last. NOTHING is removed — a fully-cooled roster still tries everything.
 */
export function orderByHealth<T>(candidates: T[], providerOf: (c: T) => string): T[] {
  if (!config.providerHealth.enabled || candidates.length <= 1) return candidates;
  loadAll();
  const rank = (c: T): number => {
    const h = health.get(providerOf(c));
    if (!h) return 0;
    refresh(h);
    if (h.state === 'ok') return 0;
    if (h.state === 'cooldown') return 1;
    return 2; // dead
  };
  const until = (c: T): number => health.get(providerOf(c))?.cooldownUntil ?? 0;
  // Stable sort: equal ranks keep caller-supplied order.
  return [...candidates]
    .map((c, i) => ({ c, i, r: rank(c), u: until(c) }))
    .sort((a, b) => (a.r - b.r) || (a.r === 1 ? a.u - b.u : 0) || (a.i - b.i))
    .map(x => x.c);
}

// ── Usage-window polling bridge ─────────────────────────────────────────────
// Low-frequency poll of the limit-window fetchers; windows at/over the
// threshold set a soft cooldown until their reset time. Providers covered:
// claude (OAuth subscription windows) and minimax (token_plan/remains).

let pollTimer: NodeJS.Timeout | null = null;

export async function pollUsageWindowsOnce(): Promise<void> {
  const threshold = config.providerHealth.windowThresholdPercent;
  const checks: Array<{ provider: string; fetch: () => Promise<{ ok: boolean; windows: Array<{ label: string; usedPercent: number; resetAt?: number }> }> }> = [
    { provider: 'claude',  fetch: async () => (await import('./claude-usage')).fetchClaudeUsage() },
    { provider: 'minimax', fetch: async () => (await import('./minimax-usage')).fetchMinimaxUsage() },
  ];
  for (const { provider, fetch } of checks) {
    try {
      const limits = await fetch();
      if (!limits.ok) continue;
      for (const w of limits.windows) {
        if (w.usedPercent >= threshold && w.resetAt && w.resetAt > Date.now()) {
          setUsageWindowCooldown(provider, w.resetAt, w.label, w.usedPercent);
        }
      }
    } catch (err) {
      logger.debug('provider-health: usage-window poll failed', {
        provider, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function startProviderHealthPolling(): void {
  if (!config.providerHealth.enabled) return;
  if (pollTimer) return;
  const intervalMs = config.providerHealth.pollMinutes * 60_000;
  // First poll shortly after boot (don't slow startup), then on the interval.
  setTimeout(() => { void pollUsageWindowsOnce(); }, 30_000).unref?.();
  pollTimer = setInterval(() => { void pollUsageWindowsOnce(); }, intervalMs);
  pollTimer.unref?.();
  logger.info('provider-health: usage-window polling started', {
    intervalMinutes: config.providerHealth.pollMinutes,
    thresholdPercent: config.providerHealth.windowThresholdPercent,
  });
}

export function stopProviderHealthPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
