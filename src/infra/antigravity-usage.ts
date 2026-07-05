// src/infra/antigravity-usage.ts
// Antigravity (Google's) quota windows. The agy CLI's `/usage` one-shot hangs
// (interactive REPL only), so we hit the same backend it does directly:
// Google Code Assist's private API, cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota.
//
// Auth is Google OAuth (NOT a static key): the stored token at
// ~/.gemini/antigravity-cli/antigravity-oauth-token expires hourly, so we
// refresh it on demand from its refresh_token using agy's embedded OAuth client.
// retrieveUserQuota → { buckets:[{ modelId, tokenType, remainingFraction, resetTime }] }.
// Verified live 2026-06-10.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// agy's embedded "consumer" OAuth client (overridable in case it rotates).
const CLIENT_ID = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim()
  || ''; // no fallback: env-only (agy client is dead/ToS-banned)
const CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim()
  || ''; // no fallback: env-only
const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;

function tokenFilePath(): string {
  return process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE?.trim()
    || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

function readRefreshToken(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFilePath(), 'utf-8')) as { token?: { refresh_token?: string } };
    return raw.token?.refresh_token ?? null;
  } catch {
    return null;
  }
}

async function refreshAccessToken(refreshToken: string, timeoutMs: number): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn('antigravity-usage: token refresh failed', { status: res.status });
      return null;
    }
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch (err) {
    logger.warn('antigravity-usage: token refresh error', { error: (err as Error).message });
    return null;
  }
}

type QuotaBucket = { modelId?: string; tokenType?: string; remainingFraction?: number; resetTime?: string };
type QuotaResponse = { buckets?: QuotaBucket[] };

// "gemini-2.5-flash-lite" → "2.5-flash-lite" so the panel labels stay short.
function shortModel(id: string): string {
  return id.replace(/^gemini-/, '');
}

export async function fetchAntigravityUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const refreshToken = readRefreshToken();
  if (!refreshToken) {
    return { ok: false, provider: 'antigravity', windows: [], error: 'No Antigravity OAuth token — run `agy` to log in' };
  }

  const accessToken = await refreshAccessToken(refreshToken, timeoutMs);
  if (!accessToken) {
    return { ok: false, provider: 'antigravity', windows: [], error: 'OAuth refresh failed — run `agy` to re-authenticate' };
  }

  let res: Response;
  try {
    res = await fetch(QUOTA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('antigravity-usage: quota fetch failed', { error: message });
    return { ok: false, provider: 'antigravity', windows: [], error: `Network error: ${message}` };
  }

  if (!res.ok) return { ok: false, provider: 'antigravity', windows: [], error: `HTTP ${res.status}` };

  let data: QuotaResponse;
  try {
    data = (await res.json()) as QuotaResponse;
  } catch {
    return { ok: false, provider: 'antigravity', windows: [], error: 'Failed to parse response JSON' };
  }

  const windows: LimitWindow[] = (data.buckets ?? [])
    .filter(b => b.modelId && typeof b.remainingFraction === 'number')
    .map(b => ({
      label: shortModel(b.modelId!),
      usedPercent: Math.min(100, Math.max(0, Math.round((1 - (b.remainingFraction as number)) * 100))),
      resetAt: b.resetTime ? Date.parse(b.resetTime) || undefined : undefined,
    }));

  if (windows.length === 0) return { ok: false, provider: 'antigravity', windows: [], error: 'no quota buckets in response' };

  const value: ProviderLimits = { ok: true, provider: 'antigravity', windows };
  cache = { at: Date.now(), value };
  return value;
}
