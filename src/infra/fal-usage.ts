// src/infra/fal-usage.ts
// fal.ai account balance. Plain authenticated REST — no PTY, instant.
//   GET https://rest.alpha.fal.ai/billing/user_balance
//     Authorization: Key $FAL_ADMIN_API_KEY
//   → raw numeric body, e.g. `9.914`  (USD credit balance, NOT JSON)
//
// GOTCHA (verified live 2026-07-12): fal's balance surface is ADMIN-key gated.
// A standard queue key (the one the fal_image tool uses) returns:
//   403 "This operation is only supported for ADMIN keys"
// So this fetcher prefers a DEDICATED FAL_ADMIN_API_KEY (broker: SHARED_FAL_ADMIN_API_KEY)
// and falls back to FAL_API_KEY only to surface the actionable 403. This avoids
// forcing the user to swap their working queue key for an admin key.
//
// ENDPOINT NOTE (verified live 2026-07-12): /billing/user_details returns account
// STATUS (is_locked, payment_verification_status) with NO balance number. The actual
// credit balance lives at /billing/user_balance and comes back as a bare number
// (text/plain, no JSON envelope). Like KIE this is a capless prepaid balance →
// high-water-mark drain gauge, absolute value in the note.
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const DEFAULT_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60_000;
const BILLING_HOST = 'https://rest.alpha.fal.ai';

let cache: { at: number; value: ProviderLimits } | null = null;
let peakBalance = 0; // high-water mark for the drain gauge (process lifetime)

function adminKey(): string {
  // Prefer a dedicated admin key; fall back to the queue key (yields a clean 403).
  return process.env.FAL_ADMIN_API_KEY?.trim() || process.env.FAL_API_KEY?.trim() || '';
}
function hasDedicatedAdminKey(): boolean {
  return !!process.env.FAL_ADMIN_API_KEY?.trim();
}

// Scan a JSON object for the first plausible numeric USD balance field.
const BALANCE_FIELDS = ['balance', 'available_balance', 'current_balance', 'remaining_balance', 'wallet_balance', 'credits'];
function extractBalance(obj: unknown): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const f of BALANCE_FIELDS) {
    const v = rec[f];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  // one level of nesting (e.g. { billing: { balance } })
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') {
      const nested = extractBalance(v);
      if (nested !== null) return nested;
    }
  }
  return null;
}

export async function fetchFalUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const key = adminKey();
  if (!key) return { ok: false, provider: 'fal', windows: [], error: 'No FAL_API_KEY set' };

  let res: Response;
  try {
    res = await fetch(`${BILLING_HOST}/billing/user_balance`, {
      headers: { Authorization: `Key ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('fal-usage: fetch failed', { error: message });
    return { ok: false, provider: 'fal', windows: [], error: `Network error: ${message}` };
  }

  if (res.status === 403) {
    return {
      ok: false,
      provider: 'fal',
      windows: [],
      error: hasDedicatedAdminKey()
        ? 'admin key rejected (403)'
        : 'needs ADMIN key (fal.ai/dashboard/keys → SHARED_FAL_ADMIN_API_KEY)',
    };
  }
  if (!res.ok) return { ok: false, provider: 'fal', windows: [], error: `HTTP ${res.status}` };

  // /billing/user_balance returns a bare number as text/plain (e.g. "9.914").
  // Parse defensively: try raw-number first, fall back to a JSON balance field
  // in case fal ever wraps it.
  let balance: number | null = null;
  try {
    const raw = (await res.text()).trim();
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) balance = asNum;
    else {
      try { balance = extractBalance(JSON.parse(raw)); } catch { /* not JSON */ }
    }
  } catch {
    return { ok: false, provider: 'fal', windows: [], error: 'Failed to read balance response' };
  }
  if (balance === null) {
    return { ok: false, provider: 'fal', windows: [], error: 'no balance in response' };
  }

  peakBalance = Math.max(peakBalance, balance);
  const usedPercent = peakBalance > 0
    ? Math.min(100, Math.max(0, Math.round(((peakBalance - balance) / peakBalance) * 100)))
    : 0;
  const windows: LimitWindow[] = [{ label: 'Balance', usedPercent }];

  const value: ProviderLimits = { ok: true, provider: 'fal', windows };
  value.note = `$${balance.toFixed(2)} left`;
  cache = { at: Date.now(), value };
  return value;
}
