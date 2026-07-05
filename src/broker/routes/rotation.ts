/**
 * broker/routes/rotation.ts — supervisor admin + rotation webhook plumbing
 * (spec v3 §7.5, §8.8).
 *
 * Two builders are exported:
 *
 *   buildRotationAdminRoutes()  — mounted UNDER /api/broker/admin (dashboard-
 *                                  token-gated). Includes /mcp/live, /mcp/spawn,
 *                                  /mcp/stop, /rotation-test, and the
 *                                  /webhook-info introspection endpoint.
 *
 *   buildPublicWebhookRoute()   — mounted at /webhooks/broker/rotation OUTSIDE
 *                                  the dashboard-token gate. This is the URL
 *                                  Infisical (or any storage provider) POSTs
 *                                  rotation events to. Auth is via the
 *                                  x-broker-webhook-signature HMAC header.
 *
 * Why split: Infisical's webhook sender lives outside our network and has no
 * dashboard token. The HMAC signature (NC_BROKER_WEBHOOK_SECRET) is what
 * actually authenticates a rotation event — making the path token-free is
 * a precondition for external delivery.
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../../utils/logger';
import { notifyRotation, listLiveMcps, spawnMcp, stopMcp } from '../../mcp/mcpSpawner';
import { config } from '../../config';

const WEBHOOK_SECRET_ENV = 'NC_BROKER_WEBHOOK_SECRET';

// Headers we accept the signature from. Infisical has used different names
// across versions (`x-infisical-signature`, `x-infisical-signature-256`) and
// generic webhook senders use `x-webhook-signature` or `x-hub-signature-256`.
// We accept any of these — the HMAC secret itself is the real auth.
const ACCEPTED_SIG_HEADERS = [
  'x-broker-webhook-signature',   // our spec default
  'x-infisical-signature',         // older Infisical
  'x-infisical-signature-256',     // newer Infisical (sha256 explicit)
  'x-webhook-signature',
  'x-hub-signature-256',           // GitHub-style; some Infisical proxies pass-through
];

/**
 * Extract the candidate signature value(s) from the request. Returns every
 * matching header so the verifier can try them in order.
 */
function collectSignatureHeaders(req: import('hono').Context['req']): Array<{ header: string; value: string }> {
  const out: Array<{ header: string; value: string }> = [];
  for (const h of ACCEPTED_SIG_HEADERS) {
    const v = req.header(h);
    if (v && v.trim()) out.push({ header: h, value: v.trim() });
  }
  return out;
}

/**
 * Parse Infisical's `t=<timestamp>;<hex_hmac>` header format. Returns the bare
 * signature if it matches, otherwise the original string unchanged.
 *
 * Infisical source (services/webhook/webhook-fns.ts):
 *   headers["x-infisical-signature"] = `t=${payload.timestamp};${webhookSign}`;
 * where `webhookSign = HMAC-SHA256(secret, JSON.stringify(payload)).digest('hex')`.
 *
 * The timestamp is ALSO embedded inside the JSON body as `payload.timestamp`,
 * so the HMAC naturally binds it — we just need to extract the hex portion.
 */
function stripInfisicalPrefix(signature: string): string {
  // Matches "t=12345;abcdef..." or "t = 12345 ; abcdef..."
  const m = signature.match(/^t\s*=\s*\d+\s*;\s*([0-9a-fA-F]+)\s*$/);
  return m ? m[1] : signature;
}

/**
 * Try every common signature encoding against the body + secret. Returns the
 * encoding name that matched, or null if none did.
 *
 * Encodings handled:
 *   - hex-lowercase                       → "abc123..."
 *   - hex with sha256= prefix             → "sha256=abc123..."
 *   - hex with Infisical t= prefix        → "t=1234;abc123..."
 *   - base64                              → "dGVzdA=="
 *   - base64 with sha256= prefix          → "sha256=dGVzdA=="
 *
 * The constant-time compare runs on the DECODED buffers (canonical pattern).
 */
