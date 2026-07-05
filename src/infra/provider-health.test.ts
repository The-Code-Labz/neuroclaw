import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCooldownMs, extractRetryAfterMs } from './provider-health';

test('auth cools 5 minutes, never dead', () => {
  assert.equal(computeCooldownMs('auth', 1), 5 * 60_000);
  assert.equal(computeCooldownMs('auth', 10), 5 * 60_000);
});

test('rate_limit honors retry-after, else 60 minutes', () => {
  assert.equal(computeCooldownMs('rate_limit', 1, 30_000), 30_000);
  assert.equal(computeCooldownMs('rate_limit', 1), 60 * 60_000);
  assert.equal(computeCooldownMs('rate_limit', 1, 0), 60 * 60_000);
});

test('billing cools 60 minutes', () => {
  assert.equal(computeCooldownMs('billing', 1), 60 * 60_000);
});

test('server errors back off exponentially, capped at 30 minutes', () => {
  assert.equal(computeCooldownMs('server_error', 1), 2 * 60_000);
  assert.equal(computeCooldownMs('server_error', 2), 4 * 60_000);
  assert.equal(computeCooldownMs('server_error', 3), 8 * 60_000);
  assert.equal(computeCooldownMs('server_error', 10), 30 * 60_000); // capped
  assert.equal(computeCooldownMs('overloaded', 1), 2 * 60_000);
  assert.equal(computeCooldownMs('timeout', 1), 2 * 60_000);
});

test('request-specific classes never poison provider health', () => {
  assert.equal(computeCooldownMs('context_overflow', 1), null);
  assert.equal(computeCooldownMs('content_blocked', 1), null);
  assert.equal(computeCooldownMs('model_not_found', 1), null);
  assert.equal(computeCooldownMs('unknown', 1), null);
});

test('auth_permanent maps to Infinity (dead)', () => {
  assert.equal(computeCooldownMs('auth_permanent', 1), Number.POSITIVE_INFINITY);
});

test('extractRetryAfterMs reads numeric retry-after header (seconds)', () => {
  assert.equal(extractRetryAfterMs({ headers: { 'retry-after': '30' }, message: 'rate limited' }), 30_000);
});

test('extractRetryAfterMs parses "try again in Ns" message text', () => {
  assert.equal(extractRetryAfterMs(new Error('Rate limit exceeded. Please try again in 20s')), 20_000);
  assert.equal(extractRetryAfterMs(new Error('throttled — retry in 5 minutes')), 5 * 60_000);
});

test('extractRetryAfterMs returns null when nothing is parseable', () => {
  assert.equal(extractRetryAfterMs(new Error('boom')), null);
  assert.equal(extractRetryAfterMs(undefined), null);
});
