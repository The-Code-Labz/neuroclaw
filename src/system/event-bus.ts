// Process-wide event bus for live agent activity (v3.2). The dashboard
// /api/chat handler emits AgentEvents here in parallel with writing SSE
// chunks; /api/chat/resume subscribes to forward those events to a
// reconnecting client without disturbing the in-flight agent loop.
//
// This is intentionally cross-cutting: alfred.ts and the route handler
// both produce events, the resume handler consumes them. Keep the schema
// small and additive — it's serialized to JSON and crosses an HTTP boundary.

import { EventEmitter } from 'node:events';

export type AgentEvent =
  | {
      type:      'chunk';
      sessionId: string;
      runId:     string;
      content:   string;
      /** Length of runs.partial_output BEFORE this chunk was appended. Lets a
       *  resuming client (which replays partial_output as a snapshot) drop
       *  chunks already contained in its snapshot instead of duplicating them. */
      offset?:   number;
    }
  | {
      /** Passthrough for the chat handler's meta SSE events (step_chunk,
       *  spawn_chunk, plan, tool_start, agent_image, …). `event` is the exact
       *  client-facing SSE payload; resume forwards it verbatim so a
       *  re-attached tab sees the same sub-agent/step activity as the
       *  primary stream. */
      type:      'meta';
      sessionId: string;
      runId:     string;
      event:     Record<string, unknown>;
    }
  | {
      type:            'heartbeat';
      sessionId:       string;
      runId:           string;
      agentId:         string;
      turn:            number;
      elapsedMs:       number;
      currentActivity: string;
    }
  | {
      type:      'tool_start';
      sessionId: string;
      runId:     string;
      tool:      string;
    }
  | {
      type:      'tool_done';
      sessionId: string;
      runId:     string;
      tool:      string;
    }
  | {
      type:      'thought_end';
      sessionId: string;
      runId:     string;
      signal:    'done' | 'paused' | 'stopped';
      reason?:   string;
    }
  | {
      type:      'error';
      sessionId: string;
      runId:     string;
      message:   string;
    };

class AgentBus extends EventEmitter {
  emitAgent(e: AgentEvent): void {
    // Two emit shapes: 'agent' (firehose) and per-type for selective consumers.
    this.emit('agent', e);
    this.emit(e.type, e);
  }
}

export const agentBus = new AgentBus();
// Dashboard tabs + Discord listeners can stack up — bump the default ceiling.
agentBus.setMaxListeners(200);

// ── Run lifecycle events (background-generation delivery) ────────────────
// Emitted by db.endRun when a run reaches a terminal state. The run-delivery
// module subscribes to push finished results back to their origin surface.
export interface RunTerminalEvent {
  runId:  string;
  // 'dropped' is emitted only on the dedicated 'run:dropped' channel (by
  // db.markRunDropped) for the subtask-continuation re-arm — the main
  // 'run:terminal' channel only ever carries done/error/stopped.
  status: 'done' | 'error' | 'stopped' | 'dropped';
}

export const runEvents = new EventEmitter();
runEvents.setMaxListeners(50);