function verifyEncoded(rawBody: string, secret: string, signature: string): { ok: boolean; encoding: string } {
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest();      // Buffer
  const expectedB64 = expectedHex.toString('base64');

  // Strip provider-specific framing: Infisical "t=...;..." first, then any
  // "sha256=" / "hmac-sha256=" algorithm prefix.
  const stripped = stripInfisicalPrefix(signature);
  const cleaned = stripped.replace(/^(sha256|hmac-sha256)\s*=\s*/i, '').trim();

  // Try hex first (most common).
  try {
    const buf = Buffer.from(cleaned, 'hex');
    if (buf.length === expectedHex.length && timingSafeEqual(buf, expectedHex)) {
      return { ok: true, encoding: stripped !== signature ? 'infisical-hex' : 'hex' };
    }
  } catch { /* not hex */ }

  // Try base64.
  try {
    const buf = Buffer.from(cleaned, 'base64');
    if (buf.length === expectedHex.length && timingSafeEqual(buf, expectedHex)) {
      return { ok: true, encoding: 'base64' };
    }
  } catch { /* not base64 */ }

  // Try matching the base64 STRING directly (some senders pass the b64 as-is).
  if (cleaned === expectedB64) return { ok: true, encoding: 'base64-literal' };

  return { ok: false, encoding: 'none' };
}

/**
 * Verify the HMAC signature on a rotation webhook body against all known
 * header names and encodings. Returns the matching header + encoding for
 * diagnostics, or null if no header matched.
 */
