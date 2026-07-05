/**
 * broker/agentToken.ts — HMAC-SHA256 session tokens (spec v3 §6).
 *
 * Tokens are short-lived (30s default), bearer-shaped, and self-contained.
 * The HMAC key lives in the OS keyring (or `.env` fallback for v1) and is
 * loaded via `initTokenKey()` at process start.
 *
 *   token  = base64url(payload) + "." + base64url(signature)
 *   payload = { v, agt, sid, exp, jti }
 *
 * All identity used in route handlers comes from a successful `verifyAgentToken`
 * call — request bodies CANNOT self-assert identity (see `agentAuthMiddleware`).
 *
 * In-process callers don't mint tokens; they use the `agentStore`
 * AsyncLocalStorage to thread identity through async chains.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { AgentContext } from './types';

export const agentStore = new AsyncLocalStorage<AgentContext>();

let HMAC_KEY: Buffer | null = null;

/** Initialise the HMAC key. Must be 32 raw bytes. */
export function initTokenKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error(`HMAC key must be 32 bytes, got ${key.length}`);
  }
  HMAC_KEY = key;
}

/** True if a key has been initialised (broker is ready). */
export function isTokenKeyInitialised(): boolean {
  return HMAC_KEY !== null;
}

interface TokenPayload {
  v: 1;
  agt: string;
  sid: string;
  exp: number;
  jti: string;
}

// ── jti replay cache (Map<jti, exp_unix_seconds>) ────────────────────────────
const jtiCache = new Map<string, number>();
const JTI_MAX = 100_000;
const JTI_SLACK_MS = 5_000;

function pruneJtis(): void {
  const cutoff = Date.now() - JTI_SLACK_MS;
  for (const [jti, exp] of jtiCache) {
    if (exp * 1000 < cutoff) jtiCache.delete(jti);
  }
}

function claimJti(jti: string, exp: number): boolean {
  pruneJtis();
  if (jtiCache.size >= JTI_MAX) {
    throw new AuthError('jti_cache_overflow');
  }
  if (jtiCache.has(jti)) return false;
  jtiCache.set(jti, exp);
  return true;
}

/** Internal: how many active jti entries are cached (for diagnostics). */
export function jtiCacheSize(): number {
  return jtiCache.size;
}

/** Throwable error tagged with a stable code for HTTP mapping. */
export class AuthError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'AuthError';
  }
}

/**
 * Mint a fresh agent token. Used by:
 *   - `nc-supervisor` when spawning an MCP
 *   - Out-of-process callers (Discord bot, schedulers) bridging into broker
 *   - Tests
 *
 * In-process TS code should NOT call this — use `agentStore.run(...)` instead.
 */
export function mintAgentToken(agentName: string, sessionId: string, ttlSec = 30): string {
  if (!HMAC_KEY) throw new Error('HMAC key not initialised — call initTokenKey() first');

  const payload: TokenPayload = {
    v: 1,
    agt: agentName,
    sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
    jti: randomBytes(16).toString('hex'),
  };

  const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', HMAC_KEY).update(b64Payload).digest('base64url');
  return `${b64Payload}.${sig}`;
}

/**
 * Verify a token. Returns the verified agent context, or throws an `AuthError`
 * with one of the documented codes:
 *   malformed_token | malformed_payload | invalid_signature
 *   token_expired   | token_replayed    | unsupported_version | jti_cache_overflow
 */
export function verifyAgentToken(token: string): AgentContext {
  if (!HMAC_KEY) throw new Error('HMAC key not initialised — call initTokenKey() first');
  if (typeof token !== 'string' || token.length === 0) throw new AuthError('malformed_token');

  const dot = token.lastIndexOf('.');
  if (dot === -1 || dot === 0 || dot === token.length - 1) throw new AuthError('malformed_token');

  const b64Payload = token.slice(0, dot);
  const b64Sig = token.slice(dot + 1);

  let givenSig: Buffer;
  try {
    givenSig = Buffer.from(b64Sig, 'base64url');
  } catch {
    throw new AuthError('malformed_token');
  }
  const expectedSig = createHmac('sha256', HMAC_KEY).update(b64Payload).digest();

  // Length-check on DECODED buffers (not base64 strings) — canonical pattern.
  if (givenSig.length !== expectedSig.length) throw new AuthError('invalid_signature');
  if (!timingSafeEqual(givenSig, expectedSig)) throw new AuthError('invalid_signature');

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('malformed_payload');
  }

  if (payload.v !== 1) throw new AuthError('unsupported_version');
  if (typeof payload.agt !== 'string' || typeof payload.sid !== 'string' || typeof payload.jti !== 'string') {
    throw new AuthError('malformed_payload');
  }
  if (Math.floor(Date.now() / 1000) > payload.exp) throw new AuthError('token_expired');
  if (!claimJti(payload.jti, payload.exp)) throw new AuthError('token_replayed');

  return { agentName: payload.agt, sessionId: payload.sid };
}

/**
 * Test-only helper: drop all cached jti entries. Production code should never
 * need this — entries expire naturally inside the 30s window.
 */
export function _resetJtiCacheForTests(): void {
  jtiCache.clear();
}
