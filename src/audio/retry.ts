// Wraps fetch with 429-aware retry: honors Retry-After header when present,
// falls back to exponential backoff with jitter (500 ms → 1 500 ms).
// Each attempt gets its own AbortController so timeoutMs is per-attempt.

export async function fetchRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  maxAttempts = 3,
): Promise<Response> {
  const { timeoutMs = 30_000, ...fetchInit } = init;
  if (maxAttempts < 1) throw new Error('fetchRetry: maxAttempts must be >= 1');
  let res: Response;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ac    = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      res = await fetch(url, { ...fetchInit, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.status !== 429 || attempt === maxAttempts - 1) return res;

    const after    = res.headers.get('Retry-After');
    const parsed   = after ? parseFloat(after) * 1000 : NaN;
    const delayMs  = Number.isFinite(parsed) && parsed > 0
      ? parsed
      : 500 * (3 ** attempt) + Math.random() * 200;
    await new Promise<void>(r => setTimeout(r, delayMs));
  }

  return res!;
}
