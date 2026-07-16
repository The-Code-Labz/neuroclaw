// OpenArt OAuth 2.1 token manager.
//
// OpenArt exposes ONLY an MCP server (https://mcp.openart.ai/mcp), OAuth-gated.
// There is no API key and no REST image endpoint. Auth is a rotating refresh
// token, stored in the broker as SHARED_OPENART_REFRESH_TOKEN.
//
// TWO HARD AUTH RULES (learned the painful way during integration):
//   1. The refresh token ROTATES on every use — each refresh mints a new RT and
//      invalidates the old one.
//   2. OAuth 2.1 REUSE-DETECTION — presenting a *stale* RT revokes the ENTIRE
//      token family (access + all refresh), forcing a one-time human re-sign-in.
//
// So this manager MUST:
//   - read the CURRENT RT live from the broker at refresh time (never a boot-time
//     env snapshot — the value rotates, so config/SECRET_REGISTRY snapshotting
//     would silently present a stale RT and nuke the family),
//   - hold BOTH an in-process single-flight guard AND a cross-process file lock
//     around the read→refresh→write-back critical section (the CLI process and
//     the dashboard process are separate Node processes sharing one broker),
//   - write the rotated RT back to the broker BEFORE handing out the access token,
//   - notify the human (once) on a detected family revocation.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getStorage } from '../broker/storage';
import { logger } from '../utils/logger';

const CLIENT_ID  = process.env.OPENART_CLIENT_ID?.trim()  || '5wUuGDLn4m9MMNwh4FJU';
const TOKEN_URL  = process.env.OPENART_TOKEN_URL?.trim()  || 'https://openart.ai/suite/api/auth/oauth/token';
export const OPENART_MCP_URL = process.env.OPENART_MCP_URL?.trim() || 'https://mcp.openart.ai/mcp';
const RT_SECRET  = 'SHARED_OPENART_REFRESH_TOKEN';
const LOCK_PATH  = path.join(os.tmpdir(), 'nc-openart-refresh.lock');

interface TokenCache { accessToken: string; expiresAt: number }
let cache: TokenCache | null = null;
let inFlight: Promise<string> | null = null;
let configuredCache: boolean | null = null;
let notifiedRevocation = false;

/** Cross-process advisory lock around the RT read→refresh→write-back section.
 *  Both the dashboard and the CLI are separate processes sharing one broker;
 *  without this, two concurrent refreshes present the same RT and one gets
 *  invalid_grant → family revocation. Spins up to 30s; steals a >60s-stale lock. */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  let fd: number | null = null;
  while (Date.now() < deadline) {
    try { fd = fs.openSync(LOCK_PATH, 'wx'); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { const st = fs.statSync(LOCK_PATH); if (Date.now() - st.mtimeMs > 60_000) fs.unlinkSync(LOCK_PATH); } catch { /* race — ignore */ }
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (fd === null) throw new Error('openart: could not acquire refresh lock within 30s');
  try { return await fn(); }
  finally { try { fs.closeSync(fd); } catch { /* ignore */ } try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ } }
}

async function notifyRevocation(): Promise<void> {
  if (notifiedRevocation) return;
  notifiedRevocation = true;
  try {
    const { createAgentUserMessage } = await import('../db');
    createAgentUserMessage({
      fromAgentId: 'openart',
      fromName: 'OpenArt',
      kind: 'alert',
      body: 'OpenArt authentication expired — the refresh-token family was revoked. Image generate/edit via OpenArt is disabled until you re-run the one-time OpenArt sign-in.',
      metadata: { context: 'OAuth 2.1 reuse-detection revoked the token family. Ask Oracle to regenerate the OpenArt authorize link.' },
    });
  } catch (err) {
    logger.warn('openart: notifyRevocation failed', { error: (err as Error).message });
  }
}

/** The read→refresh→write-back critical section. Runs inside the cross-process
 *  lock so the RT is read fresh (in case a peer rotated it while we waited). */
async function doRefresh(): Promise<string> {
  return withRefreshLock(async () => {
    const store = getStorage();
    const rt = (await store.getValue(RT_SECRET))?.trim();
    if (!rt) throw new Error('OpenArt not configured: SHARED_OPENART_REFRESH_TOKEN missing from broker');

    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID });
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'neuroclaw/1.4 (+openart)' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      if (/invalid_grant/i.test(text)) {
        await notifyRevocation();
        throw new Error('OpenArt refresh token revoked (invalid_grant) — re-authentication required.');
      }
      throw new Error(`OpenArt token refresh failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
    }
    let tok: { access_token?: string; expires_in?: number; refresh_token?: string };
    try { tok = JSON.parse(text); } catch { throw new Error('OpenArt token refresh: response was not JSON'); }
    if (!tok.access_token || !tok.refresh_token) throw new Error('OpenArt token refresh: missing access/refresh token');

    // WRITE-BACK the rotated RT BEFORE returning the access token. If this fails,
    // do NOT hand out the access token — the next refresh would present a stale RT.
    await store.update(RT_SECRET, { value: tok.refresh_token });
    // Compare-and-check: confirm our write is what's stored (a peer could have
    // rotated concurrently despite the lock on a foreign backend). If it drifted,
    // discard and force the caller to refresh from the now-current RT.
    const readback = (await store.getValue(RT_SECRET))?.trim();
    if (readback !== tok.refresh_token) {
      cache = null;
      throw new Error('openart_concurrent_rotation');
    }

    notifiedRevocation = false; // healthy again
    cache = { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
    return tok.access_token;
  });
}

/** Return a valid OpenArt access token, refreshing on demand.
 *  `force` bypasses the cache (used by the client's one-shot 401 retry). */
export async function getOpenArtAccessToken(force = false): Promise<string> {
  if (!force && cache && Date.now() < cache.expiresAt - 60_000) return cache.accessToken;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await doRefresh();
    } catch (err) {
      // One transparent retry on the concurrent-rotation signal (a peer beat us).
      if (err instanceof Error && err.message === 'openart_concurrent_rotation') {
        return await doRefresh();
      }
      throw err;
    } finally {
      // Self-clear so a transient failure never wedges every future call behind
      // a permanently-rejected promise.
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Is OpenArt configured (a refresh token exists in the broker)?
 *  Cached; prime it once at boot via primeOpenArtConfigured(). Single source of
 *  truth — config.openart.enabled delegates here. */
export function openartConfigured(): boolean {
  return configuredCache === true;
}

/** Async boot prime for openartConfigured(). Hooked into the same fire-and-forget
 *  broker-resolution chain as the other providers (server.ts). Reads the RT
 *  presence LIVE from the broker — never snapshotted into process.env. */
export async function primeOpenArtConfigured(): Promise<boolean> {
  try {
    const rt = (await getStorage().getValue(RT_SECRET))?.trim();
    configuredCache = !!(rt && rt.length > 20);
  } catch {
    configuredCache = false;
  }
  return configuredCache;
}
