// HTTP MCP endpoint mounted under /mcp on the dashboard server. Lets external
// MCP clients (Codex CLI, future non-Anthropic agents) call NeuroClaw tools
// over Streamable-HTTP transport.
//
// Auth: bearer token === DASHBOARD_TOKEN, supplied by Codex via the
// `bearer_token_env_var = "DASHBOARD_TOKEN"` config in ~/.codex/config.toml.
//
// Sessions: stateless per-request transports (no sessionIdGenerator) so each
// MCP call gets its own short-lived transport. This is the simplest mode that
// matches Codex's expected dispatch — Codex doesn't require a sticky session.

import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { config } from '../config';
import { logger } from '../utils/logger';
import { createNeuroclawHttpMcpServer, StreamableHTTPServerTransport } from '../tools/adapters/http-mcp';
import type { ToolContext } from '../tools/context';

type C = Context<{ Bindings: HttpBindings }>;

function checkAuth(c: C): boolean {
  const auth   = c.req.header('authorization') ?? '';
  const tokenH = c.req.header('x-dashboard-token') ?? '';
  const tokenQ = c.req.query('token') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? '';
  return [bearer, tokenH, tokenQ].includes(config.dashboard.token);
}

export async function handleMcpRequest(c: C): Promise<Response> {
  if (!checkAuth(c)) {
    return c.text('Unauthorized — provide DASHBOARD_TOKEN as Bearer auth, x-dashboard-token, or ?token=', 401);
  }

  // Codex sends the calling-agent's id in a custom header so handlers can do
  // per-agent gating (exec, spawn-depth, etc). Falls back to anonymous if
  // absent — most tools are still callable.
  const callerAgent = c.req.header('x-neuroclaw-agent-id') ?? null;

  const server = createNeuroclawHttpMcpServer({
    resolveContext: (): ToolContext => ({ agentId: callerAgent }),
  });

  // Stateless transport — each request gets its own short-lived transport.
  // `sessionIdGenerator: undefined` opts out of MCP session tracking entirely
  // so callers don't need an initialize-then-call dance; perfect for Codex's
  // one-shot tool invocations.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  // Bridge Hono's Web Request → Node's IncomingMessage/ServerResponse, which
  // is what the SDK transport expects. The Node adapter exposes them on c.env.
  const req = c.env.incoming;
  const res = c.env.outgoing;

  // Read body for POSTs — `req` is the IncomingMessage at the listener stage,
  // but Hono has already consumed it in some flows. Use Hono's parsed body
  // and pass it explicitly to handleRequest.
  let body: unknown = undefined;
  if (c.req.method === 'POST') {
    try { body = await c.req.json(); } catch { body = undefined; }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (transport as any).handleRequest(req, res, body);
  } catch (err) {
    logger.error('MCP HTTP: handleRequest failed', { err: (err as Error).message });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (err as Error).message } }));
    }
  }

  // Mark the response as already-handled — Hono should not write to it again.
  // Returning a no-op Response works because the Node adapter checks res.writableEnded.
  return new Response(null, { status: 200 });
}
