// Pure mappings between the @openai/agents SDK stream/input shapes and our
// internal representations. No I/O — unit-tested with synthetic inputs.
import type { BackendEvent } from './types/backend-event';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdkEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHistoryMsg = any;

/** Best-effort tool name from a RunItem (shape varies by item kind). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolNameOf(item: any): string {
  return item?.rawItem?.name ?? item?.name ?? item?.rawItem?.toolName ?? 'tool';
}

/**
 * Map ONE @openai/agents stream event to a BackendEvent, or null to ignore.
 * Handles the streamed kinds (text delta, tool start/output). The terminal
 * 'done'/'error' events are emitted by the backbone runner, not here.
 */
export function mapSdkEvent(ev: AnySdkEvent): BackendEvent | null {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'raw_model_stream_event') {
    const d = ev.data;
    if (d && d.type === 'output_text_delta' && typeof d.delta === 'string') {
      return { kind: 'text', delta: d.delta };
    }
    return null;
  }
  if (ev.type === 'run_item_stream_event') {
    if (ev.name === 'tool_called') {
      return { kind: 'tool_start', tool: toolNameOf(ev.item), server: 'local' };
    }
    if (ev.name === 'tool_output') {
      return { kind: 'tool_done', tool: toolNameOf(ev.item), ok: true, server: 'local' };
    }
    return null;
  }
  return null;
}

/** Extract the plain-text body of an OpenAI-format message content. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => p.text)
      .join('');
  }
  return '';
}

/**
 * Map our OpenAI-format conversation history to @openai/agents input items.
 * Only user/assistant turns that have text content are kept. System and tool
 * messages are dropped. Tool-call-only assistant turns (content is null/empty)
 * are dropped by the `!text` guard — no separate check needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toAgentInput(history: AnyHistoryMsg[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;        // skip system + tool
    const text = contentText(m.content);
    if (!text) continue;   // drops tool-call-only assistant turns (no text) too
    out.push({ role: m.role, content: text });
  }
  return out;
}
