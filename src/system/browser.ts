// Thin HTTP client for the Browserless service (hosted Chromium with REST +
// WebSocket Puppeteer endpoints). All four browser_* tools call through
// here. Uses Node 20+ global fetch — no extra dependency.
//
// Endpoints in play:
//   /content     POST → rendered HTML (text/html)
//   /screenshot  POST → image bytes (binary)
//   /pdf         POST → application/pdf bytes (binary)
//   /function    POST → arbitrary JSON returned by user function (JSON)
//
// Auth: token query string (?token=...). The token also enables per-org
// rate limiting on the hosted service.

import { config } from '../config';
import { logger } from '../utils/logger';

export interface BrowserlessOpts {
  /** Override response handling. Defaults: 'json' for /function, 'binary' for /screenshot+/pdf, 'text' for /content. */
  responseType?: 'json' | 'text' | 'binary';
  /** Optional override for the per-request timeout in ms. */
  timeoutMs?:    number;
}

export type BrowserlessResult = string | Buffer | Record<string, unknown> | unknown[];

/**
 * POST a JSON body to the configured browserless instance and return the
 * parsed response. Throws on non-2xx with the response body included for
 * debuggability. Tool handlers are expected to catch and convert to
 * `{ ok:false, error }`.
 */
export async function browserlessRequest(
  path: string,
  body: unknown,
  opts: BrowserlessOpts = {},
): Promise<BrowserlessResult> {
  if (!config.browser.enabled) {
    throw new Error('browser tools disabled (set BROWSERLESS_URL and BROWSERLESS_TOKEN in .env)');
  }
  const base = config.browser.url.replace(/\/+$/, '');
  const url  = `${base}${path.startsWith('/') ? path : '/' + path}?token=${encodeURIComponent(config.browser.token)}`;

  // Pick a sensible response type per endpoint when the caller doesn't override.
  const respType: 'json' | 'text' | 'binary' = opts.responseType
    ?? (path.startsWith('/screenshot') || path.startsWith('/pdf') ? 'binary'
       : path.startsWith('/content') ? 'text'
       : 'json');

  const controller = new AbortController();
  const timeoutMs  = opts.timeoutMs ?? config.browser.timeoutMs;
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(`browserless ${path} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`browserless ${path} request failed: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    // Read body as text for the error — saves us from JSON-parse errors when
    // browserless returns a plain-text trace.
    const errBody = await res.text().catch(() => '<unreadable>');
    const trimmed = errBody.length > 800 ? errBody.slice(0, 800) + '…' : errBody;
    throw new Error(`browserless ${path} ${res.status} ${res.statusText}: ${trimmed}`);
  }

  if (respType === 'binary') {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }
  if (respType === 'text') {
    return await res.text();
  }
  // JSON — fall back to text on parse error so we can include the raw body.
  const raw = await res.text();
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch {
    logger.warn('browserless JSON parse failed; returning raw text', { path, sample: raw.slice(0, 200) });
    return raw;
  }
}
