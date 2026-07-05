// Structured provider-error classification. Maps any thrown error to a
// FailoverReason + recovery hints. Duck-typed (reads err.status / err.message)
// so it needs no provider SDK import and is trivially testable.

export type FailoverReason =
  | 'auth' | 'auth_permanent' | 'billing' | 'rate_limit'
  | 'overloaded' | 'server_error' | 'timeout'
  | 'context_overflow' | 'content_blocked' | 'model_not_found' | 'unknown';

export interface ClassifiedError {
  reason:         FailoverReason;
  httpStatus:     number | null;
  retryable:      boolean;
  shouldCompress: boolean;
  shouldFallback: boolean;
  message:        string;
}

const BILLING_RE   = /insufficient|\bcredits?\b|quota.*exceed|billing|top ?up|payment required/i;
const RATELIMIT_RE = /rate limit|too many requests|throttl/i;
const BLOCKED_RE   = /content (policy|filter)|safety (filter|system)|flagged by/i;
const TIMEOUT_RE   = /timeout|timed out|etimedout|econnreset|socket hang up|network error|enotfound/i;
const CONTEXT_RE   = /context length|maximum context|context window|prompt is too long|input is too long|token.*exceed|reduce the (length|number of tokens)/i;

export function classifyProviderError(err: unknown): ClassifiedError {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr: any = err ?? {};
  const status: number | null =
    typeof anyErr.status === 'number' ? anyErr.status
    : typeof anyErr.httpStatus === 'number' ? anyErr.httpStatus
    : null;
  const message: string =
    err instanceof Error ? err.message
    : typeof anyErr.message === 'string' ? anyErr.message
    : String(err);
  const lower = message.toLowerCase();

  const make = (reason: FailoverReason, over: Partial<ClassifiedError> = {}): ClassifiedError => ({
    reason, httpStatus: status, message,
    retryable: false, shouldCompress: false, shouldFallback: false,
    ...over,
  });

  // Status-code first (most reliable).
  if (status === 401 || status === 403) return make('auth',            { shouldFallback: true });
  if (status === 402)                    return make('billing',         { shouldFallback: true });
  if (status === 404)                    return make('model_not_found', { shouldFallback: true });
  if (status === 413)                    return make('context_overflow',{ shouldCompress: true, retryable: true });
  if (status === 429) {
    if (BILLING_RE.test(lower)) return make('billing', { shouldFallback: true });
    return make('rate_limit', { retryable: true, shouldFallback: true });
  }
  if (status === 500 || status === 502)  return make('server_error', { retryable: true, shouldFallback: true });
  if (status === 503 || status === 529)  return make('overloaded',   { retryable: true, shouldFallback: true });

  // Message-pattern fallback (missing or non-standard status).
  if (RATELIMIT_RE.test(lower)) return make('rate_limit',      { retryable: true, shouldFallback: true });
  if (BILLING_RE.test(lower))   return make('billing',         { shouldFallback: true });
  if (BLOCKED_RE.test(lower))   return make('content_blocked', { retryable: false });
  if (TIMEOUT_RE.test(lower))   return make('timeout',         { retryable: true, shouldFallback: true });
  if (CONTEXT_RE.test(lower))   return make('context_overflow',{ shouldCompress: true, retryable: true });

  return make('unknown', { retryable: true, shouldFallback: true });
}

export type LegacyLlmAction = 'llm_auth_error' | 'llm_rate_limit' | 'llm_server_error' | 'llm_error';

/** Map a FailoverReason to the legacy hive-mind action string used by alfred.ts logging. */
export function reasonToLegacyAction(reason: FailoverReason): LegacyLlmAction {
  switch (reason) {
    case 'auth':
    case 'auth_permanent':
      return 'llm_auth_error';
    case 'rate_limit':
      return 'llm_rate_limit';
    case 'server_error':
    case 'overloaded':
    case 'timeout':
      return 'llm_server_error';
    default:
      return 'llm_error';
  }
}

/**
 * Exponential backoff with additive jitter (0–50% of the capped delay), in ms.
 * attempt is 0-based. Decorrelates concurrent retries against the same provider.
 */
export function jitteredBackoff(attempt: number, baseMs = 250, maxMs = 8000): number {
  const capped = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = Math.random() * 0.5 * capped;
  return Math.round(capped + jitter);
}
