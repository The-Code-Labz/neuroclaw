// Higgsfield OAuth 2.1 token manager.
//
// Higgsfield exposes an OAuth-gated MCP server (https://mcp.higgsfield.ai/mcp).
// There is no API key. Auth is a rotating refresh token, stored in the broker as
// SHARED_HIGGSFIELD_REFRESH_TOKEN. The client was created via dynamic client
// registration (public PKCE client, no secret).
//
// This mirrors src/infra/openart-auth.ts — the SAME rotating-refresh-token flow,
// which means the SAME two hard rules apply:
//   1. The refresh token ROTATES on every use — each refresh mints a new RT and
//      invalidates the old one.
//   2. OAuth 2.1 REUSE-DETECTION — presenting a *stale* RT revokes the ENTIRE
//      token family, forcing a one-time human re-sign-in.
//
// So this manager MUST:
//   - read the CURRENT RT live from the broker at refresh time (never a boot-time
//     env snapshot — the value rotates),
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

const CLIENT_ID  = process.env.HIGGSFIELD_CLIENT_ID?.trim()  || 'SmaNEDl8PtPUH4Cf';
const TOKEN_URL  = process.env.HIGGSFIELD_TOKEN_URL?.trim()  || 'https://mcp.higgsfield.ai/oauth2/token';
export const HIGGSFIELD_MCP_URL = process.env.HIGGSFIELD_MCP_URL?.trim() || 'https://mcp.higgsfield.ai/mcp';
const RT_SECRET  = 'SHARED_HIGGSFIELD_REFRESH_TOKEN';
const LOCK_PATH  = path.join(os.tmpdir(), 'nc-higgsfield-refresh.lock');

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
  if (fd === null) throw new Error('higgsfield: could not acquire refresh lock within 30s');
  try { return await fn(); }
  finally { try { fs.closeSync(fd); } catch { /* ignore */ } try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ } }
}

async function notifyRevocation(): Promise<void> {
  if (notifiedRevocation) return;
  notifiedRevocation = true;
  try {
    const { createAgentUserMessage } = await import('../db');
    createAgentUserMessage({
      fromAgentId: 'higgsfield',
      fromName: 'Higgsfield',
      kind: 'alert',
      body: 'Higgsfield authentication expired — the refresh-token family was revoked. Image/video/audio generation via Higgsfield is disabled until you re-run the one-time Higgsfield sign-in.',
      metadata: { context: 'OAuth 2.1 reuse-detection revoked the token family. Ask Oracle to regenerate the Higgsfield authorize link.' },
    });
  } catch (err) {
    logger.warn('higgsfield: notifyRevocation failed', { error: (err as Error).message });
  }
}

/** The read→refresh→write-back critical section. Runs inside the cross-process
 *  lock so the RT is read fresh (in case a peer rotated it while we waited). */
async function doRefresh(): Promise<string> {
  return withRefreshLock(async () => {
    const store = getStorage();
    const rt = (await store.getValue(RT_SECRET))?.trim();
    if (!rt) throw new Error('Higgsfield not configured: SHARED_HIGGSFIELD_REFRESH_TOKEN missing from broker');

    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID });
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'neuroclaw/1.4 (+higgsfield)' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      if (/invalid_grant/i.test(text)) {
        await notifyRevocation();
        throw new Error('Higgsfield refresh token revoked (invalid_grant) — re-authentication required.');
      }
      throw new Error(`Higgsfield token refresh failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
    }
    let tok: { access_token?: string; expires_in?: number; refresh_token?: string };
    try { tok = JSON.parse(text); } catch { throw new Error('Higgsfield token refresh: response was not JSON'); }
    if (!tok.access_token) throw new Error('Higgsfield token refresh: missing access token');

    // WRITE-BACK the rotated RT BEFORE returning the access token. If this fails,
    // do NOT hand out the access token — the next refresh would present a stale RT.
    // (Some servers omit refresh_token on refresh when it hasn't rotated; only
    //  write-back when a NEW one is actually returned.)
    if (tok.refresh_token && tok.refresh_token !== rt) {
      await store.update(RT_SECRET, { value: tok.refresh_token });
      const readback = (await store.getValue(RT_SECRET))?.trim();
      if (readback !== tok.refresh_token) {
        cache = null;
        throw new Error('higgsfield_concurrent_rotation');
      }
    }

    notifiedRevocation = false; // healthy again
    cache = { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
    return tok.access_token;
  });
}

/** Return a valid Higgsfield access token, refreshing on demand.
 *  `force` bypasses the cache (used by the client's one-shot 401 retry). */
export async function getHiggsfieldAccessToken(force = false): Promise<string> {
  if (!force && cache && Date.now() < cache.expiresAt - 60_000) return cache.accessToken;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await doRefresh();
    } catch (err) {
      if (err instanceof Error && err.message === 'higgsfield_concurrent_rotation') {
        return await doRefresh();
      }
      throw err;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Is Higgsfield configured (a refresh token exists in the broker)?
 *  Cached; prime it once at boot via primeHiggsfieldConfigured(). Single source of
 *  truth — config.higgsfield.enabled delegates here. */
export function higgsfieldConfigured(): boolean {
  return configuredCache === true;
}

/** Async boot prime for higgsfieldConfigured(). Reads the RT presence LIVE from
 *  the broker — never snapshotted into process.env. */
export async function primeHiggsfieldConfigured(): Promise<boolean> {
  try {
    const rt = (await getStorage().getValue(RT_SECRET))?.trim();
    configuredCache = !!(rt && rt.length > 20);
  } catch {
    configuredCache = false;
  }
  return configuredCache;
}
