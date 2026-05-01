import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getDb, createSession, getAllAgents, getAgentById,
  createAgentRecord, updateAgentRecord, deactivateAgent, activateAgent,
  getSessions, getSessionById, getSessionMessages, updateSessionTitle, deleteSession,
  getAgentMessages,
  type SessionRecord, type MessageRecord,
} from '../db';
import { config } from '../config';
import { getAnalyticsSummary } from '../system/analytics';
import { getRecentLogs } from '../system/audit';
import { getMemories, saveMemory } from '../memory/memory-service';
import { getTasks, createTask, updateTask, type TaskStatus } from '../system/task-manager';
import { configEvents } from '../system/config-watcher';
import { chatStream, orchestrateMultiAgent, resolveAgent, type MetaEvent } from '../agent/alfred';
import { spawnAgent } from '../system/spawner';
import { getHiveEvents } from '../system/hive-mind';
import { taskEvents, getTasksBySession, type BackgroundTask } from '../system/background-tasks';
import { getAnthropicAuthStatus } from '../agent/anthropic-client';
import { getClaudeCliQueueLength, probeClaudeCli } from '../providers/claude-cli';
import {
  listCatalog, refreshCatalog, setTierOverride, setPriceOverride,
  type ModelTier, type ModelProvider,
} from '../system/model-catalog';
import { spendLastHourWithCost, spendByTierLastHour, spendByModelLastHour } from '../system/model-spend';

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
    const anthropic = getAnthropicAuthStatus();
    return c.json({
      status:     'online',
      model:      config.voidai.model,
      uptime:     process.uptime(),
      agents:     (db.prepare("SELECT COUNT(*) as n FROM agents WHERE status = 'active'").get() as { n: number }).n,
      sessions:   (db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n,
      messages:   (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n,
      tempAgents: (db.prepare("SELECT COUNT(*) as n FROM agents WHERE temporary = 1 AND status = 'active'").get() as { n: number }).n,
      anthropic,
    });
  });

  // ── Claude backend status ────────────────────────────────────────────────
  app.get('/api/claude/status', async (c) => {
    const probe = await probeClaudeCli();
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
    const recent429 = (getDb().prepare(
      "SELECT COUNT(*) as n FROM hive_mind WHERE action = 'claude_cli_throttled' AND created_at > datetime('now', '-1 hour')"
    ).get() as { n: number }).n;
    return c.json({
      backend:           config.claude.backend,
      cliCommand:        config.claude.cliCommand,
      cliBinaryFound:    probe.ok,
      cliVersion:        probe.version,
      cliError:          probe.error,
      maxTurns:          config.claude.maxTurns,
      timeoutMs:         config.claude.timeoutMs,
      concurrencyLimit:  config.claude.concurrencyLimit,
      queueLength:       getClaudeCliQueueLength(),
      retryMax:          config.claude.retryMax,
      retryBaseMs:       config.claude.retryBaseMs,
      anthropicApiKeySet: !!apiKey,
      auth:              getAnthropicAuthStatus(),
      throttled1h:       recent429,
    });
  });

  // ── Sessions / Messages ──────────────────────────────────────────────────
  app.get('/api/sessions', (c) => {
    const sessions = getSessions(100);
    // Add last message preview for each session
    const db = getDb();
    const withPreviews = sessions.map(s => {
      const lastMsg = db.prepare(
        'SELECT content, role FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(s.id) as { content: string; role: string } | undefined;
      return {
        ...s,
        last_message: lastMsg ? lastMsg.content.slice(0, 100) + (lastMsg.content.length > 100 ? '…' : '') : null,
        last_role: lastMsg?.role ?? null,
      };
    });
    return c.json(withPreviews);
  });

  app.get('/api/sessions/:id', (c) => {
    const session = getSessionById(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json(session);
  });

  app.get('/api/sessions/:id/messages', (c) => {
    const session = getSessionById(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json(getSessionMessages(c.req.param('id')));
  });

  app.patch('/api/sessions/:id', async (c) => {
    const session = getSessionById(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    let body: { title?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (body.title) updateSessionTitle(c.req.param('id'), body.title.trim());
    return c.json(getSessionById(c.req.param('id')));
  });

  app.delete('/api/sessions/:id', (c) => {
    const session = getSessionById(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    deleteSession(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/messages', (c) => {
    const sessionId = c.req.query('session_id');
    if (sessionId) {
      return c.json(getSessionMessages(sessionId));
    }
    return c.json(getDb().prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 100').all());
  });

  // ── Agents ───────────────────────────────────────────────────────────────
  app.get('/api/agents', (c) => c.json(getAllAgents()));

  app.post('/api/agents', async (c) => {
    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[]; provider?: string; exec_enabled?: boolean; model_tier?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (getDb().prepare('SELECT id FROM agents WHERE name = ? COLLATE NOCASE').get(name)) {
      return c.json({ error: 'An agent with that name already exists' }, 409);
    }

    const provider    = body.provider ?? 'openai';
    const defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-6' : config.voidai.model;
    const agent = createAgentRecord(name, {
      description:  body.description?.trim(),
      systemPrompt: body.system_prompt?.trim(),
      model:        body.model?.trim() || defaultModel,
      role:         body.role ?? 'agent',
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      provider,
      exec_enabled: !!body.exec_enabled,
      model_tier:   body.model_tier,
    });
    return c.json(agent, 201);
  });

  app.patch('/api/agents/:id', async (c) => {
    const id    = c.req.param('id');
    const agent = getAgentById(id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[]; status?: string; provider?: string; exec_enabled?: boolean; model_tier?: string };
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
      provider:      body.provider,
      exec_enabled:  body.exec_enabled,
      model_tier:    body.model_tier,
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
  app.get('/api/memory',    (c) => c.json(getMemories(100)));
  
  app.post('/api/memory', async (c) => {
    let body: { content?: string; type?: string; importance?: number; sessionId?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const content = (body.content ?? '').trim();
    if (!content) return c.json({ error: 'content is required' }, 400);
    const memory = saveMemory(content, body.type ?? 'general', body.sessionId, body.importance ?? 5);
    return c.json(memory, 201);
  });

  app.delete('/api/memory/:id', (c) => {
    const id = c.req.param('id');
    const exists = getDb().prepare('SELECT id FROM memories WHERE id = ?').get(id);
    if (!exists) return c.json({ error: 'Memory not found' }, 404);
    getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  // ── memory_index (v1.4+ long-term memory) ────────────────────────────────
  app.get('/api/memory/index', (c) => {
    const limit = Math.min(500, parseInt(c.req.query('limit') ?? '100', 10));
    const type  = c.req.query('type');
    const sessionId = c.req.query('sessionId');
    const where: string[] = [];
    const args: unknown[] = [];
    if (type)      { where.push('type = ?');       args.push(type); }
    if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
    const sql = `
      SELECT id, type, title, summary, tags, importance, salience,
             agent_id, session_id, vault_note_id, vault_path,
             created_at, last_accessed
      FROM memory_index
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY datetime(COALESCE(last_accessed, created_at)) DESC
      LIMIT ?
    `;
    args.push(limit);
    return c.json(getDb().prepare(sql).all(...args));
  });

  app.get('/api/memory/index/stats', (c) => {
    const db = getDb();
    const total      = (db.prepare('SELECT COUNT(*) as n FROM memory_index').get() as { n: number }).n;
    const byType     = db.prepare(`
      SELECT type, COUNT(*) as n,
             AVG(importance) as avg_importance,
             AVG(salience)   as avg_salience
      FROM memory_index GROUP BY type ORDER BY n DESC
    `).all();
    const lastHour   = (db.prepare(`
      SELECT COUNT(*) as n FROM memory_index WHERE created_at > datetime('now','-1 hour')
    `).get() as { n: number }).n;
    const lastDay    = (db.prepare(`
      SELECT COUNT(*) as n FROM memory_index WHERE created_at > datetime('now','-1 day')
    `).get() as { n: number }).n;
    const cappedHour = (db.prepare(`
      SELECT COUNT(*) as n FROM hive_mind
       WHERE action = 'memory_capped' AND created_at > datetime('now','-1 hour')
    `).get() as { n: number }).n;
    const compactedDay = (db.prepare(`
      SELECT COUNT(*) as n FROM hive_mind
       WHERE action = 'memory_extracted'
         AND metadata LIKE '%"source":"auto_compact"%'
         AND created_at > datetime('now','-1 day')
    `).get() as { n: number }).n;
    return c.json({ total, byType, lastHour, lastDay, cappedHour, compactedDay });
  });

  app.get('/api/memory/hive', (c) => {
    const limit = Math.min(500, parseInt(c.req.query('limit') ?? '100', 10));
    const rows = getDb().prepare(`
      SELECT id, agent_id, action, summary, metadata, created_at
      FROM hive_mind
      WHERE action IN ('memory_extracted','memory_skipped','memory_capped')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    return c.json(rows);
  });

  // ── Model catalog ────────────────────────────────────────────────────────
  app.get('/api/models', (c) => {
    const provider = c.req.query('provider');
    const tier = c.req.query('tier') as ModelTier | undefined;
    const includeUnavailable = c.req.query('includeUnavailable') === '1';
    return c.json(listCatalog({ provider, tier, includeUnavailable }));
  });

  app.post('/api/models/refresh', async (c) => {
    const provider = (c.req.query('provider') ?? 'voidai') as ModelProvider;
    try {
      const result = await refreshCatalog(provider);
      return c.json({ ok: true, provider, ...result });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/models/:provider/:modelId/tier', async (c) => {
    const provider = c.req.param('provider');
    const modelId  = c.req.param('modelId');
    let body: { tier?: ModelTier | null };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (body.tier !== null && !['low', 'mid', 'high'].includes(String(body.tier))) {
      return c.json({ error: 'tier must be low|mid|high|null' }, 400);
    }
    setTierOverride(provider, modelId, body.tier ?? null);
    return c.json({ ok: true });
  });

  app.post('/api/models/:provider/:modelId/price', async (c) => {
    const provider = c.req.param('provider');
    const modelId  = c.req.param('modelId');
    let body: { input?: number | null; output?: number | null };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    setPriceOverride(provider, modelId, body.input ?? null, body.output ?? null);
    return c.json({ ok: true });
  });

  app.get('/api/models/spend', (c) => {
    return c.json({
      lastHour:    spendLastHourWithCost(),
      byTier:      spendByTierLastHour(),
      byModel:     spendByModelLastHour(20),
    });
  });

  app.delete('/api/memory/index/:id', (c) => {
    const id = c.req.param('id');
    const exists = getDb().prepare('SELECT id FROM memory_index WHERE id = ?').get(id);
    if (!exists) return c.json({ error: 'Memory not found' }, 404);
    getDb().prepare('DELETE FROM memory_index WHERE id = ?').run(id);
    return c.json({ ok: true });
  });
    app.get('/api/analytics', (c) => { try { return c.json(getAnalyticsSummary()); } catch(e) { console.error('Analytics:',e); return c.json({error:String(e)},500); } });
  app.get('/api/logs',      (c) => c.json(getRecentLogs()));
  app.get('/api/hive',          (c) => c.json(getHiveEvents(parseInt(c.req.query('limit') ?? '100', 10))));
  app.get('/api/agent-messages', (c) => c.json(getAgentMessages(parseInt(c.req.query('limit') ?? '100', 10))));

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
          } else if (e.type === 'spawn_started') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'spawn_started', agentName: e.agentName, taskId: e.taskId }) });
          } else if (e.type === 'spawn_chunk') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'spawn_chunk', agentName: e.agentName, content: e.content }) });
          } else if (e.type === 'spawn_done') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'spawn_done', agentName: e.agentName, result: e.result }) });
          } else if (e.type === 'plan') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'plan', steps: e.steps }) });
          } else if (e.type === 'step_start') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'step_start', stepIndex: e.stepIndex, task: e.task, agentName: e.agentName }) });
          } else if (e.type === 'step_chunk') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'step_chunk', stepIndex: e.stepIndex, agentName: e.agentName, content: e.content }) });
          } else if (e.type === 'step_done') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'step_done', stepIndex: e.stepIndex, agentName: e.agentName }) });
          } else if (e.type === 'merge_start') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'merge_start' }) });
          } else if (e.type === 'spawn_eval') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'spawn_eval', task: e.task, shouldSpawn: e.shouldSpawn, benefit: e.benefit, reason: e.reason }) });
          } else if (e.type === 'agent_message') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'agent_message', fromName: e.fromName, toName: e.toName, preview: e.preview }) });
          } else if (e.type === 'agent_task_assigned') {
            await stream.writeSSE({ data: JSON.stringify({ type: 'agent_task_assigned', fromName: e.fromName, toName: e.toName, title: e.title, taskId: e.taskId, executing: e.executing }) });
          }
        } catch { /* stream closed */ }
      };

      try {
        // Use multi-agent orchestration when Alfred is handling the message
        if (agent.name === 'Alfred') {
          await orchestrateMultiAgent(message, sessionId, async (chunk) => {
            await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: chunk }) });
          }, agent.id, onMeta);
        } else {
          await chatStream(message, sessionId, async (chunk) => {
            await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: chunk }) });
          }, systemPrompt, agent.id, onMeta);
        }
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: msg }) }); } catch { /* closed */ }
      }
    });
  });

  // ── Background task updates (SSE) ────────────────────────────────────────────
  app.get('/api/tasks/watch', (c) => {
    const sessionId = c.req.query('sessionId');
    
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });

      const onComplete = async (task: BackgroundTask) => {
        // Only send if no sessionId filter, or task matches session
        if (!sessionId || task.sessionId === sessionId) {
          try {
            await stream.writeSSE({ data: JSON.stringify({
              type: 'task_complete',
              taskId: task.id,
              agentName: task.agentName,
              result: task.result,
            }) });
          } catch { /* stream closed */ }
        }
      };

      const onFailed = async (task: BackgroundTask) => {
        if (!sessionId || task.sessionId === sessionId) {
          try {
            await stream.writeSSE({ data: JSON.stringify({
              type: 'task_failed',
              taskId: task.id,
              agentName: task.agentName,
              error: task.error,
            }) });
          } catch { /* closed */ }
        }
      };

      const onCreated = async (info: { taskId: string; title: string; toName: string; fromName: string; status: string }) => {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'task_created', ...info }) });
        } catch { /* closed */ }
      };

      taskEvents.on('task_complete', onComplete);
      taskEvents.on('task_failed', onFailed);
      taskEvents.on('task_created', onCreated);

      const pingId = setInterval(async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); }
        catch { clearInterval(pingId); }
      }, 20000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          taskEvents.off('task_complete', onComplete);
          taskEvents.off('task_failed', onFailed);
          taskEvents.off('task_created', onCreated);
          clearInterval(pingId);
          resolve();
        });
      });
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
