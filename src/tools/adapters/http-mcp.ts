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
import { zodToJsonSchema } from 'zod-to-json-schema';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js') as { CallToolRequestSchema: unknown; ListToolsRequestSchema: unknown };
import { logger } from '../../utils/logger';
import { registry, findTool, getAllTools } from '../registry';
import type { ToolContext } from '../context';

export interface McpHttpOptions {
  /** Resolves the calling agent from request metadata. */
  resolveContext?: (meta: Record<string, unknown>) => ToolContext;
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

  // Build the tools list per request so that user-managed MCP servers added
  // via the dashboard show up in the next `tools/list` call without restart.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildToolsList = (): Array<{ name: string; description: string; inputSchema: any }> =>
    getAllTools().map(t => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: unknown = (t as any).rawInputSchema;
      const inputSchema = raw && typeof raw === 'object'
        ? stripMeta(raw)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : stripMeta(zodToJsonSchema(t.schema as any));
      return { name: t.name, description: t.description, inputSchema };
    });

  setHandler(ListToolsRequestSchema, async () => ({ tools: buildToolsList() }));

  setHandler(CallToolRequestSchema, async (req: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = req as any;
    const tool = findTool(request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `unknown tool: ${request.params.name}` }) }],
        isError: true,
      };
    }

    const ctx: ToolContext = opts.resolveContext?.(request.params.arguments ?? {}) ?? {};

    if (tool.gate) {
      const g = tool.gate(ctx);
      if (!g.allowed) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: g.reason ?? 'tool gated' }) }],
          isError: true,
        };
      }
    }

    const validation = tool.schema.safeParse(request.params.arguments ?? {});
    if (!validation.success) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid arguments', details: validation.error.message }) }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(validation.data, ctx);
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
