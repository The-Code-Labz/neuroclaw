// Claude Agent SDK adapter. Builds an in-process MCP server (the SDK's
// `createSdkMcpServer`) from the unified registry. Used by
// src/providers/claude-cli.ts via the SDK's mcpServers option.
//
// Only core tools are registered upfront; every other tool is reachable
// via the search_tools + call_tool meta-tools to keep context small.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../utils/logger';
import { visibleCoreTools, isToolBlockedForSubAgent } from '../registry';
import { META_TOOL_DEFS, handleSearchTools, handleGetToolSchema, handleCallTool } from '../meta-tools';
import type { ToolContext } from '../context';
import { isRunSuperseded } from '../../system/run-ownership';
import { invokeTool } from '../tool-middleware';

export interface NeuroclawMcpOptions {
  agentId?:   string | null;
  sessionId?: string | null;
  /** Set >= 1 when this server is built for a sub-agent context — enforces the
   *  sub-agent tool lockdown (config.subAgent.blockedTools) on this plane the
   *  same way dispatchOpenAiTool does. Omitted/0 = full agent, no restriction. */
  spawnDepth?:           number;
  allowedToolOverrides?: string[];
  /** Threaded from the Claude plane so tool traces attach to their run in the
   *  Traces view (the backbone plane already carries runId on its ToolContext). */
  runId?:                string | null;
}

function ok(payload: unknown)  { return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }; }
function err(message: string)   { return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }], isError: true }; }

// Tools whose handler synchronously awaits a *peer agent's* full turn
// (message_agent, assign_task_to_agent with execute_now). These can legitimately
// run for many minutes — a build+test hand-off — during which they emit no
// output, so Claude Code's idle-timeout (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT)
// would abort the caller and orphan the work. We keep the idle ceiling tight for
// everything else (real hang-detection) and defeat it cooperatively HERE: emit an
// MCP progress notification every HEARTBEAT_MS while the peer works, which resets
// the idle timer. Total duration is still bounded by MCP_TOOL_TIMEOUT (30min).
const HEARTBEAT_TOOLS = new Set(['message_agent', 'assign_task_to_agent']);
const HEARTBEAT_MS = 20_000;

/** Run `fn`, pinging MCP progress every HEARTBEAT_MS so a long-but-alive
 *  agent-comms call is never mistaken for idle. Best-effort: if the client did
 *  not supply a progressToken, the pings are inert and we fall back to the
 *  existing timeout behavior (strictly no worse than before). */
async function withHeartbeat<T>(extra: unknown, fn: () => Promise<T>): Promise<T> {
  const e = extra as {
    sendNotification?: (n: unknown) => Promise<void> | void;
    _meta?: { progressToken?: string | number };
  } | undefined;
  const token = e?._meta?.progressToken;
  let n = 0;
  const timer = (e?.sendNotification && token !== undefined)
    ? setInterval(() => {
        try {
          void Promise.resolve(
            e.sendNotification!({
              method: 'notifications/progress',
              params: { progressToken: token, progress: ++n, message: 'peer agent still working…' },
            }),
          ).catch(() => {});
        } catch { /* never let a heartbeat throw into the tool loop */ }
      }, HEARTBEAT_MS)
    : null;
  try { return await fn(); }
  finally { if (timer) clearInterval(timer); }
}

export function createNeuroclawMcpServer(opts: NeuroclawMcpOptions = {}) {
  const ctx: ToolContext = {
    agentId:              opts.agentId   ?? null,
    sessionId:            opts.sessionId ?? null,
    runId:                opts.runId     ?? null,
    spawnDepth:           opts.spawnDepth,
    allowedToolOverrides: opts.allowedToolOverrides,
  };

  // Sub-agent tool lockdown — same gate dispatchOpenAiTool applies. Blocked
  // tools are both excluded from the upfront list (don't waste the model's
  // turn) and refused at dispatch (defense against stale tool lists).
  const coreTools = visibleCoreTools(ctx)
    .filter(t => !isToolBlockedForSubAgent(t.name, ctx, ctx.allowedToolOverrides))
    .map(t =>
      tool(t.name, t.description, t.shape, async (args, extra) => {
        if (isToolBlockedForSubAgent(t.name, ctx, ctx.allowedToolOverrides)) {
          return err(`Tool '${t.name}' is not available inside a sub-agent. Return your result as text — the parent agent handles writes and actions.`);
        }
        // Cooperative cancellation — stop a reassigned/closed run from executing tools.
        if (ctx.sessionId && ctx.agentId && isRunSuperseded(ctx.sessionId, ctx.agentId)) {
          return err('This task was reassigned to another agent or closed. Stop working on it and do not call further tools.');
        }
        try {
          // Agent-comms tools await a peer's whole turn — keep the idle timer
          // fresh with a progress heartbeat so a legit-long hand-off isn't
          // aborted as "silent". Every other tool runs plain (hang-detection on).
          const run = () => t.handler(args as never, ctx);
          const exec = () => (HEARTBEAT_TOOLS.has(t.name) ? withHeartbeat(extra, run) : run());
          // Unified boundary: trace (once per real direct call — call_tool'd
          // tools log inside handleCallTool) + output compression w/ retrieval
          // exemption. Same choke point as the OpenAI and HTTP-MCP planes.
          const out = await invokeTool({
            name: t.name, args, ctx, category: t.category, run: exec,
          });
          return ok(out);
        }
        catch (e) { return err((e as Error).message); }
      }),
    );

  const metaTools = [
    tool('search_tools', META_TOOL_DEFS.search_tools.description, META_TOOL_DEFS.search_tools.shape, async (args) => {
      try { return ok(await handleSearchTools(args as never, ctx)); }
      catch (e) { return err((e as Error).message); }
    }),
    tool('get_tool_schema', META_TOOL_DEFS.get_tool_schema.description, META_TOOL_DEFS.get_tool_schema.shape, async (args) => {
      try { return ok(await handleGetToolSchema(args as never, ctx)); }
      catch (e) { return err((e as Error).message); }
    }),
    tool('call_tool', META_TOOL_DEFS.call_tool.description, META_TOOL_DEFS.call_tool.shape, async (args) => {
      try { return ok(await handleCallTool(args as never, ctx)); }
      catch (e) { return err((e as Error).message); }
    }),
  ];

  const tools = [...coreTools, ...metaTools];

  logger.info('NeuroClaw MCP server: created (in-process via Claude SDK)', {
    agentId:   ctx.agentId,
    sessionId: ctx.sessionId,
    toolCount: tools.length,
  });

  return createSdkMcpServer({
    name:    'neuroclaw',
    version: '1.6.0',
    tools,
  });
}
