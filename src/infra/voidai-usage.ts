// src/infra/voidai-usage.ts
// VoidAI daily credit window. Plain authenticated REST — instant, no PTY/OAuth.
//   GET https://api.voidai.app/v1/credits
//     Authorization: Bearer $VOIDAI_API_KEY
//   → { current_credits, daily_limit, credits_used, vault_credits,
//       reset_time, plan, reset_cycle_days }
// The meaningful window is the *daily* allowance: used = daily_limit -
// current_credits, resets at reset_time (~daily). vault_credits is a separate
// long-term pool surfaced as the note. Verified live 2026-07-08.
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;

function apiKey(): string {
  return process.env.VOIDAI_API_KEY?.trim() || '';
}
function baseURL(): string {
  return process.env.VOIDAI_BASE_URL?.trim() || 'https://api.voidai.app/v1';
}

type CreditsResponse = {
  current_credits?: number;
  daily_limit?: number;
  vault_credits?: number;
  reset_time?: string;
  plan?: string;
};

export async function fetchVoidaiUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const key = apiKey();
  if (!key) return { ok: false, provider: 'voidai', windows: [], error: 'No VOIDAI_API_KEY set' };

  let res: Response;
  try {
    res = await fetch(`${baseURL()}/credits`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('voidai-usage: fetch failed', { error: message });
    return { ok: false, provider: 'voidai', windows: [], error: `Network error: ${message}` };
  }

  if (!res.ok) return { ok: false, provider: 'voidai', windows: [], error: `HTTP ${res.status}` };

  let data: CreditsResponse;
  try {
    data = (await res.json()) as CreditsResponse;
  } catch {
    return { ok: false, provider: 'voidai', windows: [], error: 'Failed to parse response JSON' };
  }

  const limit = data.daily_limit;
  const current = data.current_credits;
  if (typeof limit !== 'number' || typeof current !== 'number' || limit <= 0) {
    return { ok: false, provider: 'voidai', windows: [], error: 'no daily credit info in response' };
  }

  const usedPercent = Math.min(100, Math.max(0, Math.round(((limit - current) / limit) * 100)));
  const windows: LimitWindow[] = [{
    label: 'Daily',
    usedPercent,
    resetAt: data.reset_time ? Date.parse(data.reset_time) || undefined : undefined,
  }];

  const value: ProviderLimits = { ok: true, provider: 'voidai', windows };
  const fmt = (n: number) => n.toLocaleString('en-US');
  const notes = [`${fmt(current)}/${fmt(limit)} daily`];
  if (typeof data.vault_credits === 'number' && data.vault_credits > 0) notes.push(`vault ${fmt(data.vault_credits)}`);
  value.note = notes.join(' · ');
  if (data.plan) (value as { plan?: string }).plan = data.plan;
  cache = { at: Date.now(), value };
  return value;
}
