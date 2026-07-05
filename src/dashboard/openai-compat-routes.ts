import { createHash, randomUUID } from 'crypto';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getAllAgents,
  getAgentByName,
  getOrCreateSessionByExternalId,
  type AgentRecord,
} from '../db';
import { chatStream } from '../agent/alfred';
import { config } from '../config';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the bearer token from an Authorization header. */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Derive a stable, opaque external session key for the DB.
 * Never returned to the client — only used internally to look up a session UUID.
 * Keyed on agentId (not name) so renames don't break session continuity.
 */
function deriveExtId(token: string, agentId: string, userSuffix?: string): string {
  const salt = userSuffix ? `:${userSuffix}` : '';
  const hash = createHash('sha256').update(`${token}:${agentId}${salt}`).digest('hex').slice(0, 16);
  return `openai-compat::${agentId}::${hash}`;
}

/** Standard OpenAI-shaped error response. */
function oaiErr(c: any, status: 400 | 401 | 404 | 500, message: string, type: string, code: string) {
  return c.json({ error: { message, type, code } }, status);
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerOpenAiCompatRoutes(app: Hono<any>): void {

  // ── Auth middleware — all /v1/* routes ──────────────────────────────────
  app.use('/v1/*', async (c, next) => {
    const token = extractBearer(c.req.header('authorization'));
    if (!token || token !== config.dashboard.token) {
      return c.json(
        { error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 'invalid_api_key' } },
        401,
      );
    }
    await next();
  });

  // ── GET /v1/models ───────────────────────────────────────────────────────
  app.get('/v1/models', (c) => {
    const agents = getAllAgents().filter(a => a.status === 'active' && a.temporary === 0);
    const data = agents.map(a => ({
      id:       a.name,
      object:   'model' as const,
      created:  Math.floor(new Date(a.created_at).getTime() / 1000),
      owned_by: 'neuroclaw',
    }));
    return c.json({ object: 'list' as const, data });
  });

  // ── POST /v1/chat/completions ─────────────────────────────────────────────
  app.post('/v1/chat/completions', async (c) => {
    // Token already validated by the /v1/* middleware — extractBearer cannot return null here.
    const token = extractBearer(c.req.header('authorization'))!;

    // ── Parse body ──────────────────────────────────────────────────────────
    let body: {
      model?:    string;
      messages?: Array<{ role: string; content: string }>;
      stream?:   boolean;
      user?:     string;
    };
    try { body = await c.req.json(); }
    catch { return oaiErr(c, 400, 'Invalid JSON body.', 'invalid_request_error', 'invalid_request'); }

    const { model, messages, stream = false, user: userSuffix } = body;

    if (!model) {
      return oaiErr(c, 400, "'model' is required.", 'invalid_request_error', 'invalid_request');
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return oaiErr(c, 400, "'messages' must be a non-empty array.", 'invalid_request_error', 'invalid_request');
    }

    // ── Model resolution ────────────────────────────────────────────────────
    const agentRecord: AgentRecord | undefined = getAgentByName(model);
    if (!agentRecord || agentRecord.status !== 'active' || agentRecord.temporary !== 0) {
      return oaiErr(c, 404, `Model '${model}' not found.`, 'invalid_request_error', 'model_not_found');
    }

    // ── Message handling ────────────────────────────────────────────────────
    // System messages → extraSystemContext (appended, not replacing agent's stored prompt).
    // Last user message → live input. Prior turns are ignored — NeuroClaw's DB is authoritative.
    const systemParts = messages
      .filter(m => m.role === 'system' && typeof m.content === 'string')
      .map(m => m.content);

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) {
      return oaiErr(c, 400, "At least one message with role 'user' is required.", 'invalid_request_error', 'invalid_request');
    }

    const userMessage        = lastUserMsg.content;
    const extraSystemContext = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    const systemPrompt       = agentRecord.system_prompt ?? 'You are a helpful AI assistant.';

    // ── Session identity ────────────────────────────────────────────────────
    // getOrCreateSessionByExternalId() resolves a stable DB-backed UUID from the
    // derived external key. The extId is NEVER echoed in any response field.
    const extId     = deriveExtId(token, agentRecord.id, userSuffix);
    const sessionId = getOrCreateSessionByExternalId(extId, agentRecord.id, `openai-compat: ${agentRecord.name}`, 'openai-compat');

    // ── Dispatch ────────────────────────────────────────────────────────────
    const completionId = `chatcmpl-${randomUUID()}`;  // never the extId
    const created      = Math.floor(Date.now() / 1000);

    if (stream) {
      // ── Streaming ─────────────────────────────────────────────────────────
      c.header('X-Accel-Buffering', 'no');
      return streamSSE(c, async (sseStream) => {
        // Opening chunk — role announcement
        await sseStream.writeSSE({ data: JSON.stringify({
          id:      completionId,
          object:  'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        })});

        try {
          await chatStream(
            userMessage,
            sessionId,
            async (chunk) => {
              await sseStream.writeSSE({ data: JSON.stringify({
                id:      completionId,
                object:  'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
              })});
            },
            systemPrompt,
            agentRecord.id,
            undefined,          // onMeta
            undefined,          // attachments
            extraSystemContext,
            undefined,          // runId
            c.req.raw.signal,
          );
        } catch (err) {
          const isAbort = err instanceof Error &&
            (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ERR_ABORTED');
          if (!isAbort) {
            // Real agent error — emit SSE error event so callers aren't misled by a clean [DONE]
            try {
              await sseStream.writeSSE({ data: JSON.stringify({
                error: {
                  message: err instanceof Error ? err.message.slice(0, 200) : String(err),
                  type:    'server_error',
                  code:    'agent_error',
                },
              })});
            } catch { /* stream already closed */ }
          }
        }

        // Closing chunk — finish_reason
        await sseStream.writeSSE({ data: JSON.stringify({
          id:      completionId,
          object:  'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })});

        await sseStream.writeSSE({ data: '[DONE]' });
      });
    }

    // ── Non-streaming ────────────────────────────────────────────────────────
    let fullContent = '';
    try {
      await chatStream(
        userMessage,
        sessionId,
        (chunk) => { fullContent += chunk; },
        systemPrompt,
        agentRecord.id,
        undefined,          // onMeta
        undefined,          // attachments
        extraSystemContext,
        undefined,          // runId
        c.req.raw.signal,
      );
    } catch (err) {
      return oaiErr(c, 500, `Agent error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`, 'server_error', 'agent_error');
    }

    return c.json({
      id:      completionId,
      object:  'chat.completion',
      created,
      model,
      choices: [{
        index:         0,
        message:       { role: 'assistant', content: fullContent },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
}
