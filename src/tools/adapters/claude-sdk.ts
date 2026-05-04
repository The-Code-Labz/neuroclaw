// Claude Agent SDK adapter. Builds an in-process MCP server (the SDK's
// `createSdkMcpServer`) from the unified registry. Used by
// src/providers/claude-cli.ts via the SDK's mcpServers option.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../utils/logger';
import { visibleTools } from '../registry';
import type { ToolContext } from '../context';

export interface NeuroclawMcpOptions {
  agentId?:   string | null;
  sessionId?: string | null;
}

function ok(payload: unknown)  { return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }; }
function err(message: string)   { return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }], isError: true }; }

export function createNeuroclawMcpServer(opts: NeuroclawMcpOptions = {}) {
  const ctx: ToolContext = {
    agentId:   opts.agentId   ?? null,
    sessionId: opts.sessionId ?? null,
  };

  const tools = visibleTools(ctx).map(t =>
    tool(t.name, t.description, t.shape, async (args) => {
      try { return ok(await t.handler(args as never, ctx)); }
      catch (e) { return err((e as Error).message); }
    }),
  );

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
