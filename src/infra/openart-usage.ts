// src/infra/openart-usage.ts
// OpenArt subscription credit balance — sourced through the OpenArt MCP, NOT a
// REST key. OpenArt exposes no API key and no REST credits endpoint; the only
// authenticated surface is the OAuth-gated MCP server, whose `openart_account_get`
// tool returns:
//   { user: { uid, email }, plan: "Essential", credits: 3825 }
//
// We reuse openart-client's `openartCall` so the fragile rotating-refresh-token
// flow (single-flight + cross-process lock + 401 force-refresh) lives in ONE
// place. Like KIE, OpenArt returns a *capless* balance (current credits, no cap),
// so we render a high-water-mark drain gauge: track the peak observed this
// process lifetime and show consumption against it. Absolute balance + plan are
// always the note — the source of truth; the bar resets to 0% after a restart
// (peak = current) and re-fills as credits drain. Verified live 2026-07-14.
import { openartCall } from './openart-client';
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;
let peakBalance = 0; // high-water mark for the drain gauge (process lifetime)

interface AccountSummary { user?: { uid?: string; email?: string }; plan?: string; credits?: number }

/** Extract the first balanced {…} JSON object from a string (OpenArt MCP tools
 *  may append human prose after the JSON block). */
function firstJsonObject(s: string): unknown | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Normalize whatever callTool hands back (parsed object, {text}, or raw string)
 *  into the account summary shape. */
function parseAccount(raw: unknown): AccountSummary | null {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.credits === 'number' || o.user) return o as AccountSummary;
    if (typeof o.text === 'string') { const j = firstJsonObject(o.text); if (j) return j as AccountSummary; }
    // MCP content-array shape: { content: [{ type:'text', text:'{...}' }] }
    const content = (o as { content?: Array<{ text?: string }> }).content;
    if (Array.isArray(content) && typeof content[0]?.text === 'string') {
      const j = firstJsonObject(content[0].text!); if (j) return j as AccountSummary;
    }
  }
  if (typeof raw === 'string') { const j = firstJsonObject(raw); if (j) return j as AccountSummary; }
  return null;
}

export async function fetchOpenArtUsage(): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  // No config.openart.enabled guard: that's a boot-time snapshot. openartCall
  // reads the refresh token live from the broker and throws a clean "OpenArt
  // not configured" if it's genuinely absent — which we surface as-is.
  let raw: unknown;
  try {
    raw = await openartCall('openart_account_get', {});
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('openart-usage: account fetch failed', { error: message });
    return { ok: false, provider: 'openart', windows: [], error: `MCP error: ${message}` };
  }

  const acct = parseAccount(raw);
  const balance = acct?.credits;
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    return { ok: false, provider: 'openart', windows: [], error: 'no credit balance in openart_account_get response' };
  }

  peakBalance = Math.max(peakBalance, balance);
  const usedPercent = peakBalance > 0
    ? Math.min(100, Math.max(0, Math.round(((peakBalance - balance) / peakBalance) * 100)))
    : 0;
  const windows: LimitWindow[] = [{ label: 'Credits', usedPercent }];

  const plan = acct?.plan ? `${acct.plan} · ` : '';
  const value: ProviderLimits = { ok: true, provider: 'openart', windows };
  value.note = `${plan}${balance.toLocaleString('en-US')} credits left`;
  cache = { at: Date.now(), value };
  return value;
}
