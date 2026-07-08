/**
 * studio-preview-security.ts
 *
 * Origin-isolation building blocks for the Studio "Web App Viewer" (B1).
 *
 * This module is intentionally NOT imported by src/dashboard/server.ts (the
 * main dashboard app). It exists to be mounted by the Studio preview service
 * and the Studio API service — two separate Hono apps living on two separate
 * origins (`*.preview.<domain>` and `studio-api.<domain>`). Applying any of
 * this at the dashboard-app level would be scope creep: the dashboard keeps
 * its existing `dashboard-token` cookie/auth model untouched (see auth.ts).
 *
 * Traefik already sets COOP/COEP at the edge for the preview origin
 * (infra/traefik/dynamic/studio-preview.yml.template). The middleware below
 * is belt-and-suspenders: it makes the isolation guarantee hold even when a
 * service is run directly (local dev, health checks, a future move behind a
 * different proxy) without depending on the edge always being configured
 * correctly. Two independent layers agreeing is the point — if they ever
 * disagree, that disagreement itself is a signal worth investigating.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

// ── Preview origin: response headers ─────────────────────────────────────────

/**
 * Cross-origin isolation for the untrusted WebContainer preview document.
 * Mount this ONLY on the Studio preview app — never on the dashboard or the
 * Studio API app. `credentialless` (not `require-corp`) matches the choice
 * made at the Traefik layer: full COOP/COEP isolation without forcing every
 * third-party asset the preview fetches to carry a CORP header.
 */
export function studioPreviewSecurityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Embedder-Policy', 'credentialless');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Robots-Tag', 'noindex, nofollow');
  };
}

// ── Studio API origin: host-only cookie + bearer auth ────────────────────────
//
// Two clients call the Studio API:
//   1. The dashboard itself (same origin as `app.<domain>` would be if it
//      called studio-api directly — but in practice it should route through
//      its own backend, not the browser, so this path is mostly for parity).
//   2. The untrusted preview iframe, which lives on a genuinely different
//      origin (`run-<sessionId>.preview.<domain>`). A SameSite=Strict cookie
//      set on studio-api's own host is simply never sent on that cross-site
//      request — which is correct and expected, not a bug to work around.
//      The preview app must instead carry a short-lived bearer token (issued
//      once per session when the preview is created) in an Authorization
//      header. There is no ambient auth here by design: knowing the preview
//      URL must never be enough to reach the Studio API as that user.

const STUDIO_API_COOKIE_NAME = 'studio-api-session';

/**
 * Sets the Studio API session cookie. Host-only (no `Domain` attribute —
 * matches the existing dashboard-token pattern in server.ts), HttpOnly,
 * scoped to this origin only. `Secure` is conditional on the request having
 * arrived over HTTPS so local dev over http://localhost keeps working,
 * exactly like setAuthCookie() in server.ts.
 */
export function setStudioApiCookie(c: Context, token: string): void {
  const https = c.req.header('x-forwarded-proto') === 'https';
  c.header(
    'Set-Cookie',
    `${STUDIO_API_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${https ? '; Secure' : ''}`
  );
}

export function clearStudioApiCookie(c: Context): void {
  c.header('Set-Cookie', `${STUDIO_API_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** Constant-time token comparison — same rationale as tokenMatches() in auth.ts. */
function tokenMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function readCookie(c: Context, name: string): string | null {
  const header = c.req.header('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export interface StudioApiAuthOptions {
  /** The session token(s) valid right now, e.g. a lookup keyed by sessionId. */
  isValidToken: (token: string) => boolean;
}

/**
 * Auth middleware for the Studio API. Accepts EITHER:
 *   - the host-only `studio-api-session` cookie (same-origin calls), OR
 *   - an `Authorization: Bearer <token>` header (cross-origin calls from the
 *     preview iframe, which cannot send the cookie — see comment above).
 *
 * Deliberately does NOT look at `dashboard-token` or any apex/dashboard
 * cookie. The Studio API must never trust ambient auth from another origin —
 * that is the entire point of B1.
 */
export function requireStudioApiAuth(opts: StudioApiAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const cookie = readCookie(c, STUDIO_API_COOKIE_NAME);
    const candidate = bearer ?? cookie;

    if (!candidate || !opts.isValidToken(candidate)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}

/** Generates a short-lived, high-entropy session token for a new preview session. */
export function generatePreviewSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
