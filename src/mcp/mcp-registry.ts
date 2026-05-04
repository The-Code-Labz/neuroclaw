// Lightweight orchestrator over mcp-client.ts. Backs the user-managed MCP
// server registry: probes each registered server, caches its tool list in
// SQLite, and exposes a synchronous read of the cached tools to the agent
// runtime adapters. Runs alongside the legacy NEUROVAULT_MCP_URL env-driven
// vault path — it does not subsume it.

import { listTools, callTool, type McpTransport } from './mcp-client';
import {
  listMcpServers, getMcpServer, getMcpServerByName,
  parseMcpHeaders, parseMcpToolsCache, updateMcpServer,
  type McpServerRow, type McpToolCacheEntry,
} from '../db';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';

export interface ProbeResult {
  ok:           boolean;
  status:       string;
  detail?:      string;
  tools_count?: number;
  row?:         McpServerRow;
}

/** Probe a single server: list tools, write the cache + status back to the row. */
export async function probeServer(id: string): Promise<ProbeResult> {
  const row = getMcpServer(id);
  if (!row) return { ok: false, status: 'error', detail: 'server not found' };
  if (!row.enabled) {
    updateMcpServer(id, { status: 'unknown', status_detail: 'disabled', last_probed_at: new Date().toISOString() });
    return { ok: false, status: 'unknown', detail: 'disabled', row: getMcpServer(id) ?? undefined };
  }

  updateMcpServer(id, { status: 'connecting', status_detail: null });
  const headers = parseMcpHeaders(row.headers);
  const transport = (row.transport as McpTransport) || 'auto';
  try {
    const tools = await listTools(row.url, Object.keys(headers).length > 0 ? headers : undefined, transport);
    const cache: McpToolCacheEntry[] = tools.map(t => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? {},
    }));
    updateMcpServer(id, {
      status:         'ready',
      status_detail:  null,
      tools_cached:   cache,
      tools_count:    cache.length,
      last_probed_at: new Date().toISOString(),
    });
    logHive('mcp_probe_ok', `MCP server "${row.name}" probed: ${cache.length} tools`, undefined, { serverId: id, name: row.name, count: cache.length });
    logger.info('MCP probe: ok', { server: row.name, url: row.url, tools: cache.length });
    return { ok: true, status: 'ready', tools_count: cache.length, row: getMcpServer(id) ?? undefined };
  } catch (err) {
    const detail = (err as Error).message || String(err);
    updateMcpServer(id, {
      status:         'error',
      status_detail:  detail,
      last_probed_at: new Date().toISOString(),
    });
    logHive('mcp_probe_failed', `MCP server "${row.name}" probe failed: ${detail.slice(0, 120)}`, undefined, { serverId: id, name: row.name, error: detail });
    logger.warn('MCP probe: failed', { server: row.name, url: row.url, error: detail });
    return { ok: false, status: 'error', detail, row: getMcpServer(id) ?? undefined };
  }
}

/** Probe every enabled server in parallel. Best-effort; never throws. */
export async function probeAll(force = false): Promise<void> {
  const rows = listMcpServers(false);
  if (rows.length === 0) return;
  await Promise.allSettled(rows.map(r => {
    // Skip recently-probed-ok rows when not forced — saves network noise on
    // the 60s tick. Threshold: 5 minutes.
    if (!force && r.status === 'ready' && r.last_probed_at) {
      const age = Date.now() - new Date(r.last_probed_at).getTime();
      if (age < 5 * 60_000) return Promise.resolve();
    }
    return probeServer(r.id);
  }));
}

export interface RegistryServerWithTools {
  row:   McpServerRow;
  tools: McpToolCacheEntry[];
}

/** Synchronous read of every enabled, ready server's cached tools. Hot path
 *  for the runtime adapters — must not do I/O. */
export function getEnabledServersWithTools(): RegistryServerWithTools[] {
  return listMcpServers(false)
    .filter(r => r.status === 'ready' && r.tools_count > 0)
    .map(r => ({ row: r, tools: parseMcpToolsCache(r.tools_cached) }))
    .filter(x => x.tools.length > 0);
}

/** Invoke a registered server's tool by (sanitized server name, tool name). */
export async function callRegisteredTool(
  serverName: string,
  toolName:   string,
  input:      Record<string, unknown> = {},
): Promise<unknown> {
  const row = getMcpServerByName(serverName);
  if (!row)         throw new Error(`MCP server "${serverName}" not registered`);
  if (!row.enabled) throw new Error(`MCP server "${serverName}" is disabled`);
  const headers = parseMcpHeaders(row.headers);
  const transport = (row.transport as McpTransport) || 'auto';
  return callTool(row.url, toolName, input, Object.keys(headers).length > 0 ? headers : undefined, transport);
}
