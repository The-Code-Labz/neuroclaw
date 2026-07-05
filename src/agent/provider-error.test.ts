import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, jitteredBackoff } from './provider-error';

test('401 -> auth, not retryable, should fallback', () => {
  const c = classifyProviderError({ status: 401, message: 'invalid api key' });
  assert.equal(c.reason, 'auth');
  assert.equal(c.retryable, false);
  assert.equal(c.shouldFallback, true);
});

test('402 -> billing', () => {
  assert.equal(classifyProviderError({ status: 402, message: 'payment required' }).reason, 'billing');
});

test('429 with credit language -> billing', () => {
  assert.equal(classifyProviderError({ status: 429, message: 'insufficient credits, please top up' }).reason, 'billing');
});

test('429 plain -> rate_limit, retryable', () => {
  const c = classifyProviderError({ status: 429, message: 'rate limit exceeded' });
  assert.equal(c.reason, 'rate_limit');
  assert.equal(c.retryable, true);
});

test('502 -> server_error, retryable', () => {
  assert.equal(classifyProviderError({ status: 502, message: 'bad gateway' }).reason, 'server_error');
});

test('503 -> overloaded', () => {
  assert.equal(classifyProviderError({ status: 503, message: 'service unavailable' }).reason, 'overloaded');
});

test('413 -> context_overflow, should compress', () => {
  const c = classifyProviderError({ status: 413, message: 'payload too large' });
  assert.equal(c.reason, 'context_overflow');
  assert.equal(c.shouldCompress, true);
});

test('timeout message with no status -> timeout', () => {
  assert.equal(classifyProviderError({ message: 'socket hang up ETIMEDOUT' }).reason, 'timeout');
});

test('content policy message -> content_blocked, not retryable', () => {
  const c = classifyProviderError({ message: 'request blocked by content policy' });
  assert.equal(c.reason, 'content_blocked');
  assert.equal(c.retryable, false);
});

test('unknown -> retryable fallback', () => {
  const c = classifyProviderError({ message: 'who knows' });
  assert.equal(c.reason, 'unknown');
  assert.equal(c.retryable, true);
});

test('jitteredBackoff attempt 0 is within [base, base*1.5]', () => {
  for (let i = 0; i < 50; i++) {
    const d = jitteredBackoff(0, 250, 8000);
    assert.ok(d >= 250 && d <= 375, `got ${d}`);
  }
});

test('jitteredBackoff is capped at maxMs (+jitter)', () => {
  for (let i = 0; i < 50; i++) {
    const d = jitteredBackoff(20, 250, 8000); // 250*2^20 >> max -> capped at 8000
    assert.ok(d >= 8000 && d <= 12000, `got ${d}`);
  }
});

test('403 -> auth', () => {
  assert.equal(classifyProviderError({ status: 403, message: 'forbidden' }).reason, 'auth');
});
test('404 -> model_not_found', () => {
  assert.equal(classifyProviderError({ status: 404, message: 'model not found' }).reason, 'model_not_found');
});
test('500 -> server_error', () => {
  assert.equal(classifyProviderError({ status: 500, message: 'internal error' }).reason, 'server_error');
});
test('529 -> overloaded', () => {
  assert.equal(classifyProviderError({ status: 529, message: 'overloaded' }).reason, 'overloaded');
});
test('message-only billing (no status) -> billing', () => {
  assert.equal(classifyProviderError({ message: 'your account has insufficient credits' }).reason, 'billing');
});
test('message-only context overflow (no status) -> context_overflow, compress', () => {
  const c = classifyProviderError({ message: 'maximum context length exceeded' });
  assert.equal(c.reason, 'context_overflow');
  assert.equal(c.shouldCompress, true);
});
test('network "blocked" is NOT content_blocked (regex tightened)', () => {
  const c = classifyProviderError({ message: 'request blocked by firewall' });
  assert.notEqual(c.reason, 'content_blocked');
});

import { reasonToLegacyAction } from './provider-error';

test('reasonToLegacyAction maps reasons to legacy action strings', () => {
  assert.equal(reasonToLegacyAction('auth'),           'llm_auth_error');
  assert.equal(reasonToLegacyAction('auth_permanent'), 'llm_auth_error');
  assert.equal(reasonToLegacyAction('rate_limit'),     'llm_rate_limit');
  assert.equal(reasonToLegacyAction('server_error'),   'llm_server_error');
  assert.equal(reasonToLegacyAction('overloaded'),     'llm_server_error');
  assert.equal(reasonToLegacyAction('timeout'),        'llm_server_error');
  assert.equal(reasonToLegacyAction('billing'),        'llm_error');
  assert.equal(reasonToLegacyAction('unknown'),        'llm_error');
});
