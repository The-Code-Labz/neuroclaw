// Streamable-HTTP MCP server adapter. Exposes the unified registry as a
// real MCP server over HTTP so external runtimes (Codex CLI, future
// non-Anthropic clients) can call NeuroClaw tools the same way Claude does.
//
// Mounted by src/dashboard/server.ts at /mcp. Bearer-auth uses DASHBOARD_TOKEN.
//
// We use the low-level `Server` + `setRequestHandler` so the SDK's heavy
// generic inference doesn't chew through TS's heap on a 16-tool registry.
// The trade-off: handler bodies are typed as `any` at the SDK boundary, but
// argument validation is still performed via zod inside.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
// The Zod request schemas in the MCP SDK are deeply nested generic types that
// blow tsc's instantiation depth limit when used via setRequestHandler<T>'s
// type inference. We import them as plain values (untyped) below to dodge
// the recursion.
import { z } from 'zod';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js') as { CallToolRequestSchema: unknown; ListToolsRequestSchema: unknown };
import { logger } from '../../utils/logger';
import { registry, findTool, visibleCoreTools, isToolBlockedForSubAgent } from '../registry';
import { findMcpBackedAgentTool } from './mcp-backed-agent-adapter';
import { findMcpRegistryTool } from './mcp-registry-adapter';
import { dispatchComposioTool } from './composio';
import { META_TOOL_DEFS, META_TOOL_NAMES, dispatchMetaTool } from '../meta-tools';
import type { ToolContext } from '../context';
import { invokeTool, type ToolCategory } from '../tool-middleware';

export interface McpHttpOptions {
  /** Resolves the calling agent context (agentId, sessionId, runId) from request
   *  metadata. This is a closure set up by mcp-route.ts that captures headers. */
  resolveContext?: () => ToolContext;
  /** 'external' shows only tools tagged externalSurface:true. Default: 'internal' (all tools). */
  clientType?: 'external' | 'internal';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripMeta(schema: any): any {
  if (schema && typeof schema === 'object') {
    const copy = { ...schema };
    delete copy.$schema;
    delete copy.definitions;
    return copy;
  }
  return schema;
}

export function createNeuroclawHttpMcpServer(opts: McpHttpOptions = {}): Server {
  const server = new Server(
    { name: 'neuroclaw', version: '1.6.0' },
    { capabilities: { tools: {} } },
  );

  // The SDK's setRequestHandler<T> recursively materializes the entire request
  // schema's Zod shape, which blows tsc's instantiation depth on a 16-tool
  // registry. Bracket-access the method to bypass the type system entirely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setHandler = (server as any)['setRequestHandler'].bind(server) as (schema: unknown, handler: (req: unknown) => Promise<unknown>) => void;

  // Only core tools are listed upfront; everything else is reachable via
  // search_tools + call_tool. Internal clients (agy, Codex — no external
  // marker) get the full surface to act as first-class agents. Clients that
  // mark themselves external (x-neuroclaw-client: external) get ONLY the
  // curated externalSurface:true set, and no meta-tools — search_tools +
  // call_tool would otherwise tunnel straight past the curation. Per-agent
  // gates (e.g. exec) still apply via visibleCoreTools(ctx).
  const isExternalClient = opts.clientType === 'external';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildToolsList = (ctx: ToolContext = {}): Array<{ name: string; description: string; inputSchema: any }> => {
    const base = visibleCoreTools(ctx);
    const filtered = isExternalClient ? base.filter(t => t.externalSurface === true) : base;
    const coreEntries = filtered.map(t => ({
      name:        t.name,
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: stripMeta(z.toJSONSchema(t.schema as any, { target: 'draft-7' })),
    }));
    if (isExternalClient) return coreEntries;
    const metaEntries = (Object.entries(META_TOOL_DEFS) as [string, typeof META_TOOL_DEFS[keyof typeof META_TOOL_DEFS]][]).map(([name, def]) => ({
      name,
      description: def.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: stripMeta(z.toJSONSchema(def.schema as any, { target: 'draft-7' })),
    }));
    return [...coreEntries, ...metaEntries];
  };

  setHandler(ListToolsRequestSchema, async () => ({ tools: buildToolsList() }));

  setHandler(CallToolRequestSchema, async (req: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = req as any;
    const name: string = request.params.name;

    // External clients are limited to the curated surface at DISPATCH too —
    // listing alone doesn't stop a client from calling an unlisted name.
    const externalDeny = (toolName: string) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `tool '${toolName}' is not available on the external surface` }) }],
      isError: true,
    });

    // Meta-tools (search_tools, call_tool) handle their own dispatch.
    if (META_TOOL_NAMES.has(name)) {
      if (isExternalClient) return externalDeny(name);
      const ctx: ToolContext = opts.resolveContext?.() ?? {};
      const argsStr = JSON.stringify(request.params.arguments ?? {});
      const result = await dispatchMetaTool(name, argsStr, ctx);
      return { content: [{ type: 'text', text: result }] };
    }

    // resolveContext is called with no arguments — it's a closure that captures
    // the context from HTTP headers (agentId, sessionId, runId) set up in mcp-route.ts.
    // Previously this incorrectly passed request.params.arguments which are the
    // tool's input args, not context metadata.
    const ctx: ToolContext = opts.resolveContext?.() ?? {};

    // All four tool sources, same as the call_tool meta-tool — direct calls to
    // an mcp__<server>__<tool> or COMPOSIO_* name must not bounce as "unknown"
    // when search_tools just advertised them.
    const tool = findTool(name) ?? findMcpBackedAgentTool(name) ?? findMcpRegistryTool(name);
    if (tool && isExternalClient && tool.externalSurface !== true) return externalDeny(name);
    if (!tool) {
      if (name.startsWith('COMPOSIO_')) {
        if (isExternalClient) return externalDeny(name);
        const argsStr = JSON.stringify(request.params.arguments ?? {});
        try {
          const result = await dispatchComposioTool(name, argsStr, ctx);
          return { content: [{ type: 'text', text: result }] };
        } catch (e) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (e as Error).message }) }],
            isError: true,
          };
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    if (tool.gate) {
      const g = tool.gate(ctx);
      if (!g.allowed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: g.reason ?? 'tool gated' }) }],
          isError: true,
        };
      }
    }

    // Sub-agent tool lockdown — same gate dispatchOpenAiTool applies. No-op
    // unless the resolved context carries spawnDepth >= 1.
    if (isToolBlockedForSubAgent(name, ctx, ctx.allowedToolOverrides)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Tool '${name}' is not available inside a sub-agent. Return your result as text — the parent agent handles writes and actions.` }) }],
        isError: true,
      };
    }

    const validation = tool.schema.safeParse(request.params.arguments ?? {});
    if (!validation.success) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid arguments', details: validation.error.message }) }],
        isError: true,
      };
    }

    try {
      // Unified boundary: trace + output compression w/ retrieval exemption.
      // Previously this plane emitted NO tool_call trace (the historical gap the
      // Step-0 wrapper closes) and skipped compression entirely — external
      // clients (Codex CLI) now get the same treatment as the native planes.
      const result = await invokeTool({
        name,
        args: validation.data,
        ctx,
        category: (tool as { category?: ToolCategory }).category,
        run: () => tool.handler(validation.data, ctx),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (e as Error).message }) }],
        isError: true,
      };
    }
  });

  logger.info('NeuroClaw MCP HTTP server: created', { nativeToolCount: registry.length });
  return server;
}

export { StreamableHTTPServerTransport };
