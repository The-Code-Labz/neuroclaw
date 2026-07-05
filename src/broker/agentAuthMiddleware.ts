/**
 * broker/agentAuthMiddleware.ts — Hono middleware enforcing HMAC agent auth.
 *
 * Critical invariants (spec v3 §6.3):
 *   - Strip `agent`, `agentName`, `agent_name` from the request body BEFORE
 *     any route handler runs — the body is NOT a trusted identity source.
 *   - The only identity used downstream is `c.get('agentCtx')`, populated
 *     from the verified Bearer token.
 *   - Errors map to HTTP 401 with a stable `error: <code>` body.
 *
 * The middleware also stashes the parsed body on the context so route handlers
 * can read it without re-parsing (Hono's `c.req.json()` is one-shot).
 */
import type { Context, Next } from 'hono';
import { verifyAgentToken, agentStore, AuthError } from './agentToken';
import type { AgentContext } from './types';

declare module 'hono' {
  interface ContextVariableMap {
    agentCtx: AgentContext;
    brokerBody: Record<string, unknown>;
  }
}

export async function agentAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  // 1. Parse + sanitise body
  let body: Record<string, unknown> = {};
  if (c.req.header('content-type')?.includes('application/json')) {
    try { body = await c.req.json<Record<string, unknown>>(); } catch { body = {}; }
  }
  delete body.agent;
  delete body.agentName;
  delete body.agent_name;

  // 2. Verify Bearer token
  const header = c.req.header('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    return c.json({ error: 'missing_bearer_token' }, 401);
  }
  const token = header.slice(7).trim();

  let ctx: AgentContext;
  try { ctx = verifyAgentToken(token); }
  catch (err) {
    if (err instanceof AuthError) return c.json({ error: err.code }, 401);
    return c.json({ error: 'auth_internal_error' }, 500);
  }

  c.set('agentCtx', ctx);
  c.set('brokerBody', body);

  // 3. Thread identity through async chains
  return new Promise<Response | void>((resolve, reject) => {
    agentStore.run(ctx, () => {
      next().then(() => resolve()).catch(reject);
    });
  });
}
