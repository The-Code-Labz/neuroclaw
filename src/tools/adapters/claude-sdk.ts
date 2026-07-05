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
import { logToolCall } from '../../system/hive-mind';

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
      tool(t.name, t.description, t.shape, async (args) => {
        if (isToolBlockedForSubAgent(t.name, ctx, ctx.allowedToolOverrides)) {
          return err(`Tool '${t.name}' is not available inside a sub-agent. Return your result as text — the parent agent handles writes and actions.`);
        }
        // Cooperative cancellation — stop a reassigned/closed run from executing tools.
        if (ctx.sessionId && ctx.agentId && isRunSuperseded(ctx.sessionId, ctx.agentId)) {
          return err('This task was reassigned to another agent or closed. Stop working on it and do not call further tools.');
        }
        // Trace: record the direct (core) tool invocation on the Claude plane.
        // call_tool'd tools are logged inside handleCallTool (the call_tool
        // wrapper below routes there), so this fires once per real direct call.
        logToolCall(t.name, args, ctx);
        try { return ok(await t.handler(args as never, ctx)); }
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
