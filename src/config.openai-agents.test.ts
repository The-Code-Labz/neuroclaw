import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config';

test('openaiAgents.providers parses a comma list, trims, drops blanks', () => {
  process.env.OPENAI_AGENTS_PROVIDERS = ' openrouter , voidai ,, ';
  assert.deepEqual(config.openaiAgents.providers, ['openrouter', 'voidai']);
});

test('openaiAgents.providers is empty when unset', () => {
  delete process.env.OPENAI_AGENTS_PROVIDERS;
  assert.deepEqual(config.openaiAgents.providers, []);
});
