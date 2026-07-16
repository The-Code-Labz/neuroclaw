// src/infra/kie-usage.ts
// KIE AI prepaid credit balance. Plain authenticated REST — no PTY, instant.
//   GET https://api.kie.ai/api/v1/chat/credit
//     Authorization: Bearer $KIE_API_KEY
//   → { code: 200, msg: "success", data: 738.0 }
// KIE returns a *capless* prepaid balance (a raw credit count, no total/cap), so
// unlike OpenRouter (total/used pair) there's no natural "used %". We render a
// high-water-mark gauge: track the peak balance observed this process lifetime and
// show consumption against it. The absolute balance is always the note — that's
// the source of truth; the bar resets to 0% after a restart (peak = current) and
// re-fills as credits drain. Verified live 2026-07-12 (738 credits).
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ProviderLimits } | null = null;
let peakBalance = 0; // high-water mark for the drain gauge (process lifetime)

function apiKey(): string {
  return process.env.KIE_API_KEY?.trim() || '';
}
function baseURL(): string {
  return process.env.KIE_BASE_URL?.trim() || 'https://api.kie.ai/api/v1';
}

type CreditResponse = { code?: number; msg?: string; data?: number };

export async function fetchKieUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const key = apiKey();
  if (!key) return { ok: false, provider: 'kie', windows: [], error: 'No KIE_API_KEY set' };

  let res: Response;
  try {
    res = await fetch(`${baseURL()}/chat/credit`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('kie-usage: fetch failed', { error: message });
    return { ok: false, provider: 'kie', windows: [], error: `Network error: ${message}` };
  }

  if (!res.ok) return { ok: false, provider: 'kie', windows: [], error: `HTTP ${res.status}` };

  let data: CreditResponse;
  try {
    data = (await res.json()) as CreditResponse;
  } catch {
    return { ok: false, provider: 'kie', windows: [], error: 'Failed to parse response JSON' };
  }

  const balance = data.data;
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    return { ok: false, provider: 'kie', windows: [], error: 'no credit balance in response' };
  }

  peakBalance = Math.max(peakBalance, balance);
  const usedPercent = peakBalance > 0
    ? Math.min(100, Math.max(0, Math.round(((peakBalance - balance) / peakBalance) * 100)))
    : 0;
  const windows: LimitWindow[] = [{ label: 'Credits', usedPercent }];

  const value: ProviderLimits = { ok: true, provider: 'kie', windows };
  value.note = `${balance.toLocaleString('en-US')} credits left`;
  cache = { at: Date.now(), value };
  return value;
}