function verifyWebhookSignature(
  rawBody: string,
  candidates: Array<{ header: string; value: string }>,
): { ok: true; header: string; encoding: string } | { ok: false; reason: string } {
  const secret = (process.env[WEBHOOK_SECRET_ENV] ?? '').trim();
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (candidates.length === 0) return { ok: false, reason: 'no_signature_header' };

  for (const { header, value } of candidates) {
    const r = verifyEncoded(rawBody, secret, value);
    if (r.ok) return { ok: true, header, encoding: r.encoding };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/**
 * Build the public, token-free rotation webhook route. Mount this BEFORE the
 * /api/* auth middleware so Infisical can reach it without a dashboard token.
 */
export function buildPublicWebhookRoute(): Hono {
  const r = new Hono();

  r.post('/broker/rotation', async (c) => {
    const raw = await c.req.text();
    const candidates = collectSignatureHeaders(c.req);
    const verify = verifyWebhookSignature(raw, candidates);

    if (!verify.ok) {
      // Diagnostics-on-failure: log every header so we can see exactly what
      // Infisical sent. Body is truncated to 200 chars to avoid log bloat /
      // accidental secret leakage; the names of headers we DIDN'T recognise
      // are surfaced explicitly so the operator can wire them up.
      const allHeaders: Record<string, string> = {};
      try {
        const raws = c.req.raw.headers;
        raws.forEach((value, key) => { allHeaders[key] = value; });
      } catch { /* in some Hono versions .raw isn't iterable */ }
      const signatureLikeHeaders = Object.keys(allHeaders)
        .filter((k) => /sign|hmac|hash|hub|hook|timestamp/i.test(k));
      // Surface signature header VALUES (not the body!) so we can reverse-engineer
      // unknown formats. These are not secrets — they're public HMAC outputs.
      const signatureSamples: Record<string, string> = {};
      for (const h of signatureLikeHeaders) signatureSamples[h] = allHeaders[h];
      logger.warn('broker: rotation webhook signature failed', {
        reason: verify.reason,
        triedHeaders: candidates.map((c) => c.header),
        signatureLikeHeaders,
        signatureSamples,
        allHeaderNames: Object.keys(allHeaders).slice(0, 50),
        bodyLength: raw.length,
      });
      return c.json({
        error: 'invalid_signature',
        reason: verify.reason,
        debug: {
          // Echo back what we saw so the operator can compare against what
          // Infisical claims it sent. Safe to expose — no secret material.
          triedHeaders: candidates.map((c) => c.header),
          signatureLikeHeaders,
          hasSecretConfigured: Boolean((process.env[WEBHOOK_SECRET_ENV] ?? '').trim()),
        },
      }, 401);
    }

    let body: {
      event?: string;
      secretName?: string;
      secret_name?: string;
      // Infisical's rotation/secret-change webhook shape — they wrap the
      // payload in `data: { secret_key: ... }` (snake_case) or a similar
      // envelope depending on the integration. Accept both shapes.
      data?: { secretKey?: string; secret_key?: string; secret_name?: string };
    };
    try { body = JSON.parse(raw) as typeof body; }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    const secretName = String(
      body.secretName
        ?? body.secret_name
        ?? body.data?.secretKey
        ?? body.data?.secret_key
        ?? body.data?.secret_name
        ?? '',
    ).trim();

    // Infisical's "test event" payload doesn't always include a secret name
    // (it's just a delivery test). Accept that case as a healthy ping.
    if (!secretName) {
      logger.info('broker: rotation webhook fired (no secret name — test event accepted)', {
        event: body.event,
        signatureHeader: verify.header,
        signatureEncoding: verify.encoding,
      });
      return c.json({
        ok: true,
        test: true,
        note: 'no secret name in payload — accepted as a delivery test',
      });
    }

    logger.info('broker: rotation webhook fired', {
      secret: secretName,
      event: body.event,
      signatureHeader: verify.header,
      signatureEncoding: verify.encoding,
    });

    try {
      await notifyRotation(secretName);
      return c.json({ ok: true, secret: secretName });
    } catch (err) {
      logger.error('broker: rotation handler failed', { err: (err as Error).message });
      return c.json({ error: 'rotation_failed', detail: (err as Error).message }, 500);
    }
  });

  return r;
}

/**
 * Build the admin-only rotation routes (mounted under /api/broker/admin).
 * Includes MCP supervisor controls + a manual rotation trigger + introspection.
 */
export function buildRotationAdminRoutes(): Hono {
  const r = new Hono();

  r.get('/mcp/live', (c) => c.json({ mcps: listLiveMcps() }));

  r.post('/mcp/spawn', async (c) => {
    let body: {
      entrypoint?: string; manifest_path?: string; name?: string;
      command?: string[]; cwd?: string; extra_env?: Record<string, string>;
    };
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    if (!body.entrypoint) return c.json({ error: 'entrypoint_required' }, 400);

    try {
      const rec = await spawnMcp({
        entrypoint: body.entrypoint,
        manifestPath: body.manifest_path,
        name: body.name,
        command: body.command,
        cwd: body.cwd,
        extraEnv: body.extra_env,
      });
      return c.json({ ok: true, mcp: rec.mcp, pid: rec.child.pid });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  r.post('/mcp/stop', async (c) => {
    let body: { name?: string };
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'name_required' }, 400);
    await stopMcp(name);
    return c.json({ ok: true });
  });

  r.post('/rotation-test', async (c) => {
    let body: { secretName?: string };
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }
    const name = String(body.secretName ?? '').trim();
    if (!name) return c.json({ error: 'secret_name_required' }, 400);
    await notifyRotation(name);
    return c.json({ ok: true });
  });

  /**
   * /webhook-info — surfaces the public URL + signature header name + a
   * boolean indicating whether a webhook secret has been configured. Used by
   * the dashboard Secrets tab and by `nc-broker webhook-info`.
   *
   * Never returns the secret value itself.
   */
  r.get('/webhook-info', (c) => {
    const publicBase = (process.env.DASHBOARD_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
      || `http://127.0.0.1:${config.dashboard.port}`;
    const secret = (process.env[WEBHOOK_SECRET_ENV] ?? '').trim();
    return c.json({
      url: `${publicBase}/webhooks/broker/rotation`,
      signatureHeader: ACCEPTED_SIG_HEADERS[0],
      acceptedSignatureHeaders: ACCEPTED_SIG_HEADERS,
      signatureAlgorithm: 'HMAC-SHA256 (hex or base64 — both accepted, with or without "sha256=" prefix)',
      secretConfigured: Boolean(secret),
      secretLength: secret ? secret.length : 0,
      publicBaseSource: process.env.DASHBOARD_PUBLIC_URL ? 'DASHBOARD_PUBLIC_URL' : 'fallback_loopback',
    });
  });

  return r;
}
