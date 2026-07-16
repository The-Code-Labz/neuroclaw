// src/infra/grok-usage.ts
// Grok CLI (xAI "Grok Build") subscription usage — the SuperGrok weekly window.
//
// Unlike the other Groks in the stack this is NOT the xAI API key pool and NOT
// the logout-fragile grok.com web quota. The CLI authenticates via OIDC against
// auth.x.ai (auth.json holds a bearer + refresh_token; the CLI self-refreshes on
// a ~6h expiry) so `/usage show` reports the *subscription* window — the surface
// we otherwise have zero visibility into.
//
// There is no curl-able REST endpoint: the billing config arrives over the CLI's
// ACP gateway (cli-chat-proxy.grok.com, gRPC) as a push — probing REST paths just
// 404s. And `grok -p "/usage show"` does NOT work: headless mode treats the slash
// command as a chat prompt. The one reliable path (verified live 2026-07-08):
//   drive `/usage show` inside a tmux PTY → the CLI writes a structured line to
//   ~/.grok/logs/unified.jsonl: { msg:"billing: fetched credits config",
//     ctx:{ config:{ creditUsagePercent, currentPeriod:{start,end,type},
//       onDemandCap/Used:{val}, prepaidBalance:{val} }, subscriptionTier } }
// We wait for a line newer than our trigger, then parse it. Same windowed shape
// the dashboard already renders for Claude/MiniMax/Antigravity.
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';
import type { ProviderLimits, LimitWindow } from './provider-limits';

const pexec = promisify(execFile);

const CACHE_TTL_MS = 15 * 60_000; // usage only moves per-request; poll gently
const DEFAULT_TIMEOUT_MS = 45_000;
const SESSION = 'nc-grok-usage';
const BILLING_MSG = 'billing: fetched credits config';

let cache: { at: number; value: ProviderLimits } | null = null;
let inflight: Promise<ProviderLimits> | null = null;

function grokBin(): string {
  return process.env.GROK_CLI_BIN?.trim() || path.join(os.homedir(), '.grok', 'bin', 'grok');
}
function unifiedLogPath(): string {
  return process.env.GROK_CLI_LOG?.trim() || path.join(os.homedir(), '.grok', 'logs', 'unified.jsonl');
}
function authPath(): string {
  return process.env.GROK_CLI_AUTH?.trim() || path.join(os.homedir(), '.grok', 'auth.json');
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function tmux(args: string[], timeoutMs = 8_000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await pexec('tmux', args, { timeout: timeoutMs });
    return { ok: true, out: stdout ?? '' };
  } catch (err) {
    return { ok: false, out: (err as { stdout?: string }).stdout ?? '' };
  }
}

type GrokConfig = {
  creditUsagePercent?: number;
  currentPeriod?: { type?: string; start?: string; end?: string };
  onDemandCap?: { val?: number };
  onDemandUsed?: { val?: number };
  prepaidBalance?: { val?: number };
  billingPeriodEnd?: string;
};
type GrokLogLine = { ts?: string; msg?: string; ctx?: { config?: GrokConfig; subscriptionTier?: string } };

// Fail-fast auth check: the CLI self-refreshes OIDC, but if the token file is gone
// or has lost its refresh_token there's nothing to refresh and `/usage` would hang.
function authState(): { ok: boolean; error?: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(authPath(), 'utf-8')) as Record<string, { refresh_token?: string }>;
    const entry = Object.values(raw)[0];
    if (!entry?.refresh_token) return { ok: false, error: 'Grok CLI not logged in — run `grok` to authenticate' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'No Grok CLI auth (~/.grok/auth.json) — run `grok` to log in' };
  }
}

