// Bridge between the user-managed MCP server registry (mcp_servers table)
// and the unified tool registry. Each cached remote tool is synthesized into
// a ToolDef whose handler proxies to the live MCP server. Naming follows the
// Claude SDK convention: mcp__<sanitized_server_name>__<tool_name>.
//
// We DON'T mutate the static `registry` array. Instead, the adapters call
// `getMcpRegistryTools()` and merge the result into their tool list at lookup
// time. Adding/removing a server therefore takes effect on the next chat
// turn without a restart.

import { z } from 'zod';
import type { ToolDef } from '../registry';
import { getEnabledServersWithTools, callRegisteredTool } from '../../mcp/mcp-registry';

// Zod can't reasonably mirror an arbitrary remote JSON Schema, so the
// synthesized ToolDef uses an open object as the schema and lets the OpenAI
// adapter's JSON-Schema path fall back to the cached inputSchema directly.
const passthroughShape = {} as z.ZodRawShape;
const passthroughSchema = z.object(passthroughShape).passthrough();

export interface SynthesizedMcpTool extends ToolDef {
  /** The cached JSON Schema from the remote server — used by adapters that
   *  need raw JSON Schema rather than zod (OpenAI, HTTP MCP). */
  rawInputSchema: unknown;
  /** Sanitized name of the registered MCP server. */
  serverName:     string;
  /** Original (unprefixed) tool name on the remote server. */
  remoteToolName: string;
}

export function getMcpRegistryTools(): SynthesizedMcpTool[] {
  const out: SynthesizedMcpTool[] = [];
  for (const { row, tools } of getEnabledServersWithTools()) {
    for (const t of tools) {
      const fullName = `mcp__${row.name}__${t.name}`;
      const description = t.description
        ? `[${row.name}] ${t.description}`
        : `[${row.name}] Remote MCP tool: ${t.name}`;
      out.push({
        name:        fullName,
        description,
        schema:      passthroughSchema,
        shape:       passthroughShape,
        rawInputSchema: t.inputSchema && typeof t.inputSchema === 'object'
          ? t.inputSchema
          : { type: 'object', additionalProperties: true },
        serverName:     row.name,
        remoteToolName: t.name,
        handler: async (args) => {
          // The schema is passthrough so args is already an object — but
          // defensively coerce to a plain dict before forwarding.
          const input = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
          return callRegisteredTool(row.name, t.name, input);
        },
      });
    }
  }
  return out;
}

/** Fast lookup used by adapters that resolve a tool by name. Falls back to
 *  scanning the synthesized list — this is O(N) per lookup but N is tiny
 *  (sum of remote tools across all registered servers). */
export function findMcpRegistryTool(name: string): SynthesizedMcpTool | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  return getMcpRegistryTools().find(t => t.name === name);
}
