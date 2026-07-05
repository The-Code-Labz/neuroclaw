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
  /** Route this request's Chromium through config.browser.proxyUrl (residential
   *  egress to escape datacenter bot-walls). Opt-in per call — NOT global —
   *  because the proxy path is slow; callers use it only as a fallback when a
   *  direct fetch is blocked. No-op when no proxyUrl is configured. */
  useProxy?:     boolean;
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
  const effTimeoutMs = opts.timeoutMs ?? config.browser.timeoutMs;
  let url    = `${base}${path.startsWith('/') ? path : '/' + path}?token=${encodeURIComponent(config.browser.token)}`;
  // Align Browserless's SERVER-side session timeout with our client timeout.
  // Without this, Browserless caps a session at its 30s default and 408s long
  // renders (e.g. waiting out a Cloudflare challenge) even though our client
  // would happily wait longer.
  url += `&timeout=${effTimeoutMs}`;

  // Route the headless Chromium through an upstream residential proxy when the
  // caller opts in (useProxy) AND a proxy is configured — so the fetch leaves
  // from a residential IP and escapes the datacenter bot-walls that block this
  // server's IP. Opt-in per call (not global) because the proxy path is a
  // fallback used only when a direct fetch is blocked. Browserless honours
  // Chromium launch flags via the `launch` query param (verified: a dead proxy
  // yields net::ERR_PROXY_CONNECTION_FAILED). The proxy must be no-auth —
  // Chromium can't authenticate SOCKS5.
  if (opts.useProxy && config.browser.proxyUrl) {
    const launch = JSON.stringify({ args: [`--proxy-server=${config.browser.proxyUrl}`] });
    url += `&launch=${encodeURIComponent(launch)}`;
  }

  // Pick a sensible response type per endpoint when the caller doesn't override.
  const respType: 'json' | 'text' | 'binary' = opts.responseType
    ?? (path.startsWith('/screenshot') || path.startsWith('/pdf') ? 'binary'
       : path.startsWith('/content') ? 'text'
       : 'json');

  const controller = new AbortController();
  const timeoutMs  = effTimeoutMs;
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

export interface WebResult { title: string; url: string; snippet: string; engine: string }

/**
 * Last-resort web search for hosts on a blocked datacenter IP. SearXNG's
 * scraper engines (google/bing/brave/ddg/startpage) get CAPTCHA'd or
 * rate-limited from such IPs, but Bing's *HTML results page* rendered through
 * a real headless Chromium is not challenged. We drive Browserless's
 * `/function` endpoint to load bing.com/search, wait for the organic results,
 * and extract {title,url,snippet} — decoding Bing's `ck/a` redirect links back
 * to the real destination URL. Returns [] (never throws) so the caller can
 * treat it as a best-effort tier. Requires config.browser.enabled.
 */
export async function bingSearchViaBrowser(query: string, maxResults = 8): Promise<WebResult[]> {
  if (!config.browser.enabled) return [];
  const target = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  // ES-module body (Browserless /function runs code as ESM). Retries internally
  // because Bing intermittently serves an empty layout to automated browsers.
  const code = `export default async function ({page, context}) {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    let rows = [];
    for (let attempt = 0; attempt < 3 && rows.length === 0; attempt++) {
      await page.goto(context.url + (attempt ? '&_r=' + attempt : ''), {waitUntil: 'domcontentloaded', timeout: 25000});
      await page.waitForSelector('li.b_algo h2 a', {timeout: 8000}).catch(()=>{});
      await new Promise(r => setTimeout(r, 800));
      rows = await page.$$eval('li.b_algo', els => els.slice(0, 12).map(el => {
        const a = el.querySelector('h2 a'); if (!a) return null;
        let url = a.href;
        try {
          if (url.includes('/ck/a')) {
            const u = new URL(url).searchParams.get('u');
            if (u && u.length > 2) url = decodeURIComponent(escape(atob(u.slice(2).replace(/-/g, '+').replace(/_/g, '/'))));
          }
        } catch (e) { /* keep redirect url */ }
        const sn = el.querySelector('.b_lineclamp2,.b_lineclamp3,.b_lineclamp4,.b_caption p,.b_algoSlug,p');
        return { title: (a.textContent || '').trim(), url, snippet: sn ? (sn.textContent || '').trim().slice(0, 300) : '' };
      }).filter(r => r && r.title && r.url && !r.url.includes('/ck/a')));
    }
    return { data: rows, type: 'application/json' };
  }`;

  // One outer retry too: a cold Browserless container can 400 the first call.
  for (let i = 0; i < 2; i++) {
    try {
      const resp = await browserlessRequest('/function', { code, context: { url: target } }, { responseType: 'json', timeoutMs: 60000 });
      const data = resp && typeof resp === 'object' && 'data' in (resp as Record<string, unknown>)
        ? (resp as Record<string, unknown>).data
        : resp;
      if (Array.isArray(data) && data.length > 0) {
        return (data as Array<Record<string, string>>).slice(0, maxResults).map(r => ({
          title: r.title ?? '', url: r.url ?? '', snippet: r.snippet ?? '', engine: 'bing-browser',
        }));
      }
      if (Array.isArray(data)) return []; // valid empty result — don't retry
    } catch (err) {
      logger.warn('bingSearchViaBrowser attempt failed', { attempt: i, error: (err as Error).message });
    }
  }
  return [];
}

/**
 * Fetch a page's fully-rendered HTML through the residential proxy, waiting out
 * Cloudflare-style JS interstitials ("Just a moment") that a plain /content
 * fetch would return before they clear. Residential egress (useProxy) gets past
 * the IP filter; the in-page loop then waits for the challenge JS to redirect to
 * the real document (tolerating the frame-detach that the redirect causes).
 * Returns the cleared HTML, or '' if it never cleared / errored. Never throws.
 * Used by browserless_fetch's proxy-retry path. Verified live: clears Fandom and
 * returns the real 578KB page + full roster in ~49s.
 */
export async function renderViaProxyClearingChallenge(url: string, timeoutMs = 110_000): Promise<string> {
  if (!config.browser.enabled || !config.browser.proxyUrl) return '';
  const code = `export default async function ({page, context}) {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    await page.goto(context.url, {waitUntil:'domcontentloaded', timeout: 45000}).catch(()=>{});
    for (let i=0;i<12;i++){
      let title='';
      try { title = await page.title(); } catch (e) { await new Promise(r=>setTimeout(r,2500)); continue; }
      if (title && !/just a moment|verification|attention required/i.test(title)) break;
      await new Promise(r=>setTimeout(r,2500));
    }
    let html=''; try { html = await page.content(); } catch (e) {}
    return { data: html, type: 'application/json' };
  }`;
  try {
    const resp = await browserlessRequest('/function', { code, context: { url } }, { responseType: 'json', useProxy: true, timeoutMs });
    const data = resp && typeof resp === 'object' && !Array.isArray(resp) && 'data' in (resp as Record<string, unknown>)
      ? (resp as Record<string, unknown>).data
      : resp;
    return typeof data === 'string' ? data : '';
  } catch (err) {
    logger.warn('renderViaProxyClearingChallenge failed', { url, error: (err as Error).message });
    return '';
  }
}
