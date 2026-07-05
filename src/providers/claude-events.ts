// Pure mapper: Claude Agent SDK `SDKMessage` → internal BackendEvent.
// Mirrors the live logic in claude-cli.ts (extractTextChunk / detectError /
// result-usage). Kept pure + standalone so it is unit-testable and so the live
// generator can adopt it later without behavior change.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackendEvent } from '../agent/types/backend-event';
import { logger } from '../utils/logger';

// Message types we KNOW carry nothing we stream (returning null is correct).
// Anything outside this set is a new/changed SDK message kind — warn once per
// type so an SDK upgrade that silently drops content is visible immediately
// instead of presenting as a wedged "thinking" placeholder.
const KNOWN_PASSTHROUGH_TYPES = new Set(['system', 'user', 'assistant', 'stream_event', 'result']);
const warnedUnknownTypes = new Set<string>();

export function mapClaudeSdkMessage(msg: SDKMessage): BackendEvent | null {
  // Text deltas.
  if (msg.type === 'stream_event') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev: any = (msg as any).event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      return { kind: 'text', delta: ev.delta.text as string };
    }
    return null;
  }

  // Assistant-level errors.
  if (msg.type === 'assistant' && msg.error) {
    const e = msg.error;
    if (e === 'rate_limit')            return { kind: 'error', message: 'Claude CLI rate limit', retryable: true };
    if (e === 'authentication_failed') return { kind: 'error', message: 'Claude CLI authentication failed', retryable: false };
    // Other SDK error kinds (billing_error, server_error, invalid_request, unknown,
    // max_output_tokens) fall through as non-retryable, mirroring the live
    // detectError() behavior in claude-cli.ts. Refine per-kind during live-wiring.
    return { kind: 'error', message: `Claude CLI error: ${e}`, retryable: false };
  }

  // Terminal result: either an error subtype or success-with-usage.
  if (msg.type === 'result') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = msg;
    if (m.subtype && m.subtype !== 'success') {
      return { kind: 'error', message: `Claude CLI ended with subtype=${m.subtype}`, retryable: false };
    }
    return {
      kind: 'usage',
      inputTokens:  m.usage?.input_tokens,
      outputTokens: m.usage?.output_tokens,
      costUsd:      m.total_cost_usd,
    };
  }

  const t = (msg as { type?: string }).type ?? '(undefined)';
  if (!KNOWN_PASSTHROUGH_TYPES.has(t) && !warnedUnknownTypes.has(t)) {
    warnedUnknownTypes.add(t);
    logger.warn('claude-events: unhandled SDK message type — dropped (new SDK event kind?)', { type: t });
  }
  return null;
}
