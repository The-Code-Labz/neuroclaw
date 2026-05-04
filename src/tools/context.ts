// Shared context passed to every tool handler. Adapters fill in what they
// know — OpenAI chat path supplies onMeta + sessionId; HTTP-MCP path supplies
// agentId resolved from a header. Handlers tolerate any field being absent.

import type { MetaEvent } from '../agent/alfred';

export interface ToolContext {
  /** Calling agent (for write attribution, gating, recursive chatStream parent). */
  agentId?:   string | null;
  /** Current chat session, if any. Some tools annotate writes with it. */
  sessionId?: string | null;
  /** Optional dashboard SSE event sink; only the OpenAI chat path attaches one. */
  onMeta?:    (e: MetaEvent) => void | Promise<void>;
}
