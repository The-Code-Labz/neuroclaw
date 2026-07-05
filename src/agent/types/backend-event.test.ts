import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeBackendEvent, type BackendEvent } from './backend-event';
import type { MetaEvent } from '../alfred';

function makeSink() {
  const chunks: string[] = [];
  const metas: MetaEvent[] = [];
  return {
    chunks, metas,
    sink: {
      onChunk: (c: string) => { chunks.push(c); },
      onMeta:  (e: MetaEvent) => { metas.push(e); },
    },
  };
}

test('text event forwards to onChunk and is non-terminal', async () => {
  const { chunks, sink } = makeSink();
  const terminal = await bridgeBackendEvent({ kind: 'text', delta: 'hello' }, sink);
  assert.equal(terminal, false);
  assert.deepEqual(chunks, ['hello']);
});

test('tool_start maps to mcp_call_start meta', async () => {
  const { metas, sink } = makeSink();
  await bridgeBackendEvent({ kind: 'tool_start', tool: 'fs_read', server: 'neuroclaw' }, sink);
  assert.deepEqual(metas, [{ type: 'mcp_call_start', server: 'neuroclaw', tool: 'fs_read' }]);
});

test('done event is terminal and emits nothing', async () => {
  const { chunks, metas, sink } = makeSink();
  const terminal = await bridgeBackendEvent({ kind: 'done' }, sink);
  assert.equal(terminal, true);
  assert.equal(chunks.length, 0);
  assert.equal(metas.length, 0);
});

test('error event is terminal and emits an error meta', async () => {
  const { metas, sink } = makeSink();
  const ev: BackendEvent = { kind: 'error', message: 'boom', retryable: true };
  const terminal = await bridgeBackendEvent(ev, sink);
  assert.equal(terminal, true);
  assert.deepEqual(metas, [{ type: 'error', error: 'boom' }]);
});

test('tool_done maps to mcp_call_done meta and is non-terminal', async () => {
  const { metas, sink } = makeSink();
  const terminal = await bridgeBackendEvent({ kind: 'tool_done', tool: 'fs_read', server: 'neuroclaw', ok: true }, sink);
  assert.equal(terminal, false);
  assert.deepEqual(metas, [{ type: 'mcp_call_done', server: 'neuroclaw', tool: 'fs_read', length: 0 }]);
});

test('thinking event emits nothing and is non-terminal', async () => {
  const { chunks, metas, sink } = makeSink();
  const terminal = await bridgeBackendEvent({ kind: 'thinking', delta: 'pondering' }, sink);
  assert.equal(terminal, false);
  assert.equal(chunks.length, 0);
  assert.equal(metas.length, 0);
});

test('usage event emits nothing and is non-terminal', async () => {
  const { chunks, metas, sink } = makeSink();
  const terminal = await bridgeBackendEvent({ kind: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, sink);
  assert.equal(terminal, false);
  assert.equal(chunks.length, 0);
  assert.equal(metas.length, 0);
});
