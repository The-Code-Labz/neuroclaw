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
  /** Active run id (v2.0). Tool handlers that recursively call chatStream pass
   *  this through so every event in the spawned turn rolls up under the same
   *  parent run. Optional — null when the tool path has no active run. */
  runId?:     string | null;
}
