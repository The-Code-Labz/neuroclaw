// src/infra/claude-usage.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000; // the usage endpoint itself is rate-limited

let cache: { at: number; value: ProviderLimits } | null = null;

type Window = { utilization?: number | null; resets_at?: string | null } | null;
type UsageResponse = {
  five_hour?: Window;
  seven_day?: Window;
  seven_day_sonnet?: Window;
  seven_day_opus?: Window;
};

function readClaudeOauth(): { token: string; expired: boolean } | null {
  try {
    const f = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(f)) return null;
    const parsed = JSON.parse(fs.readFileSync(f, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const o = parsed.claudeAiOauth;
    if (!o?.accessToken) return null;
    return { token: o.accessToken, expired: typeof o.expiresAt === 'number' && o.expiresAt < Date.now() };
  } catch {
    return null;
  }
}

function toWindow(label: string, w: Window): LimitWindow | null {
  if (!w || w.utilization == null) return null;
  return {
    label,
    usedPercent: Math.min(100, Math.max(0, Math.round(w.utilization))),
    resetAt: w.resets_at ? Date.parse(w.resets_at) : undefined,
  };
}

export async function fetchClaudeUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const creds = readClaudeOauth();
  if (!creds) return { ok: false, provider: 'claude', windows: [], error: 'No Claude OAuth token — run `claude` to log in' };
  if (creds.expired) return { ok: false, provider: 'claude', windows: [], error: 'OAuth token expired — run `claude` to refresh' };

  let res: Response;
  try {
    res = await fetch(OAUTH_USAGE_URL, {
      headers: { Authorization: `Bearer ${creds.token}`, 'anthropic-beta': OAUTH_BETA, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('claude-usage: fetch failed', { error: message });
    return { ok: false, provider: 'claude', windows: [], error: `Network error: ${message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, provider: 'claude', windows: [], error: `Auth error (${res.status}) — token may be expired` };
  }
  if (!res.ok) return { ok: false, provider: 'claude', windows: [], error: `HTTP ${res.status}` };

  let data: UsageResponse;
  try {
    data = (await res.json()) as UsageResponse;
  } catch {
    return { ok: false, provider: 'claude', windows: [], error: 'Failed to parse response JSON' };
  }

  const windows = [
    toWindow('5h', data.five_hour ?? null),
    toWindow('Weekly', data.seven_day ?? null),
    toWindow('Weekly (Sonnet)', data.seven_day_sonnet ?? null),
    toWindow('Weekly (Opus)', data.seven_day_opus ?? null),
  ].filter((w): w is LimitWindow => w !== null);

  const value: ProviderLimits = { ok: true, provider: 'claude', windows };
  cache = { at: Date.now(), value };
  return value;
}
