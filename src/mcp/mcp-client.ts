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

// FastMCP 3.x uses stateful sessions. If the Python server restarts, its
// in-memory session table is wiped. The cached Transport still holds the old
// session ID, so the next RPC returns either:
//   - {"error":{"message":"Session not found"}}   (explicit)
//   - JSON-RPC error -32602 "Invalid request parameters"  (FastMCP's actual
//     response when the SSE transport sends a session_id the server doesn't
//     recognize — confirmed against docuflow-mcp.neurolearninglabs.com after
//     the Python service restarts)
//
// Both indicate the same root cause: the cached Transport is referencing a
// dead session. Drop the cached connection and retry once with a fresh handshake.
function isStaleSession(err: unknown): boolean {
  // Match by error code first — most reliable across SDK versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code = (err as any)?.code;
  if (code === -32602 || code === -32600 || code === -32001) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('session not found')) return true;
  if (msg.includes('invalid request parameters')) return true;
  if (msg.includes('mcp error -32602')) return true;
  return false;
}

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

async function evictAndReconnect(
  serverUrl: string,
  headers:   Record<string, string> | undefined,
  transport: McpTransport | undefined,
): Promise<CachedConnection> {
  const key = connectionKey(serverUrl, headers, transport);
  const stale = connections.get(key);
  connections.delete(key);
  // Best-effort: close the dead transport so we don't leak SSE EventSource
  // handles or HTTP keepalive sockets on every reconnect.
  if (stale) {
    stale.then(({ transport: t }) => {
      try { (t as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
    }).catch(() => { /* connect failed earlier — nothing to close */ });
  }
  logger.info('MCP: evicting stale session, reconnecting', { serverUrl });
  return connect(serverUrl, headers, transport);
}

/** Proactively evict + close a cached connection for a specific (url, headers,
 *  transport) key. OAuth-Bearer callers (OpenArt) must call this after a token
 *  rotation: connectionKey() includes the header signature, so a rotated Bearer
 *  opens a NEW cached entry while the old one lingers holding a live SSE/HTTP
 *  socket — isStaleSession() never matches a 401, so nothing else evicts it.
 *  Without this the connections Map (and its sockets) grows unbounded. */
export function evictConnection(serverUrl: string, headers?: Record<string, string>, transport?: McpTransport): void {
  const key = connectionKey(serverUrl, headers, transport);
  const stale = connections.get(key);
  if (!stale) return;
  connections.delete(key);
  stale.then(({ transport: t }) => {
    try { (t as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
  }).catch(() => { /* connect had failed — nothing to close */ });
}

export async function listTools(serverUrl: string, headers?: Record<string, string>, transport?: McpTransport): Promise<McpToolDefinition[]> {
  if (!serverUrl) throw new Error('listTools: serverUrl is required');
  const { client } = await connect(serverUrl, headers, transport);
  try {
    const result = await client.listTools();
    return (result.tools ?? []).map(t => ({
      name:        t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));
  } catch (err) {
    if (isStaleSession(err)) {
      const { client: fresh } = await evictAndReconnect(serverUrl, headers, transport);
      const result = await fresh.listTools();
      return (result.tools ?? []).map(t => ({
        name:        t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }));
    }
    throw err;
  }
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
  let result: Awaited<ReturnType<typeof client.callTool>>;
  // Long-running MCP tools (e.g. browser-based image generation) can exceed
  // the SDK's default 60s timeout. The grok_web / gemini / chatgpt image
  // sidecars wait up to 300s INTERNALLY, so a 300s client timeout is a dead
  // heat — it fires (-32001) at the exact moment the tool returns, and the
  // agent never sees the (already-generated) image. Measured real runtime is
  // ~303s, so we need headroom ABOVE the tool's internal ceiling. Default 420s;
  // tunable via env without a rebuild (read live per call).
  const callOpts = { timeout: parseInt(process.env.MCP_CALL_TIMEOUT_MS ?? '420000', 10) };
  try {
    result = await client.callTool({ name: toolName, arguments: input }, undefined, callOpts);
  } catch (err) {
    if (isStaleSession(err)) {
      const { client: fresh } = await evictAndReconnect(serverUrl, headers, transport);
      result = await fresh.callTool({ name: toolName, arguments: input }, undefined, callOpts);
    } else {
      throw err;
    }
  }

  if (result.isError) {
    const text = extractText(result.content);
    throw new Error(`MCP tool ${toolName} returned error: ${text || JSON.stringify(result)}`);
  }
  // Prefer parsed JSON when content is a single text block of JSON; else return raw content.
  // When image blocks are present, always return the raw array so mcp-backed-agent can process them.
  const text = extractText(result.content);
  const hasImageBlocks = Array.isArray(result.content) &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result.content as Array<any>).some((b: any) => b?.type === 'image');
  if (text && !hasImageBlocks) {
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
