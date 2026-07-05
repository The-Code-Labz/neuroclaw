// src/infra/minimax-usage.ts
import { logger } from '../utils/logger';
import { config } from '../config';
import type { ProviderLimits } from './provider-limits';

const DEFAULT_HOST = 'https://www.minimax.io';
const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;

type ModelRemain = {
  model_name?: string;
  current_interval_remaining_percent?: number;
  end_time?: number;
  current_weekly_remaining_percent?: number;
  weekly_end_time?: number;
};
type RemainsResponse = {
  model_remains?: ModelRemain[];
  base_resp?: { status_code?: number; status_msg?: string };
};

function usedFromRemaining(remainingPercent?: number): number {
  if (remainingPercent == null) return 0;
  return Math.min(100, Math.max(0, Math.round(100 - remainingPercent)));
}

export async function fetchMinimaxUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const apiKey = config.claude.gateways.minimax.apiKey;
  if (!apiKey) return { ok: false, provider: 'minimax', windows: [], error: 'MINIMAX_ANTHROPIC_KEY not set' };
  const host = process.env.MINIMAX_USAGE_HOST?.trim() || DEFAULT_HOST;

  let res: Response;
  try {
    res = await fetch(`${host}/v1/token_plan/remains`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('minimax-usage: fetch failed', { error: message });
    return { ok: false, provider: 'minimax', windows: [], error: `Network error: ${message}` };
  }

  if (!res.ok) return { ok: false, provider: 'minimax', windows: [], error: `HTTP ${res.status}` };

  let data: RemainsResponse;
  try {
    data = (await res.json()) as RemainsResponse;
  } catch {
    return { ok: false, provider: 'minimax', windows: [], error: 'Failed to parse response JSON' };
  }

  if (data.base_resp && data.base_resp.status_code !== 0) {
    return { ok: false, provider: 'minimax', windows: [], error: data.base_resp.status_msg || `status ${data.base_resp.status_code}` };
  }

  const general = data.model_remains?.find(m => m.model_name === 'general') ?? data.model_remains?.[0];
  if (!general) return { ok: false, provider: 'minimax', windows: [], error: 'no model_remains rows' };

  const value: ProviderLimits = {
    ok: true,
    provider: 'minimax',
    windows: [
      { label: '5h',     usedPercent: usedFromRemaining(general.current_interval_remaining_percent), resetAt: general.end_time },
      { label: 'Weekly', usedPercent: usedFromRemaining(general.current_weekly_remaining_percent),  resetAt: general.weekly_end_time },
    ],
  };
  cache = { at: Date.now(), value };
  return value;
}
