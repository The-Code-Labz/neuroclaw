// src/infra/higgsfield-usage.ts
// Higgsfield subscription credit balance — sourced through the Higgsfield MCP
// `balance` tool (no REST key). Verified live: balance → { credits: 100,
// subscription_plan_type: "plus" }.
//
// Reuses higgsfield-client's `higgsfieldCall` so the rotating-refresh-token flow
// lives in ONE place. Higgsfield returns a capless balance (current credits, no
// cap), so we render a high-water-mark drain gauge identical to OpenArt/KIE:
// track the peak observed this process lifetime and show consumption against it.
import { higgsfieldCall } from './higgsfield-client';
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;
let peakBalance = 0;

interface BalanceSummary { credits?: number; subscription_plan_type?: string }

function parseBalance(raw: unknown): BalanceSummary | null {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.credits === 'number') return o as BalanceSummary;
    if (typeof o.text === 'string') { try { return JSON.parse(o.text) as BalanceSummary; } catch { /* ignore */ } }
    const content = (o as { content?: Array<{ text?: string }> }).content;
    if (Array.isArray(content) && typeof content[0]?.text === 'string') {
      try { return JSON.parse(content[0].text!) as BalanceSummary; } catch { /* ignore */ }
    }
  }
  if (typeof raw === 'string') { try { return JSON.parse(raw) as BalanceSummary; } catch { /* ignore */ } }
  return null;
}

export async function fetchHiggsfieldUsage(): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let raw: unknown;
  try {
    raw = await higgsfieldCall('balance', {});
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('higgsfield-usage: balance fetch failed', { error: message });
    return { ok: false, provider: 'higgsfield', windows: [], error: `MCP error: ${message}` };
  }

  const bal = parseBalance(raw);
  const balance = bal?.credits;
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    return { ok: false, provider: 'higgsfield', windows: [], error: 'no credit balance in balance response' };
  }

  peakBalance = Math.max(peakBalance, balance);
  const usedPercent = peakBalance > 0
    ? Math.min(100, Math.max(0, Math.round(((peakBalance - balance) / peakBalance) * 100)))
    : 0;
  const windows: LimitWindow[] = [{ label: 'Credits', usedPercent }];

  const plan = bal?.subscription_plan_type ? `${bal.subscription_plan_type} · ` : '';
  const value: ProviderLimits = { ok: true, provider: 'higgsfield', windows };
  value.note = `${plan}${balance.toLocaleString('en-US')} credits left`;
  cache = { at: Date.now(), value };
  return value;
}
