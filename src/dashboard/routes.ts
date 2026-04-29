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
import { chatStream, resolveAgent, type MetaEvent } from '../agent/alfred';
import { spawnAgent } from '../system/spawner';
import { getHiveEvents } from '../system/hive-mind';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerApiRoutes(app: Hono<any>): void {
  // ── Auth middleware ──────────────────────────────────────────────────────
  app.use('/api/*', async (c, next) => {
    const token = c.req.query('token') ?? c.req.header('x-dashboard-token') ?? '';
    if (token !== config.dashboard.token) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });

  // ── Status ───────────────────────────────────────────────────────────────
  app.get('/api/status', (c) => {
    const db = getDb();
    return c.json({
      status:   'online',
      model:    config.voidai.model,
      uptime:   process.uptime(),
      agents:   (db.prepare("SELECT COUNT(*) as n FROM agents WHERE status = 'active'").get() as { n: number }).n,
      sessions: (db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n,
      tempAgents: (db.prepare("SELECT COUNT(*) as n FROM agents WHERE temporary = 1 AND status = 'active'").get() as { n: number }).n,
    });
  });

  // ── Sessions / Messages ──────────────────────────────────────────────────
  app.get('/api/sessions', (c) => {
    return c.json(getDb().prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50').all());
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
    const id    = c.req.param('id');
    const agent = getAgentById(id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[]; status?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

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
    const result = deactivateAgent(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.reason ?? 'Cannot deactivate' }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:id/activate', (c) => {
    const id = c.req.param('id');
    if (!getAgentById(id)) return c.json({ error: 'Agent not found' }, 404);
    activateAgent(id);
    return c.json({ ok: true });
  });

  // ── Spawn (manual) ────────────────────────────────────────────────────────
  app.post('/api/agents/spawn', async (c) => {
    let body: {
      name?: string; role?: string; description?: string;
      capabilities?: string[]; systemPrompt?: string;
      parentAgentId?: string; taskDescription?: string;
    };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    if (!body.name || !body.parentAgentId) {
      return c.json({ error: 'name and parentAgentId are required' }, 400);
    }

    const result = spawnAgent({
      name:            body.name,
      role:            body.role ?? 'specialist',
      description:     body.description ?? '',
      capabilities:    body.capabilities ?? [],
      systemPrompt:    body.systemPrompt ?? `You are ${body.name}, a temporary specialist agent.`,
      parentAgentId:   body.parentAgentId,
      taskDescription: body.taskDescription,
    });

    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json(result.agent, 201);
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

    // createTask is now async (may call classifier for auto-assign)
    const task = await createTask(title, body.description?.trim(), body.session_id, body.agent_id, body.priority);
    return c.json(task, 201);
  });

  app.patch('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    if (!getDb().prepare('SELECT id FROM tasks WHERE id = ?').get(id)) {
      return c.json({ error: 'Task not found' }, 404);
    }

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

  // ── Memory / Config / Analytics / Logs ───────────────────────────────────
  app.get('/api/memory',    (c) => c.json(getMemories()));
  app.get('/api/analytics', (c) => c.json(getAnalyticsSummary()));
  app.get('/api/logs',      (c) => c.json(getRecentLogs()));
  app.get('/api/hive',      (c) => c.json(getHiveEvents(parseInt(c.req.query('limit') ?? '100', 10))));

  app.get('/api/config', (c) => {
    type Row = { key: string; value: string; description: string | null; is_secret: number };
    const items = getDb().prepare('SELECT key, value, description, is_secret FROM config_items').all() as Row[];
    return c.json(items.map(item => ({
      ...item,
      value: item.is_secret ? '***REDACTED***' : item.value,
    })));
  });

  // ── Chat (SSE — with routing + spawn events) ──────────────────────────────
  app.post('/api/chat', async (c) => {
    let body: { message?: string; sessionId?: string; agentId?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

    const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
    if (!rawMessage) return c.json({ error: 'message is required' }, 400);

    const resolved = await resolveAgent(rawMessage, body.agentId);
    const { agent, message } = resolved;
    const sessionId    = body.sessionId ?? createSession(agent.id, 'Dashboard Chat');
    const systemPrompt = agent.system_prompt ?? 'You are a helpful AI assistant.';

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'session', sessionId }) });
      await stream.writeSSE({ data: JSON.stringify({ type: 'agent', name: agent.name, agentId: agent.id }) });

      if (resolved.routeEvent) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'route', ...resolved.routeEvent }) });
      }

      const onMeta = async (e: MetaEvent) => {
        try {
          if (e.type === 'spawn') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'spawn', agentName: e.event.agentName, agentId: e.event.agentId }) });
          } else if (e.type === 'spawn_chunk') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'spawn_chunk', agentName: e.agentName, content: e.content }) });
          } else if (e.type === 'spawn_done') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'spawn_done', agentName: e.agentName }) });
          }
        } catch { /* stream closed */ }
      };

      try {
        await chatStream(message, sessionId, async (chunk) => {
          await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: chunk }) });
        }, systemPrompt, agent.id, onMeta);
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: msg }) }); } catch { /* closed */ }
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
