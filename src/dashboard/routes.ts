import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getDb, createSession, getAllAgents, getAgentById,
  createAgentRecord, updateAgentRecord, deactivateAgent, activateAgent,
} from '../db';
import { config } from '../config';
import { getAnalyticsSummary } from '../system/analytics';
import { getRecentLogs } from '../system/audit';
import { getMemories } from '../memory/memory-service';
import { getTasks, createTask, updateTask, type TaskStatus } from '../system/task-manager';
import { configEvents } from '../system/config-watcher';
import { chatStream, resolveAgent } from '../agent/alfred';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerApiRoutes(app: Hono<any>): void {
  // ── Auth middleware ──────────────────────────────────────────────────────
  app.use('/api/*', async (c, next) => {
    const token = c.req.query('token') ?? c.req.header('x-dashboard-token') ?? '';
    if (token !== config.dashboard.token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // ── Status ───────────────────────────────────────────────────────────────
  app.get('/api/status', (c) => {
    const db = getDb();
    const agents   = (db.prepare('SELECT COUNT(*) as n FROM agents WHERE status = ?').get('active') as { n: number }).n;
    const sessions = (db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n;
    const messages = (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n;
    return c.json({
      status: 'online',
      model:  config.voidai.model,
      uptime: process.uptime(),
      agents,
      sessions,
      messages,
    });
  });

  // ── Sessions ─────────────────────────────────────────────────────────────
  app.get('/api/sessions', (c) => {
    const rows = getDb().prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50').all();
    return c.json(rows);
  });

  app.get('/api/messages', (c) => {
    const sessionId = c.req.query('session_id');
    const rows = sessionId
      ? getDb().prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId)
      : getDb().prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 100').all();
    return c.json(rows);
  });

  // ── Agents ───────────────────────────────────────────────────────────────
  app.get('/api/agents', (c) => c.json(getAllAgents()));

  app.post('/api/agents', async (c) => {
    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[] };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (getDb().prepare('SELECT id FROM agents WHERE name = ? COLLATE NOCASE').get(name)) {
      return c.json({ error: 'An agent with that name already exists' }, 409);
    }

    const agent = createAgentRecord(name, {
      description:  body.description?.trim(),
      systemPrompt: body.system_prompt?.trim(),
      model:        body.model?.trim() || config.voidai.model,
      role:         body.role ?? 'agent',
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
    });
    return c.json(agent, 201);
  });

  app.patch('/api/agents/:id', async (c) => {
    const id = c.req.param('id');
    const agent = getAgentById(id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[]; status?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    // Prevent renaming Alfred
    if (agent.name === 'Alfred' && body.name && body.name.trim() !== 'Alfred') {
      return c.json({ error: 'Alfred cannot be renamed' }, 403);
    }

    updateAgentRecord(id, {
      name:          body.name?.trim(),
      description:   body.description?.trim(),
      system_prompt: body.system_prompt?.trim(),
      model:         body.model?.trim(),
      role:          body.role,
      capabilities:  Array.isArray(body.capabilities) ? body.capabilities : undefined,
      status:        body.status,
    });
    return c.json(getAgentById(id));
  });

  app.delete('/api/agents/:id', (c) => {
    const id = c.req.param('id');
    const result = deactivateAgent(id);
    if (!result.ok) return c.json({ error: result.reason ?? 'Cannot deactivate' }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:id/activate', (c) => {
    const id = c.req.param('id');
    if (!getAgentById(id)) return c.json({ error: 'Agent not found' }, 404);
    activateAgent(id);
    return c.json({ ok: true });
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────
  app.get('/api/tasks', (c) => {
    const status = c.req.query('status') as TaskStatus | undefined;
    return c.json(getTasks(status));
  });

  app.post('/api/tasks', async (c) => {
    let body: { title?: string; description?: string; agent_id?: string; priority?: number; session_id?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const title = (body.title ?? '').trim();
    if (!title) return c.json({ error: 'title is required' }, 400);

    const task = createTask(title, body.description?.trim(), body.session_id, body.agent_id, body.priority);
    return c.json(task, 201);
  });

  app.patch('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getDb().prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    let body: { status?: TaskStatus; agent_id?: string | null; title?: string; description?: string; priority?: number };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    updateTask(id, {
      status:      body.status,
      agent_id:    body.agent_id,
      title:       body.title?.trim(),
      description: body.description?.trim(),
      priority:    body.priority,
    });
    return c.json(getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  });

  // ── Memory ────────────────────────────────────────────────────────────────
  app.get('/api/memory', (c) => c.json(getMemories()));

  // ── Config ────────────────────────────────────────────────────────────────
  app.get('/api/config', (c) => {
    type Row = { key: string; value: string; description: string | null; is_secret: number };
    const items = getDb().prepare('SELECT key, value, description, is_secret FROM config_items').all() as Row[];
    return c.json(items.map((item) => ({
      ...item,
      value: item.is_secret ? '***REDACTED***' : item.value,
    })));
  });

  // ── Analytics / Logs ──────────────────────────────────────────────────────
  app.get('/api/analytics', (c) => c.json(getAnalyticsSummary()));
  app.get('/api/logs',      (c) => c.json(getRecentLogs()));

  // ── Chat (SSE streaming with @mention delegation) ─────────────────────────
  app.post('/api/chat', async (c) => {
    let body: { message?: string; sessionId?: string; agentId?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

    const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
    if (!rawMessage) return c.json({ error: 'message is required' }, 400);

    // Resolve target agent — @mention wins over explicit agentId
    const resolved = resolveAgent(rawMessage, body.agentId);
    if (!resolved) return c.json({ error: 'No active agent found' }, 500);

    const { agent, message } = resolved;
    const sessionId = body.sessionId ?? createSession(agent.id, 'Dashboard Chat');
    const systemPrompt = agent.system_prompt ?? 'You are a helpful AI assistant.';

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'session', sessionId }) });
      await stream.writeSSE({ data: JSON.stringify({ type: 'agent', name: agent.name, agentId: agent.id }) });

      try {
        await chatStream(message, sessionId, async (chunk) => {
          await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: chunk }) });
        }, systemPrompt, agent.id);
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: msg }) });
        } catch { /* stream already closed */ }
      }
    });
  });

  // ── Config watcher (SSE) ──────────────────────────────────────────────────
  app.get('/api/config/watch', (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });

      const onChange = async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'config_changed' }) }); } catch { /* closed */ }
      };
      configEvents.on('change', onChange);

      const pingId = setInterval(async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); }
        catch { clearInterval(pingId); }
      }, 20000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          configEvents.off('change', onChange);
          clearInterval(pingId);
          resolve();
        });
      });
    });
  });
}
