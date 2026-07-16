// src/infra/openrouter-usage.ts
// OpenRouter prepaid credit balance. Unlike the CLI-subscription surfaces this is
// a plain authenticated REST call — no PTY, no OAuth refresh, returns instantly.
//   GET https://openrouter.ai/api/v1/credits
//     Authorization: Bearer $OPENROUTER_API_KEY
//   → { data: { total_credits: 50, total_usage: 40.96 } }
// It's a balance, not a resetting window, so we render one "Credits" bar
// (used = total_usage / total_credits) with the remaining dollar amount as the
// note. Matters because OpenRouter is the primary BG/vision/skill-forge lane now.
// Verified live 2026-07-08.
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;

function apiKey(): string {
  return process.env.OPENROUTER_API_KEY?.trim() || '';
}
function baseURL(): string {
  return process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';
}

type CreditsResponse = { data?: { total_credits?: number; total_usage?: number } };

export async function fetchOpenRouterUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const key = apiKey();
  if (!key) return { ok: false, provider: 'openrouter', windows: [], error: 'No OPENROUTER_API_KEY set' };

  let res: Response;
  try {
    res = await fetch(`${baseURL()}/credits`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('openrouter-usage: fetch failed', { error: message });
    return { ok: false, provider: 'openrouter', windows: [], error: `Network error: ${message}` };
  }

  if (!res.ok) return { ok: false, provider: 'openrouter', windows: [], error: `HTTP ${res.status}` };

  let data: CreditsResponse;
  try {
    data = (await res.json()) as CreditsResponse;
  } catch {
    return { ok: false, provider: 'openrouter', windows: [], error: 'Failed to parse response JSON' };
  }

  const total = data.data?.total_credits;
  const used = data.data?.total_usage;
  if (typeof total !== 'number' || typeof used !== 'number' || total <= 0) {
    return { ok: false, provider: 'openrouter', windows: [], error: 'no credit balance in response' };
  }

  const usedPercent = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  const remaining = total - used;
  const windows: LimitWindow[] = [{ label: 'Credits', usedPercent }];

  const value: ProviderLimits = { ok: true, provider: 'openrouter', windows };
  value.note = `$${remaining.toFixed(2)} left of $${total.toFixed(2)}`;
  cache = { at: Date.now(), value };
  return value;
}
