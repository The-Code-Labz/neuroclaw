import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapClaudeSdkMessage } from './claude-events';

test('text_delta stream_event maps to a text event', () => {
  const msg: any = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } };
  assert.deepEqual(mapClaudeSdkMessage(msg), { kind: 'text', delta: 'hi' });
});

test('non-text stream_event maps to null', () => {
  const msg: any = { type: 'stream_event', event: { type: 'content_block_start' } };
  assert.equal(mapClaudeSdkMessage(msg), null);
});

test('assistant rate_limit error maps to a retryable error event', () => {
  const msg: any = { type: 'assistant', error: 'rate_limit' };
  assert.deepEqual(mapClaudeSdkMessage(msg), { kind: 'error', message: 'Claude CLI rate limit', retryable: true });
});

test('assistant auth error maps to a non-retryable error event', () => {
  const msg: any = { type: 'assistant', error: 'authentication_failed' };
  assert.deepEqual(mapClaudeSdkMessage(msg), { kind: 'error', message: 'Claude CLI authentication failed', retryable: false });
});

test('successful result maps to a usage event', () => {
  const msg: any = { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 };
  assert.deepEqual(mapClaudeSdkMessage(msg), { kind: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
});

test('non-success result maps to a non-retryable error event', () => {
  const msg: any = { type: 'result', subtype: 'error_max_turns' };
  assert.deepEqual(mapClaudeSdkMessage(msg), { kind: 'error', message: 'Claude CLI ended with subtype=error_max_turns', retryable: false });
});

test('unknown assistant error maps to a generic non-retryable error event', () => {
  const msg: any = { type: 'assistant', error: 'server_error' };
  assert.deepEqual(mapClaudeSdkMessage(msg), { kind: 'error', message: 'Claude CLI error: server_error', retryable: false });
});
