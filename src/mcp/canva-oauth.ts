/**
 * mcp/canva-oauth.ts — OAuth 2.1 + PKCE handling for the official Canva MCP
 * server (https://www.canva.dev/docs/mcp/).
 *
 * Canva's MCP is per-user OAuth ONLY — there is no service-account / org-level
 * auth (confirmed in their troubleshooting docs). This module implements the
 * authorization_code + refresh_token dance against the endpoints published at
 * https://mcp.canva.com/.well-known/oauth-authorization-server (verified live
 * 2026-07-14):
 *   authorize:    https://mcp.canva.com/authorize
 *   token:        https://mcp.canva.com/token
 *   register(DCR): https://mcp.canva.com/register
 *   PKCE:         S256 supported (we always use it — Canva is a public client
 *                 from our side since token_endpoint_auth_method can be 'none',
 *                 but we register confidential (client_secret_basic) via DCR
 *                 and still layer PKCE for defense in depth).
 *
 * REDIRECT URI — Path A (loopback + manual code paste), confirmed 2026-07-15:
 * Canva's /authorize step REJECTS any non-loopback redirect_uri host with
 * HTTP 400 "Invalid redirect URI. It must be from an allowed host." — this is
 * RFC-8252 native-app behavior (DCR is open registration, so Canva restricts
 * it to loopback/localhost to prevent open-redirect abuse). Verified live:
 * an https://<our-public-domain>/... redirect_uri → 400 at /authorize; a
 * http://127.0.0.1:<port>/callback redirect_uri → 302 straight through to
 * Canva login. Port MISMATCH between the registered redirect_uri and the one
 * sent at /authorize was tolerated in testing (RFC-8252 loopback semantics —
 * Canva appears to match host+path, not port) but we always send the exact
 * same CANVA_LOOPBACK_REDIRECT_URI both at DCR-register time and at
 * /authorize time to stay on the documented-safe path regardless.
 *
 * Nothing actually listens on that loopback port — Path A does not run a
 * local HTTP server. The operator's OWN browser is redirected there after
 * consent, fails to connect (expected — there's nothing to connect to), and
 * the operator copies the failed URL (which still carries ?code=&state= in
 * the address bar) and pastes it into the Connect card. See
 * completeAuthorize() below, invoked from the new
 * POST /api/oauth/canva/exchange route (routes.ts) instead of a server-side
 * GET callback.
 *
 * Credential handling: client_id/client_secret and the live access/refresh
 * tokens are broker secrets (see broker/bootstrap.ts SECRET_REGISTRY:
 * CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, CANVA_ACCESS_TOKEN, CANVA_REFRESH_TOKEN,
 * CANVA_TOKEN_EXPIRES_AT) — never hardcoded, never written to .env by this
 * module directly. Refresh writes go through getStorage().update() so the
 * broker stays the source of truth across restarts.
 */
import crypto from 'crypto';
import { getStorage } from '../broker/storage';
import { logger } from '../utils/logger';
import { getMcpServerByName, updateMcpServer, createMcpServer } from '../db';
import { probeServer } from './mcp-registry';

const CANVA_AUTH_BASE  = 'https://mcp.canva.com';
export const CANVA_MCP_URL      = `${CANVA_AUTH_BASE}/mcp`;
export const CANVA_AUTHORIZE_URL = `${CANVA_AUTH_BASE}/authorize`;
export const CANVA_TOKEN_URL     = `${CANVA_AUTH_BASE}/token`;
export const CANVA_REGISTER_URL  = `${CANVA_AUTH_BASE}/register`;

// Fixed loopback redirect_uri for Path A — see module header. Not derived
// from config.dashboard.publicUrl anymore (that was the rejected public-HTTPS
// strategy). Port is arbitrary (nothing listens on it) but held constant so
// the DCR-registered URI and the /authorize URI always match exactly.
export const CANVA_LOOPBACK_REDIRECT_URI = 'http://127.0.0.1:51820/callback';

// Scopes needed for the generative surface this integration targets:
// create-design (design:content:write), search-brand-templates + apply
// (brandtemplate:*), get-design-content (design:content:read), export
// (design:content:read), asset upload (asset:write), plus baseline
// profile/meta reads. NOT requesting comment:* or help:* — unused here.
export const CANVA_SCOPES = [
  'profile:read',
  'design:meta:read',
  'design:content:read',
  'design:content:write',
  'brandtemplate:meta:read',
  'brandtemplate:content:read',
  'asset:read',
  'asset:write',
  'folder:read',
].join(' ');

