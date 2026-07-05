// Shared context passed to every tool handler. Adapters fill in what they
// know — OpenAI chat path supplies onMeta + sessionId; HTTP-MCP path supplies
// agentId resolved from a header. Handlers tolerate any field being absent.

import type { MetaEvent } from '../agent/alfred';

export interface ToolContext {
  /** Calling agent (for write attribution, gating, recursive chatStream parent). */
  agentId?:    string | null;
  /** Current chat session, if any. Some tools annotate writes with it. */
  sessionId?:  string | null;
  /** Optional dashboard SSE event sink; only the OpenAI chat path attaches one. */
  onMeta?:     (e: MetaEvent) => void | Promise<void>;
  /** Active run id (v2.0). Tool handlers that recursively call chatStream pass
   *  this through so every event in the spawned turn rolls up under the same
   *  parent run. Optional — null when the tool path has no active run. */
  runId?:      string | null;
  /** Depth of sub-agent nesting. 0 = top-level agent. run_subtask is suppressed
   *  at depth >= 1 to prevent recursive sub-agent chains. */
  spawnDepth?: number;
  /** Tools the parent agent explicitly permits for this sub-agent run.
   *  Overrides the blockedTools list in config.subAgent.blockedTools.
   *  See specs/sub-agent-tool-lockdown.md Fix 5. */
  allowedToolOverrides?: string[];
}