// Scan unified.jsonl from the end for the newest billing line at/after `sinceMs`.
function readFreshBilling(sinceMs: number): GrokLogLine | null {
  let text: string;
  try { text = fs.readFileSync(unifiedLogPath(), 'utf-8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes(BILLING_MSG)) continue;
    try {
      const obj = JSON.parse(line) as GrokLogLine;
      if (obj.msg !== BILLING_MSG || !obj.ctx?.config) continue;
      const ts = obj.ts ? Date.parse(obj.ts) : NaN;
      if (!Number.isNaN(ts) && ts >= sinceMs) return obj;
      // lines are chronological; once we pass a stale billing line we can stop
      return null;
    } catch { /* skip malformed */ }
  }
  return null;
}

function toLimits(obj: GrokLogLine): ProviderLimits {
  const cfg = obj.ctx!.config!;
  const tier = obj.ctx?.subscriptionTier || 'Grok';
  const pct = Math.min(100, Math.max(0, Math.round(cfg.creditUsagePercent ?? 0)));
  const end = cfg.currentPeriod?.end || cfg.billingPeriodEnd;
  const windows: LimitWindow[] = [{
    label: 'Weekly',
    usedPercent: pct,
    resetAt: end ? (Date.parse(end) || undefined) : undefined,
  }];
  const notes: string[] = [];
  const cap = cfg.onDemandCap?.val ?? 0;
  const used = cfg.onDemandUsed?.val ?? 0;
  const prepaid = cfg.prepaidBalance?.val ?? 0;
  if (cap > 0) notes.push(`on-demand ${used}/${cap}`);
  if (prepaid > 0) notes.push(`prepaid ${prepaid}`);
  const value: ProviderLimits = { ok: true, provider: 'grok', windows };
  (value as { plan?: string }).plan = tier;
  if (notes.length) value.note = notes.join(' · ');
  return value;
}

/**
 * Drive `/usage show` in a throwaway tmux Grok session and parse the fresh
 * billing line the CLI writes to its unified log. Cached for CACHE_TTL_MS.
 */
export async function fetchGrokUsage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProviderLimits> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (inflight) return inflight; // collapse concurrent callers onto one PTY drive
  inflight = (async () => {
    const auth = authState();
    if (!auth.ok) return { ok: false, provider: 'grok', windows: [], error: auth.error };

    if (!fs.existsSync(grokBin())) {
      return { ok: false, provider: 'grok', windows: [], error: 'Grok CLI binary not found (~/.grok/bin/grok)' };
    }

    const deadline = Date.now() + timeoutMs;
    const sinceMs = Date.now() - 2_000; // small skew guard
    await tmux(['kill-session', '-t', SESSION]); // best-effort cleanup

    const started = await tmux(['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50', grokBin()]);
    if (!started.ok) {
      return { ok: false, provider: 'grok', windows: [], error: 'could not start tmux Grok session' };
    }

    try {
      // Wait for the TUI to boot (prompt/banner visible), then let it settle.
      let booted = false;
      while (Date.now() < deadline) {
        const pane = await tmux(['capture-pane', '-pt', SESSION]);
        if (pane.ok && /grok|›|>|ask|type|message/i.test(pane.out)) { booted = true; break; }
        await sleep(1_000);
      }
      if (!booted) return { ok: false, provider: 'grok', windows: [], error: 'Grok TUI did not boot in time' };
      await sleep(2_500);

      await tmux(['send-keys', '-t', SESSION, '/usage show', 'Enter']);

      // Wait for a billing line newer than our trigger to land in the unified log.
      while (Date.now() < deadline) {
        const hit = readFreshBilling(sinceMs);
        if (hit) {
          const value = toLimits(hit);
          cache = { at: Date.now(), value };
          return value;
        }
        await sleep(1_000);
      }
      return { ok: false, provider: 'grok', windows: [], error: 'timed out waiting for /usage payload' };
    } catch (err) {
      logger.warn('grok-usage: drive failed', { error: (err as Error).message });
      return { ok: false, provider: 'grok', windows: [], error: (err as Error).message };
    } finally {
      await tmux(['kill-session', '-t', SESSION]);
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

let warmTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Keep the Grok usage cache hot so the dashboard endpoint always returns from
 * cache (<5ms) instead of paying the 15-40s cold PTY drive. The panel aborts at
 * 10s (NC_API FETCH_TIMEOUT_MS), so an on-demand cold call is guaranteed to show
 * "fetch failed" — the fix is to warm out-of-band on an interval under the TTL.
 * Fires once shortly after boot, then every ~14 min (< CACHE_TTL_MS). No-op if
 * the CLI isn't logged in, so this is safe to always call.
 */
export function startGrokUsageWarmer(): void {
  if (warmTimer) return;
  if (!authState().ok || !fs.existsSync(grokBin())) return; // nothing to warm
  const warm = () => {
    fetchGrokUsage().then(
      (r) => { if (!r.ok) logger.debug('grok-usage warmer: not ready', { error: r.error }); },
      (err) => logger.debug('grok-usage warmer: failed', { error: (err as Error).message }),
    );
  };
  setTimeout(warm, 8_000);                 // let boot settle, then prime the cache
  warmTimer = setInterval(warm, 14 * 60_000); // refresh before the 15-min TTL lapses
  warmTimer.unref?.();
  logger.info('grok-usage: cache warmer started (prime in 8s, refresh every 14m)');
}
