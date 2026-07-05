// src/infra/kimi-usage.ts
// Kimi for Coding 5h/weekly limit windows. The Kimi Code CLI's own `/usage`
// command (kimi_cli/ui/shell/usage.py) hits GET <base>/v1/usages with a Bearer
// token; the plain KIMI_ANTHROPIC_KEY authenticates it just as well as the CLI's
// OAuth token, so no token-refresh dance is needed. Verified live 2026-06-09.
//
// Response shape:
//   { usage:  { limit, remaining, resetTime },                       // weekly
//     limits: [ { window:{duration,timeUnit}, detail:{limit,remaining,resetTime} } ] }  // 5h, etc.
// `limit`/`remaining` are strings; resetTime is ISO-8601.
import { logger } from '../utils/logger';
import { config } from '../config';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;

type Detail = { limit?: string | number; remaining?: string | number; used?: string | number; resetTime?: string };
type LimitEntry = { window?: { duration?: number; timeUnit?: string }; detail?: Detail };
type UsagesResponse = { usage?: Detail; limits?: LimitEntry[] };

function num(v: string | number | undefined): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function usedPercent(d: Detail): number {
  const limit = num(d.limit);
  let used = num(d.used);
  if (used == null) {
    const remaining = num(d.remaining);
    if (remaining != null && limit != null) used = limit - remaining;
  }
  if (used == null || limit == null || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

// Mirror the CLI's _limit_label: convert a window duration/timeUnit to "5h", "30m", "7d".
function windowLabel(w?: { duration?: number; timeUnit?: string }): string {
  const duration = w?.duration;
  const unit = w?.timeUnit ?? '';
  if (!duration) return 'Window';
  if (unit.includes('MINUTE')) return duration >= 60 && duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
  if (unit.includes('HOUR')) return `${duration}h`;
  if (unit.includes('DAY')) return `${duration}d`;
  return `${duration}s`;
}

function toWindow(label: string, d: Detail | undefined): LimitWindow | null {
  if (!d) return null;
  if (num(d.limit) == null && num(d.remaining) == null && num(d.used) == null) return null;
  return {
    label,
    usedPercent: usedPercent(d),
    resetAt: d.resetTime ? Date.parse(d.resetTime) || undefined : undefined,
  };
}

export async function fetchKimiUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const { baseURL, apiKey } = config.claude.gateways.kimi;
  if (!apiKey) return { ok: false, provider: 'kimi', windows: [], error: 'KIMI_ANTHROPIC_KEY not set' };
  const base = (baseURL || '').replace(/\/+$/, '');
  const url = process.env.KIMI_USAGE_URL?.trim() || `${base}/v1/usages`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('kimi-usage: fetch failed', { error: message });
    return { ok: false, provider: 'kimi', windows: [], error: `Network error: ${message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, provider: 'kimi', windows: [], error: `Auth error (${res.status}) — check KIMI_ANTHROPIC_KEY` };
  }
  if (res.status === 404) {
    return { ok: false, provider: 'kimi', windows: [], error: 'Usage endpoint not available (needs a Kimi for Coding plan)' };
  }
  if (!res.ok) return { ok: false, provider: 'kimi', windows: [], error: `HTTP ${res.status}` };

  let data: UsagesResponse;
  try {
    data = (await res.json()) as UsagesResponse;
  } catch {
    return { ok: false, provider: 'kimi', windows: [], error: 'Failed to parse response JSON' };
  }

  // Short rolling windows first (5h), then the weekly summary — matches the
  // codex/claude/minimax panels (5h above Weekly).
  const windows: LimitWindow[] = [];
  for (const entry of data.limits ?? []) {
    const w = toWindow(windowLabel(entry.window), entry.detail);
    if (w) windows.push(w);
  }
  const weekly = toWindow('Weekly', data.usage);
  if (weekly) windows.push(weekly);

  if (windows.length === 0) return { ok: false, provider: 'kimi', windows: [], error: 'no usage windows in response' };

  const value: ProviderLimits = { ok: true, provider: 'kimi', windows };
  cache = { at: Date.now(), value };
  return value;
}
