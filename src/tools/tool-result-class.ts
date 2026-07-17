// Tool-result classification (Hermes absorb #1).
//
// Classifies every tool invocation along two axes:
//   - sideEffect: 'read' (idempotent / safe to discard+retry) vs 'mutate' (has
//     side effects — must verify it landed, never blind-replay).
//   - outcome:    'success' | 'transient' | 'permanent' | 'rate_limited'.
//
// Consumed at the single tool boundary `invokeTool()` in tool-middleware.ts.
// No per-adapter work.

import { TRANSIENT_PATTERNS, FATAL_PATTERNS } from '../system/failure-classifier';

export type ToolOutcome = 'success' | 'transient' | 'permanent' | 'rate_limited';
export type SideEffect = 'read' | 'mutate';
export type ToolCategory = 'retrieval' | 'action' | 'compute' | undefined;

// ── Known transient signatures that the generic regexes alone miss ───────────
// These are provider-specific retryable blips, NOT permanent rejections.
const TRANSIENT_SEEDS: RegExp[] = [
  /design_generation_error/i,                 // Canva transient ML-backend hiccup
  /temporary error/i,
  /please try again/i,
  /try again later/i,
  /over capacity/i,
  /service unavailable/i,
  /socket hang ?up/i,
  /econnreset/i,
  /eai_again/i,
];

// Permanent signatures beyond the provider-agnostic fatal set.
// Safety/moderation rejections are PERMANENT for this prompt — retrying the
// identical prompt can never clear it. Abacus strips these internally, but if
// one escapes we must not treat it as transient.
const PERMANENT_SEEDS: RegExp[] = [
  /sensitive content/i,
  /not allowed by (?:our |the )?safety/i,
  /safety system/i,
  /content that is not allowed/i,
  /content policy/i,
  /content[_ ]policy[_ ]violation/i,
  /different prompt/i,
  /unknown parameter/i,
  /invalid model/i,
  /invalid image config param/i,
  /invalid \w+ for /i,
  /unsupported model/i,
];

const RATE_LIMIT_RE = /\b429\b|\brate\s*limit\b|\btoo\s+many\s+requests\b|\bquota\s*exceeded\b/i;

// ── Side-effect taxonomy ───────────────────────────────────────────────────
// Default is fail-closed: an unclassified tool is treated as mutating. `read`
// requires an explicit category==='retrieval' or an explicit override here.
// The new table only OVERRIDES/fills gaps; it is never a parallel independent
// surface (F7).
const TOOL_TAXONOMY: Record<string, SideEffect> = {
  // Pure stateless lookups that happen to omit category.
  estimate_text_fit: 'read',
};

// Accepted-duplicate-risk generation calls: these mutate external state but the
// only harm from a retry is a duplicate generation, which is acceptable. This
// is the explicit override that unblocks Canva design_generation_error and
// Abacus capacity blips (F3).
const RETRY_SAFE_MUTATE = new Set<string>([
  'abacus_image',
  'generate-design',
  'mcp__canva__generate-design',
  'voidai_image',
  'kie_image',
  'fal_image',
  'generate_image',
  'generate_image_venice',
  'gemini_web_generate_image',
  'grok_web_generate_image',
]);

export function getSideEffect(name: string, category?: ToolCategory): SideEffect {
  if (category === 'retrieval') return 'read';
  if (category === 'action')    return 'mutate';
  if (category === 'compute')   return 'mutate'; // fail-closed
  return TOOL_TAXONOMY[name] ?? 'mutate';
}

export function isRetrySafe(name: string, category?: ToolCategory): boolean {
  const sideEffect = getSideEffect(name, category);
  if (sideEffect === 'read') return true;
  return RETRY_SAFE_MUTATE.has(name);
}

// ── Error surface extraction ───────────────────────────────────────────────
function extractErrorSurface(result: unknown, error: unknown): {
  message: string;
  status?: number;
  retriedInternally: boolean;
} {
  let message = '';
  let status: number | undefined;
  let retriedInternally = false;

  if (error !== undefined && error !== null) {
    const e = error as { message?: string; status?: number; retriedInternally?: boolean };
    message = e.message ?? String(error);
    status = typeof e.status === 'number' ? e.status : undefined;
    if (e.retriedInternally === true) retriedInternally = true;
  }

  if (result && typeof result === 'object') {
    const r = result as {
      ok?: unknown;
      error?: string;
      status?: number;
      retriedInternally?: boolean;
      isError?: boolean;
    };
    if (r.retriedInternally === true) retriedInternally = true;
    if (r.ok === false || r.isError === true) {
      const errPart = r.error ?? '';
      if (errPart) message = errPart;
      if (typeof r.status === 'number') status = r.status;
    }
  }

  return { message, status, retriedInternally };
}

/**
 * Classify a tool result or thrown error.
 *
 * Priority: rate_limited → transient → permanent → (unknown → permanent).
 * The transient set is seeded with the known motivating cases and reuses the
 * existing failure-classifier constants where shapes overlap (F6).
 */
export function classifyOutcome(result: unknown, error?: unknown): ToolOutcome {
  const surface = extractErrorSurface(result, error);
  const msg = surface.message;

  if (!msg && !error) {
    // A result object with ok:false but no error message is still a failure.
    if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
      return 'permanent';
    }
    return 'success';
  }

  const text = msg.toLowerCase();

  // Already retried inside the provider helper → boundary must NOT retry again.
  // We still surface it as the most appropriate class for telemetry.
  if (surface.retriedInternally) {
    if (RATE_LIMIT_RE.test(text)) return 'rate_limited';
    if (isTransientText(text)) return 'transient';
    return 'permanent';
  }

  if (RATE_LIMIT_RE.test(text)) return 'rate_limited';
  if (isTransientText(text)) return 'transient';
  if (isPermanentText(text)) return 'permanent';

  // Unknown failure surface: fail-closed (do not blind-retry).
  return 'permanent';
}

function isTransientText(text: string): boolean {
  if (PERMANENT_SEEDS.some(re => re.test(text))) return false;
  if (TRANSIENT_SEEDS.some(re => re.test(text))) return true;
  if (TRANSIENT_PATTERNS.some(re => re.test(text))) return true;
  return false;
}

function isPermanentText(text: string): boolean {
  if (PERMANENT_SEEDS.some(re => re.test(text))) return true;
  if (FATAL_PATTERNS.some(re => re.test(text))) return true;
  // Generic 4xx client errors (except 429, handled above) are permanent.
  if (/\b4\d{2}\b/.test(text) && !/\b429\b/.test(text)) return true;
  return false;
}

/**
 * Parse a Retry-After value from an error/result surface. Returns undefined when
 * not present or not parseable. Honored only for rate_limited outcomes.
 */
export function parseRetryAfterMs(error: unknown, result: unknown): number | undefined {
  const e = error as { retryAfter?: number | string; headers?: Record<string, string> } | undefined;
  const r = result as { retryAfter?: number | string; headers?: Record<string, string> } | undefined;
  const raw = e?.retryAfter ?? e?.headers?.['retry-after'] ?? r?.retryAfter ?? r?.headers?.['retry-after'];
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return undefined;
}
