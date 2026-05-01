import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../utils/logger';

export interface McpToolDefinition {
  name:        string;
  description: string;
  inputSchema: unknown;
}

interface CachedConnection {
  client:    Client;
  transport: StreamableHTTPClientTransport;
}

const connections = new Map<string, Promise<CachedConnection>>();

async function connect(serverUrl: string): Promise<CachedConnection> {
  const existing = connections.get(serverUrl);
  if (existing) return existing;

  const promise = (async (): Promise<CachedConnection> => {
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    const client = new Client(
      { name: 'neuroclaw-v1', version: '1.4.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    logger.info('MCP: connected', { serverUrl });
    return { client, transport };
  })();

  connections.set(serverUrl, promise);
  // If connect fails, drop the cached entry so the next call retries
  promise.catch(err => {
    logger.error('MCP: connect failed', { serverUrl, error: (err as Error).message });
    connections.delete(serverUrl);
  });
  return promise;
}

export async function listTools(serverUrl: string): Promise<McpToolDefinition[]> {
  if (!serverUrl) throw new Error('listTools: serverUrl is required');
  const { client } = await connect(serverUrl);
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
): Promise<unknown> {
  if (!serverUrl) throw new Error('callTool: serverUrl is required');
  const { client } = await connect(serverUrl);
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
