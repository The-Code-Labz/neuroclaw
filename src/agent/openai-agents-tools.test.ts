import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentsSdkTools, backboneEnabled } from './openai-agents-tools';

test('backboneEnabled reflects OPENAI_AGENTS_PROVIDERS', () => {
  process.env.OPENAI_AGENTS_PROVIDERS = 'openrouter';
  assert.equal(backboneEnabled('openrouter'), true);
  assert.equal(backboneEnabled('voidai'), false);
  delete process.env.OPENAI_AGENTS_PROVIDERS;
  assert.equal(backboneEnabled('openrouter'), false);
});

test('buildAgentsSdkTools returns SDK tools for core+meta with non-empty params', async () => {
  const tools = await buildAgentsSdkTools({ agentId: undefined, sessionId: 's1' } as any);
  assert.ok(tools.length > 0, 'expected at least one tool');
  const names = tools.map((t: any) => t.name);
  assert.ok(names.includes('search_tools'), `expected search_tools in ${names.join(',')}`);
  for (const t of tools as any[]) {
    assert.equal(typeof t.parameters, 'object');
    assert.ok(!('_def' in t.parameters), 'parameters must be JSON schema, not a Zod schema');
  }
});
