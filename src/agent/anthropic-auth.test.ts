import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAnthropicAuthStatus } from './anthropic-auth';

test('getAnthropicAuthStatus returns a status with a known source', () => {
  const status = getAnthropicAuthStatus();
  assert.ok(['api_key', 'cli_oauth', 'none'].includes(status.source));
});