// ── Transient PKCE state (authorize → callback round trip only; NOT a
// long-lived credential, in-memory is correct here) ────────────────────────
interface PendingAuth { codeVerifier: string; createdAt: number; }
const pending = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60_000; // 10 minutes to complete the browser consent

function sweepPending(): void {
  const now = Date.now();
  for (const [state, p] of pending) {
    if (now - p.createdAt > PENDING_TTL_MS) pending.delete(state);
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CanvaOAuthConfig {
  clientId:     string;
  clientSecret: string;
  redirectUri:  string;
}

export function getCanvaOAuthConfig(): CanvaOAuthConfig | null {
  const clientId     = process.env.CANVA_CLIENT_ID?.trim();
  const clientSecret = process.env.CANVA_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: CANVA_LOOPBACK_REDIRECT_URI,
  };
}

/** DCR self-registration against Canva's /register endpoint, followed by an
 *  immediate persist of the returned client_id/secret to the broker AND the
 *  live process.env — this is the single authoritative write path (the
 *  Settings card no longer POSTs the creds separately via the generic broker
 *  admin endpoints). Mirrors persistTokens()'s "broker is source of truth,
 *  process.env is the hot cache" pattern below, so config.canva.configured
 *  flips true within this same request and the operator goes straight from
 *  Register to Connect with no restart. Confirmed live 2026-07-14 — no
 *  waitlist approval required for this path (that waitlist gates something
 *  else, likely public-directory listing / CIMD featuring).
 *  Returns null on failure; caller decides whether to surface to the operator. */
export async function registerDcrClient(redirectUri: string, clientName = 'NeuroClaw'): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const res = await fetch(CANVA_REGISTER_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name:   clientName,
        redirect_uris: [redirectUri],
        grant_types:   ['authorization_code', 'refresh_token'],
      }),
    });
    if (!res.ok) {
      logger.warn('canva-oauth: DCR registration failed', { status: res.status, body: await res.text().catch(() => '') });
      return null;
    }
    const data = await res.json() as { client_id: string; client_secret: string };
    const clientId = data.client_id;
    const clientSecret = data.client_secret;

    const storage = getStorage();
    await writeSecret(storage, 'CANVA_CLIENT_ID', clientId);
    await writeSecret(storage, 'CANVA_CLIENT_SECRET', clientSecret);
    process.env.CANVA_CLIENT_ID = clientId;
    process.env.CANVA_CLIENT_SECRET = clientSecret;
    logger.info('canva-oauth: DCR client registered and persisted to broker');

    return { clientId, clientSecret };
  } catch (err) {
    logger.warn('canva-oauth: DCR registration errored', { err: (err as Error).message });
    return null;
  }
}

export interface AuthorizeStart {
  url:   string;
  state: string;
}

/** Build the browser-facing authorize URL (PKCE S256 + CSRF state). The
 *  operator must open `url` in a browser and complete Canva's own login +
 *  consent screen — this cannot be automated headlessly (Canva requires
 *  per-user interactive consent by design; see their troubleshooting docs). */
export function startAuthorize(): AuthorizeStart | null {
  const oauth = getCanvaOAuthConfig();
  if (!oauth) return null;
  sweepPending();

  const codeVerifier  = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));
  pending.set(state, { codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    scope: CANVA_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url: `${CANVA_AUTHORIZE_URL}?${params.toString()}`, state };
}

interface TokenResponse {
  access_token:  string;
  refresh_token?: string;
  expires_in?:    number;
  token_type?:    string;
  scope?:         string;
}

async function persistTokens(tok: TokenResponse): Promise<void> {
  const storage = getStorage();
  const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : '';

  // Broker is the source of truth; process.env is the hot cache read by
  // config/db/probeServer. Write both so a refresh takes effect immediately
  // without waiting for a restart, and survives one.
  await writeSecret(storage, 'CANVA_ACCESS_TOKEN', tok.access_token);
  process.env.CANVA_ACCESS_TOKEN = tok.access_token;
  if (tok.refresh_token) {
    await writeSecret(storage, 'CANVA_REFRESH_TOKEN', tok.refresh_token);
    process.env.CANVA_REFRESH_TOKEN = tok.refresh_token;
  }
  if (expiresAt) {
    await writeSecret(storage, 'CANVA_TOKEN_EXPIRES_AT', expiresAt);
    process.env.CANVA_TOKEN_EXPIRES_AT = expiresAt;
  }

  await syncMcpServerRow(tok.access_token);
}

