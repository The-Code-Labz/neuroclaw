import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSdkEvent, toAgentInput } from './openai-agents-events';

test('mapSdkEvent: output_text_delta → text', () => {
  const ev = { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'hi' } };
  assert.deepEqual(mapSdkEvent(ev as any), { kind: 'text', delta: 'hi' });
});

test('mapSdkEvent: non-text raw event → null', () => {
  const ev = { type: 'raw_model_stream_event', data: { type: 'response.created' } };
  assert.equal(mapSdkEvent(ev as any), null);
});

test('mapSdkEvent: tool_called → tool_start with server local', () => {
  const ev = { type: 'run_item_stream_event', name: 'tool_called', item: { rawItem: { name: 'search_memory' } } };
  assert.deepEqual(mapSdkEvent(ev as any), { kind: 'tool_start', tool: 'search_memory', server: 'local' });
});

test('mapSdkEvent: tool_output → tool_done ok', () => {
  const ev = { type: 'run_item_stream_event', name: 'tool_output', item: { rawItem: { name: 'search_memory' } } };
  assert.deepEqual(mapSdkEvent(ev as any), { kind: 'tool_done', tool: 'search_memory', ok: true, server: 'local' });
});

test('mapSdkEvent: unknown run item name → null', () => {
  const ev = { type: 'run_item_stream_event', name: 'reasoning_item_created', item: {} };
  assert.equal(mapSdkEvent(ev as any), null);
});

test('toAgentInput: maps user/assistant text, skips system + tool artifacts', () => {
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] },
    { role: 'tool', tool_call_id: 'x', content: 'result' },
    { role: 'user', content: 'again' },
  ];
  assert.deepEqual(toAgentInput(history as any), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'again' },
  ]);
});

test('toAgentInput: flattens multimodal user content to its text parts', () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'x' } }] },
  ];
  assert.deepEqual(toAgentInput(history as any), [{ role: 'user', content: 'describe' }]);
});

test('toAgentInput: keeps text of a mixed text+tool_calls assistant turn', () => {
  const history = [
    { role: 'assistant', content: 'thinking out loud', tool_calls: [{ id: 'x' }] },
    { role: 'user', content: 'ok' },
  ];
  assert.deepEqual(toAgentInput(history as any), [
    { role: 'assistant', content: 'thinking out loud' },
    { role: 'user', content: 'ok' },
  ]);
});
