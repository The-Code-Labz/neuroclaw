import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface XaiCredentials {
  bearer:  string;
  baseUrl: string;
}

const HERMES_PROXY_URL = 'http://127.0.0.1:8645/v1';

// Returns expiry epoch (seconds) from a JWT access token, or 0 if not decodable.
function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

function readFromAuthJson(): XaiCredentials | null {
  try {
    const authPath = join(homedir(), '.hermes', 'auth.json');
    const store    = JSON.parse(readFileSync(authPath, 'utf-8'));
    const pool     = store?.credential_pool?.['xai-oauth'];
    if (Array.isArray(pool) && pool.length > 0) {
      const entry = pool.find((e: Record<string, unknown>) =>
        e.last_status === 'ok' && typeof e.access_token === 'string' && e.access_token
      ) ?? pool[0];
      const bearer  = String(entry.access_token ?? '').trim();
      const baseUrl = String(entry.base_url ?? 'https://api.x.ai/v1').trim().replace(/\/$/, '');
      if (bearer) return { bearer, baseUrl };
    }
  } catch {
    // auth.json missing or malformed
  }
  return null;
}

// Pings the Hermes proxy (if reachable) to force an OAuth token refresh, then
// re-reads auth.json so subsequent direct xAI calls use the fresh token.
// The xAI OAuth tokens are 6-hour JWTs; Hermes refreshes them transparently
// when a proxied request is made — this call piggybacks on that mechanism.
async function triggerHermesRefresh(): Promise<void> {
  try {
    const res = await fetch(`${HERMES_PROXY_URL}/models`, {
      headers: { Authorization: 'Bearer hermes-refresh-ping' },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok && res.status !== 401) return; // proxy reached; ignore non-auth errors
  } catch {
    // Proxy not running — no-op
  }
}

// Resolves xAI credentials, refreshing via the Hermes proxy if the stored
// JWT is expired or within 5 minutes of expiry. Falls back to XAI_API_KEY.
export async function resolveXaiCredentials(): Promise<XaiCredentials | null> {
  const envKey = process.env.XAI_API_KEY?.trim();
  if (envKey) return { bearer: envKey, baseUrl: 'https://api.x.ai/v1' };

  const stored = readFromAuthJson();
  if (stored) {
    const exp = jwtExpiry(stored.bearer);
    const expiresInSec = exp - Math.floor(Date.now() / 1000);
    if (exp > 0 && expiresInSec < 300) {
      // Token expired or within 5 min — ping proxy to refresh, then re-read.
      await triggerHermesRefresh();
      const refreshed = readFromAuthJson();
      if (refreshed) return refreshed;
    }
    return stored;
  }

  return null;
}
