// src/infra/venice-usage.ts
// Venice account balance + daily epoch reset. Plain authenticated REST — no PTY, instant.
//   GET https://api.venice.ai/api/v1/api_keys/rate_limits
//     Authorization: Bearer $VENICE_API_KEY
//   → JSON: { data: { balances: { USD, DIEM }, apiTier: {id,isCharged},
//                     nextEpochBegins: ISO8601, keyExpiration } }
//
// Verified live 2026-07-14: USD 10.079, tier "paid", nextEpochBegins the daily
// reset boundary. Unlike KIE/fal, Venice exposes a real reset timestamp, so we
// render a proper window (USD balance drain + daily reset countdown) instead of a
// bare high-water gauge. USD is a capless prepaid balance → high-water-mark drain
// gauge, absolute value in the note.
import { logger } from '../utils/logger';
import { config } from '../config';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;
let peakBalance = 0; // high-water mark for the drain gauge (process lifetime)

export async function fetchVeniceUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const { apiKey, baseURL } = config.venice;
  if (!apiKey) return { ok: false, provider: 'venice', windows: [], error: 'No VENICE_API_KEY set' };

  let res: Response;
  try {
    res = await fetch(`${baseURL}/api_keys/rate_limits`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('venice-usage: fetch failed', { error: message });
    return { ok: false, provider: 'venice', windows: [], error: `Network error: ${message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, provider: 'venice', windows: [], error: `auth rejected (${res.status})` };
  }
  if (!res.ok) return { ok: false, provider: 'venice', windows: [], error: `HTTP ${res.status}` };

  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, provider: 'venice', windows: [], error: 'Failed to parse response' };
  }

  const data = body?.data ?? body;
  const balance = Number(data?.balances?.USD);
  if (!Number.isFinite(balance)) {
    return { ok: false, provider: 'venice', windows: [], error: 'no USD balance in response' };
  }

  // Optional daily reset boundary → attach to the window as resetAt.
  let resetAt: number | undefined;
  const nextEpoch = data?.nextEpochBegins;
  if (typeof nextEpoch === 'string') {
    const t = Date.parse(nextEpoch);
    if (Number.isFinite(t)) resetAt = t;
  }

  peakBalance = Math.max(peakBalance, balance);
  const usedPercent = peakBalance > 0
    ? Math.min(100, Math.max(0, Math.round(((peakBalance - balance) / peakBalance) * 100)))
    : 0;
  const window: LimitWindow = { label: 'Balance', usedPercent };
  if (resetAt) window.resetAt = resetAt;
  const windows: LimitWindow[] = [window];

  const tier = typeof data?.apiTier?.id === 'string' ? data.apiTier.id : null;
  const value: ProviderLimits = { ok: true, provider: 'venice', windows };
  value.note = `$${balance.toFixed(2)} left${tier ? ` · ${tier} tier` : ''}`;
  cache = { at: Date.now(), value };
  return value;
}
