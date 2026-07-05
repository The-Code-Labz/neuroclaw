// The internal backend event contract. Every model backbone (Claude Agent SDK,
// OpenAI Agents SDK, Antigravity sidecar, CLI relays) normalizes its native
// stream into this single discriminated union. Downstream consumers (SSE, CLI)
// read ONLY this type.
//
// Contract (enforced by convention + the bridge below):
//   - Adapters NEVER throw mid-stream. A failure is emitted as { kind: 'error' }.
//   - Every stream terminates with exactly ONE terminal event: 'done' or 'error'.
//   - Partial output already emitted via 'text' is preserved on 'error'.
//
// This file deliberately does NOT depend on the Phase 2 error classifier, so the
// two phases can ship independently. The 'error' event carries a plain message +
// a coarse `retryable` flag; richer classification is attached by the caller.

import type { MetaEvent } from '../alfred';

export interface BackendTextEvent      { kind: 'text';       delta: string; }
export interface BackendThinkingEvent  { kind: 'thinking';   delta: string; }
export interface BackendToolStartEvent { kind: 'tool_start'; tool: string; server?: string; }
export interface BackendToolDoneEvent  { kind: 'tool_done';  tool: string; server?: string; ok: boolean; }
export interface BackendUsageEvent     { kind: 'usage';      inputTokens?: number; outputTokens?: number; costUsd?: number; }
export interface BackendDoneEvent      { kind: 'done'; }
export interface BackendErrorEvent     { kind: 'error';      message: string; retryable: boolean; }

export type BackendEvent =
  | BackendTextEvent
  | BackendThinkingEvent
  | BackendToolStartEvent
  | BackendToolDoneEvent
  | BackendUsageEvent
  | BackendDoneEvent
  | BackendErrorEvent;

export interface BackendEventSink {
  onChunk: (chunk: string) => void | Promise<void>;
  onMeta?: (e: MetaEvent) => void | Promise<void>;
}

/**
 * Translate ONE BackendEvent into the legacy callback surface.
 * Returns true if the event was terminal ('done' | 'error').
 */
export async function bridgeBackendEvent(ev: BackendEvent, sink: BackendEventSink): Promise<boolean> {
  switch (ev.kind) {
    case 'text':
      await sink.onChunk(ev.delta);
      return false;
    case 'thinking':
      // UIs currently hide reasoning deltas; drop for now.
      return false;
    case 'tool_start':
      await sink.onMeta?.({ type: 'mcp_call_start', server: ev.server ?? '', tool: ev.tool });
      return false;
    case 'tool_done':
      // Note: the legacy `mcp_call_done` MetaEvent has no field for tool-result
      // success/failure, so `ev.ok` is intentionally not propagated; and `length`
      // (result byte length) is unknown at event-emit time, so it is set to 0.
      await sink.onMeta?.({ type: 'mcp_call_done', server: ev.server ?? '', tool: ev.tool, length: 0 });
      return false;
    case 'usage':
      // Token/cost accounting is handled by the provider's onUsage path; nothing to surface here.
      return false;
    case 'done':
      return true;
    case 'error':
      await sink.onMeta?.({ type: 'error', error: ev.message });
      return true;
  }
}
