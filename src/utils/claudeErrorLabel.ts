// Claude CLI error label translation (claude-code-abort-fix spec).
//
// The @anthropic-ai/claude-agent-sdk surfaces ALL programmatic AbortController
// signals as the misleading message "Claude Code process aborted by user".
// That label suggests user-initiated cancellation, but in our logs it almost
// always means a timeout or an internal abort signal — the user did nothing.
//
// This helper translates the raw SDK message at log sites so triage isn't
// actively misled. The thrown Error object is never mutated; only what we
// emit to logger.{warn,error} changes.
//
// Pair with isTimeoutAbort() in job-worker.ts — that classifier decides
// whether to retry; this helper decides what to PRINT.

export function translateClaudeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return '(unknown error)';

  // Order matters — check more specific patterns before generic ones.
  if (msg.includes('aborted by user')) {
    return 'Claude CLI subprocess aborted (timeout or signal)';
  }
  // Surface a different label when the abort came from the AbortController
  // standard message rather than the SDK's "by user" string. This pattern
  // matches ANY AbortController timeout (TTS fetch, Claude CLI, etc.) — not
  // just Claude CLI — so we use a provider-neutral label here.
  if (msg === 'This operation was aborted') {
    return 'Operation timed out (AbortController fired)';
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return `Claude CLI aborted: ${msg}`;
  }
  if (msg.includes('rate limit') || msg.includes('429')) {
    return 'Claude CLI rate limited';
  }
  if (msg.includes('authentication') || msg.includes('401')) {
    return 'Claude CLI auth failure';
  }
  // SDK error kinds that previously fell through as raw strings, leaving
  // triage unable to tell retriable from permanent (audit blue-4).
  if (msg.includes('billing_error') || msg.includes('credit balance')) {
    return 'Claude billing error — check plan/credits (non-retriable)';
  }
  if (msg.includes('server_error') || msg.includes('overloaded') || msg.includes('529')) {
    return 'Claude API server error (transient — retriable)';
  }
  if (msg.includes('max_output_tokens')) {
    return 'Claude hit max_output_tokens — response truncated (shorten the task or raise the cap)';
  }
  if (msg.includes('invalid_request')) {
    return 'Claude invalid request (non-retriable — likely malformed input or unsupported option)';
  }

  // No translation needed — return the original message untouched.
  return msg;
}

/**
 * Classifier used by retry-decision points (job-worker, future retry sites).
 *
 * Returns true ONLY when the error is unambiguously an abort signal — never
 * for generic "timeout" strings in error messages (e.g. "Database connection
 * timeout" or "Request timeout from upstream") which ARE retriable.
 *
 * Per the spec's review note: a bare 'timeout' match would suppress retries on
 * unrelated failures. We match only on explicit AbortError / SIGTERM patterns.
 */
export function isTimeoutAbort(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  return (
    msg.includes('aborted by user') ||              // SDK label
    msg === 'This operation was aborted' ||         // AbortError standard message
    msg.includes('SIGTERM')                         // process-level kill signal
    // NOTE: deliberately NOT matching bare 'timeout' here.
  );
}
