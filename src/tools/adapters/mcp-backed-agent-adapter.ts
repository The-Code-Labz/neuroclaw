// Synthesizes a ToolDef for every active provider='mcp' agent so other
// (local) agents can call them mid-turn as `agent__<sanitized_name>`. The
// handler proxies to the same MCP tool the agent itself is backed by — so
// calling an agent as a tool produces identical results to addressing it
// directly via @-mention.

import { z } from 'zod';
import type { ToolDef } from '../registry';
import { getAllAgents, getMcpServer, parseMcpHeaders } from '../../db';
import { callTool } from '../../mcp/mcp-client';
import { config } from '../../config';
import { logger } from '../../utils/logger';

// Zod can't reasonably mirror an arbitrary remote JSON Schema, so the
// synthesized ToolDef uses an open object as the schema and lets the OpenAI
// adapter's JSON-Schema path fall back to the cached inputSchema directly.
const passthroughShape = {} as z.ZodRawShape;
const passthroughSchema = z.looseObject(passthroughShape);

function sanitizeAgentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'agent';
}

export interface SynthesizedBackedAgentTool extends ToolDef {
  /** The raw JSON Schema for the tool — used by adapters that need JSON
   *  Schema rather than zod (OpenAI, HTTP MCP). */
  rawInputSchema: unknown;
  /** The agent id this tool proxies to. */
  agentId: string;
  /** The agent name this tool proxies to. */
  agentName: string;
}

export function getMcpBackedAgentTools(): SynthesizedBackedAgentTool[] {
  const out: SynthesizedBackedAgentTool[] = [];
  for (const a of getAllAgents()) {
    if (a.status !== 'active') continue;
    if (a.provider !== 'mcp') continue;
    if (!a.mcp_server_id || !a.mcp_tool_name) continue;
    const server = getMcpServer(a.mcp_server_id);
    if (!server || !server.enabled) continue;

    const inputField = a.mcp_input_field || 'query';
    const toolName = `agent__${sanitizeAgentName(a.name)}`;
    const description = a.description
      ? `Delegate to the ${a.name} agent: ${a.description}`
      : `Delegate to the ${a.name} agent (MCP-backed).`;

    out.push({
      name:        toolName,
      description,
      schema:      passthroughSchema,
      shape:       passthroughShape,
      agentId:     a.id,
      agentName:   a.name,
      rawInputSchema: {
        type: 'object',
        properties: { [inputField]: { type: 'string', description: `Input for ${a.name}` } },
        required: [inputField],
        additionalProperties: false,
      },
      handler: async (args) => {
        const input = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
        const value = input[inputField];
        const message = typeof value === 'string' ? value : JSON.stringify(value);
        const headers = parseMcpHeaders(server.headers);
        // P1: cap the delegation so a wedged MCP server can't freeze the parent
        // agent's tool loop. On timeout, return a plain tool-result string (NOT
        // a throw) so the parent sees a normal result it can act on — re-try
        // directly or route around the dead delegate — instead of stalling.
        const timeoutMs = config.mcp.agentDelegationTimeoutMs;
        let timer: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([
            callTool(
              server.url,
              a.mcp_tool_name!,
              { [inputField]: message },
              Object.keys(headers).length > 0 ? headers : undefined,
              (server.transport as 'auto' | 'http' | 'sse' | undefined) ?? 'auto',
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`__delegation_timeout__:${timeoutMs}`)),
                timeoutMs,
              );
            }),
          ]);
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith('__delegation_timeout__')) {
            logger.warn('mcp-backed-agent: delegation timed out', { agent: a.name, tool: a.mcp_tool_name, timeoutMs });
            return `The ${a.name} agent did not respond within ${Math.round(timeoutMs / 1000)}s — the delegation timed out. Do NOT retry it blindly; either handle this part of the task yourself or route around it, and tell the user ${a.name} was unresponsive.`;
          }
          throw err;
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    });
  }
  return out;
}

/** Fast lookup used by adapters that resolve a tool by name. Falls back to
 *  scanning the synthesized list — O(N) per lookup but N is tiny. */
export function findMcpBackedAgentTool(name: string): SynthesizedBackedAgentTool | undefined {
  if (!name.startsWith('agent__')) return undefined;
  return getMcpBackedAgentTools().find(t => t.name === name);
}
