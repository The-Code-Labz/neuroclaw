import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';

// ── Types ──────────────────────────────────────────────────────────────────

type CodexUsageResponse = {
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
};

export type CodexUsageWindow = {
  label: string;        // e.g. "3h", "Day", "Week"
  usedPercent: number;  // 0–100
  resetAt?: number;     // unix ms
};

export type CodexUsageSnapshot = {
  ok: boolean;
  provider: 'codex';
  windows: CodexUsageWindow[];
  plan?: string;         // e.g. "plus", "pro ($12.50)"
  error?: string;
  tokenExpired?: boolean;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function clampPercent(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

// If the secondary reset_at is > 3 days after the primary, it's a weekly window.
const WEEKLY_RESET_GAP_SECONDS = 3 * 24 * 60 * 60;

function resolveSecondaryWindowLabel(params: {
  windowHours: number;
  secondaryResetAt?: number;
  primaryResetAt?: number;
}): string {
  if (params.windowHours >= 168) return 'Week';
  if (params.windowHours < 24) return `${params.windowHours}h`;
  if (
    typeof params.secondaryResetAt === 'number' &&
    typeof params.primaryResetAt === 'number' &&
    params.secondaryResetAt - params.primaryResetAt >= WEEKLY_RESET_GAP_SECONDS
  ) {
    return 'Week';
  }
  return 'Day';
}

function readCodexAuthToken(): string | null {
  try {
    const authFile = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(authFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(authFile, 'utf-8')) as {
      tokens?: string | { access_token?: string } | null;
    };
    // tokens may be a raw string or an object with access_token
    if (typeof parsed.tokens === 'string') return parsed.tokens || null;
    if (typeof parsed.tokens === 'object' && parsed.tokens !== null) {
      return (parsed.tokens as { access_token?: string }).access_token ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Main fetcher ───────────────────────────────────────────────────────────

const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_TIMEOUT_MS = 8_000;

export async function fetchCodexUsage(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CodexUsageSnapshot> {
  const token = readCodexAuthToken();

  if (!token) {
    return {
      ok: false,
      provider: 'codex',
      windows: [],
      error: 'No Codex auth token found — run `codex login`',
      tokenExpired: false,
    };
  }

  let res: Response;
  try {
    res = await fetch(WHAM_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn('codex-usage: fetch failed', { error: message });
    return { ok: false, provider: 'codex', windows: [], error: `Network error: ${message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      provider: 'codex',
      windows: [],
      error: `Auth error (${res.status}) — token may be expired`,
      tokenExpired: true,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      provider: 'codex',
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }

  let data: CodexUsageResponse;
  try {
    data = (await res.json()) as CodexUsageResponse;
  } catch {
    return { ok: false, provider: 'codex', windows: [], error: 'Failed to parse response JSON' };
  }

  const windows: CodexUsageWindow[] = [];

  if (data.rate_limit?.primary_window) {
    const pw = data.rate_limit.primary_window;
    const windowHours = Math.round((pw.limit_window_seconds ?? 10800) / 3600);
    windows.push({
      label: `${windowHours}h`,
      usedPercent: clampPercent(pw.used_percent ?? 0),
      resetAt: pw.reset_at ? pw.reset_at * 1000 : undefined,
    });
  }

  if (data.rate_limit?.secondary_window) {
    const sw = data.rate_limit.secondary_window;
    const windowHours = Math.round((sw.limit_window_seconds ?? 86400) / 3600);
    const label = resolveSecondaryWindowLabel({
      windowHours,
      primaryResetAt: data.rate_limit?.primary_window?.reset_at,
      secondaryResetAt: sw.reset_at,
    });
    windows.push({
      label,
      usedPercent: clampPercent(sw.used_percent ?? 0),
      resetAt: sw.reset_at ? sw.reset_at * 1000 : undefined,
    });
  }

  // Build plan string — include credit balance if present
  let plan = data.plan_type;
  if (data.credits?.balance != null) {
    const balance =
      typeof data.credits.balance === 'number'
        ? data.credits.balance
        : parseFloat(String(data.credits.balance)) || 0;
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return {
    ok: true,
    provider: 'codex',
    windows,
    ...(plan ? { plan } : {}),
  };
}
