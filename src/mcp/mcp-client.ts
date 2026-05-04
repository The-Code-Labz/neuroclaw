import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '../utils/logger';

export interface McpToolDefinition {
  name:        string;
  description: string;
  inputSchema: unknown;
}

/** Wire transport selector. 'auto' picks SSE for URLs ending in `/sse` or
 *  `/sse/` (n8n's MCP node, FastAPI MCP examples), otherwise Streamable HTTP. */
export type McpTransport = 'auto' | 'http' | 'sse';

interface CachedConnection {
  client:    Client;
  transport: Transport;
}

const connections = new Map<string, Promise<CachedConnection>>();

function resolveTransport(url: string, hint: McpTransport | undefined): 'http' | 'sse' {
  if (hint === 'http' || hint === 'sse') return hint;
  // Auto-detect. n8n exposes MCP at `/mcp/<name>/sse`; the official Python SDK's
  // examples use `/sse` too. Streamable HTTP is the modern default for everything else.
  try {
    const path = new URL(url).pathname;
    if (/\/sse\/?$/.test(path)) return 'sse';
  } catch { /* malformed URL — let the connect call surface the real error */ }
  return 'http';
}

function connectionKey(serverUrl: string, headers?: Record<string, string>, transport?: McpTransport): string {
  // Auth-bearing headers + transport choice must invalidate the cache —
  // different bearer tokens imply different sessions even on the same URL,
  // and switching http↔sse needs a fresh transport object.
  const t = transport ?? 'auto';
  if (!headers || Object.keys(headers).length === 0) return `${serverUrl}::${t}`;
  const sig = Object.entries(headers).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}:${v}`).join('|');
  return `${serverUrl}::${t}#${sig}`;
}

async function connect(serverUrl: string, headers?: Record<string, string>, transportHint?: McpTransport): Promise<CachedConnection> {
  const key = connectionKey(serverUrl, headers, transportHint);
  const existing = connections.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<CachedConnection> => {
    const kind = resolveTransport(serverUrl, transportHint);
    const transport: Transport = kind === 'sse'
      ? new SSEClientTransport(new URL(serverUrl), {
          ...(headers ? { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }) } } : {}),
        })
      : new StreamableHTTPClientTransport(new URL(serverUrl), {
          ...(headers ? { requestInit: { headers } } : {}),
        });
    const client = new Client(
      { name: 'neuroclaw-v1', version: '1.4.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    logger.info('MCP: connected', { serverUrl, transport: kind, hasHeaders: !!headers });
    return { client, transport };
  })();

  connections.set(key, promise);
  // If connect fails, drop the cached entry so the next call retries
  promise.catch(err => {
    logger.error('MCP: connect failed', { serverUrl, error: (err as Error).message });
    connections.delete(key);
  });
  return promise;
}

export async function listTools(serverUrl: string, headers?: Record<string, string>, transport?: McpTransport): Promise<McpToolDefinition[]> {
  if (!serverUrl) throw new Error('listTools: serverUrl is required');
  const { client } = await connect(serverUrl, headers, transport);
  const result = await client.listTools();
  return (result.tools ?? []).map(t => ({
    name:        t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
  }));
}

export async function callTool(
  serverUrl: string,
  toolName:  string,
  input:     Record<string, unknown> = {},
  headers?:  Record<string, string>,
  transport?: McpTransport,
): Promise<unknown> {
  if (!serverUrl) throw new Error('callTool: serverUrl is required');
  const { client } = await connect(serverUrl, headers, transport);
  const result = await client.callTool({ name: toolName, arguments: input });

  if (result.isError) {
    const text = extractText(result.content);
    throw new Error(`MCP tool ${toolName} returned error: ${text || JSON.stringify(result)}`);
  }
  // Prefer parsed JSON when content is a single text block of JSON; else return raw content
  const text = extractText(result.content);
  if (text) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return result.content;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

export async function closeAll(): Promise<void> {
  for (const [, p] of connections) {
    try {
      const { transport } = await p;
      await transport.close();
    } catch {
      // best-effort
    }
  }
  connections.clear();
}