async function writeSecret(storage: ReturnType<typeof getStorage>, name: string, value: string): Promise<void> {
  try {
    await storage.update(name, { value });
  } catch {
    // update() throws if the secret doesn't exist yet under some adapters —
    // fall back to create.
    try { await storage.create(name, value, { tags: ['canva', 'oauth'], notes: 'Managed by canva-oauth.ts — do not edit by hand.' }); }
    catch (err) { logger.error(`canva-oauth: failed to persist ${name} to broker`, { err: (err as Error).message }); }
  }
}

/** Idempotent upsert of the 'canva' mcp_servers row with a fresh bearer header. */
async function syncMcpServerRow(accessToken: string): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const existing = getMcpServerByName('canva');
  if (existing) {
    updateMcpServer(existing.id, { headers, enabled: true });
    await probeServer(existing.id);
  } else {
    const row = createMcpServer({ name: 'canva', url: CANVA_MCP_URL, transport: 'http', headers, enabled: true });
    await probeServer(row.id);
  }
}

/** Exchange an authorization code for tokens, validating `state` against the
 *  in-memory PKCE record from startAuthorize(). Called from the operator-
 *  facing POST /api/oauth/canva/exchange route (routes.ts) with the code and
 *  state the operator pasted in from the failed loopback redirect — see
 *  module header (Path A). `state` is deleted from `pending` on lookup
 *  whether or not the exchange below succeeds, so a stale/replayed state can
 *  never be reused. */
export async function completeAuthorize(code: string, state: string): Promise<{ ok: true } | { ok: false; error: string }> {
  sweepPending();
  const oauth = getCanvaOAuthConfig();
  if (!oauth) return { ok: false, error: 'canva_oauth_not_configured' };

  const p = pending.get(state);
  if (!p) return { ok: false, error: 'unknown_or_expired_state' };
  pending.delete(state);

  try {
    const res = await fetch(CANVA_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  oauth.redirectUri,
        code_verifier: p.codeVerifier,
      }).toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('canva-oauth: token exchange failed', { status: res.status, body });
      return { ok: false, error: `token_exchange_failed:${res.status}` };
    }
    const tok = await res.json() as TokenResponse;
    await persistTokens(tok);
    logger.info('canva-oauth: authorization complete, tokens persisted to broker');
    return { ok: true };
  } catch (err) {
    logger.warn('canva-oauth: token exchange errored', { err: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

/** Refresh the access token using the stored refresh_token. Returns false
 *  (and leaves the row alone) if there's no refresh token yet — i.e. the
 *  operator hasn't completed the initial browser consent. */
export async function refreshCanvaToken(): Promise<boolean> {
  const oauth = getCanvaOAuthConfig();
  const refreshToken = process.env.CANVA_REFRESH_TOKEN?.trim();
  if (!oauth || !refreshToken) return false;

  try {
    const res = await fetch(CANVA_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    if (!res.ok) {
      logger.warn('canva-oauth: refresh failed', { status: res.status });
      return false;
    }
    const tok = await res.json() as TokenResponse;
    await persistTokens(tok);
    logger.info('canva-oauth: access token refreshed');
    return true;
  } catch (err) {
    logger.warn('canva-oauth: refresh errored', { err: (err as Error).message });
    return false;
  }
}

/** Call before probing/using the 'canva' server. No-op unless the token is
 *  within 5 minutes of expiry (or expiry is unknown and a refresh token
 *  exists, which is the safe-but-rare fallback path). */
export async function ensureFreshCanvaToken(): Promise<void> {
  const expiresAt = process.env.CANVA_TOKEN_EXPIRES_AT?.trim();
  const refreshToken = process.env.CANVA_REFRESH_TOKEN?.trim();
  if (!refreshToken) return;
  const skewMs = 5 * 60_000;
  if (expiresAt) {
    const t = new Date(expiresAt).getTime();
    if (Number.isFinite(t) && t - Date.now() > skewMs) return; // still fresh
  }
  await refreshCanvaToken();
}
