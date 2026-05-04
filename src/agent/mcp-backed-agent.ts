// MCP-backed agent dispatcher. When an agent has provider='mcp', chatStream
// proxies the user's message directly to a remote MCP tool (no local LLM
// turn). The remote response is streamed back as a single chunk and persisted
// to the session like any normal assistant message. Streaming token-by-token
// is intentionally not supported in v1 — the spec calls for waiting on the
// final result.

import { getMcpServer, parseMcpHeaders, saveMessage, type AgentRecord } from '../db';
import { callTool } from '../mcp/mcp-client';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';
import type { MetaEvent } from './alfred';

export async function chatStreamMcp(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  agentRecord: AgentRecord,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
): Promise<void> {
  if (!agentRecord.mcp_server_id || !agentRecord.mcp_tool_name) {
    const err = `Agent "${agentRecord.name}" has provider=mcp but missing mcp_server_id or mcp_tool_name`;
    logger.error('chatStreamMcp: misconfigured agent', { agentId: agentRecord.id });
    await onMeta?.({ type: 'error', error: err });
    throw new Error(err);
  }

  const server = getMcpServer(agentRecord.mcp_server_id);
  if (!server) {
    const err = `MCP server for agent "${agentRecord.name}" no longer exists (id: ${agentRecord.mcp_server_id})`;
    await onMeta?.({ type: 'error', error: err });
    throw new Error(err);
  }
  if (!server.enabled) {
    const err = `MCP server "${server.name}" for agent "${agentRecord.name}" is disabled`;
    await onMeta?.({ type: 'error', error: err });
    throw new Error(err);
  }

  const inputField = agentRecord.mcp_input_field || 'query';
  const headers = parseMcpHeaders(server.headers);
  const args: Record<string, unknown> = { [inputField]: userMessage };

  saveMessage(sessionId, 'user', userMessage, agentRecord.id);

  await onMeta?.({ type: 'mcp_call_start', server: server.name, tool: agentRecord.mcp_tool_name });

  let textOut = '';
  try {
    const result = await callTool(
      server.url,
      agentRecord.mcp_tool_name,
      args,
      Object.keys(headers).length > 0 ? headers : undefined,
      (server.transport as 'auto' | 'http' | 'sse' | undefined) ?? 'auto',
    );
    textOut = extractText(result);
  } catch (e) {
    const detail = (e as Error).message || String(e);
    logger.error('chatStreamMcp: remote call failed', {
      agentId: agentRecord.id,
      server: server.name,
      tool: agentRecord.mcp_tool_name,
      error: detail,
    });
    logHive(
      'mcp_agent_call_failed',
      `${agentRecord.name} -> ${server.name}/${agentRecord.mcp_tool_name}: ${detail.slice(0, 120)}`,
      agentRecord.id,
      { error: detail },
    );
    await onMeta?.({ type: 'error', error: detail });
    throw e;
  }

  await onChunk(textOut);
  saveMessage(sessionId, 'assistant', textOut, agentRecord.id);
  await onMeta?.({ type: 'mcp_call_done', server: server.name, tool: agentRecord.mcp_tool_name, length: textOut.length });
  logHive(
    'mcp_agent_call_ok',
    `${agentRecord.name} -> ${server.name}/${agentRecord.mcp_tool_name}: ${textOut.length} chars`,
    agentRecord.id,
  );
}

function extractText(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return JSON.stringify(result);

  // MCP content array format: { content: Array<{ type: string; text?: string }>, isError?: boolean }
  const r = result as { content?: unknown; isError?: boolean };
  let body: string;
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const c of r.content as Array<{ type?: string; text?: string }>) {
      if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else parts.push(JSON.stringify(c));
    }
    body = parts.join('\n').trim();
  } else {
    body = JSON.stringify(result);
  }

  return r.isError ? `MCP tool error:\n${body}` : body;
}
