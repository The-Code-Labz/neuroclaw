import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getDb, createSession, getAllAgents, getAgentById,
  createAgentRecord, updateAgentRecord, deactivateAgent, activateAgent, deleteAgentHard,
  getSessions, getSessionById, getSessionMessages, updateSessionTitle, deleteSession,
  getAgentMessages,
  listAreas, createArea, updateArea, deleteArea, setAgentArea,
  listProjects, getProject, createProject, updateProject, archiveProject, deleteProjectHard,
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
import {
  vaultGetTree, vaultReadNote, vaultListFiles, vaultListCollections,
} from '../memory/vault-client';
import {
  listSkills, clearSkillCache, getSkill,
  createSkill, updateSkill, deleteSkill,
  writeSkillScript, deleteSkillScript,
  sanitizeSkillName,
} from '../skills/skill-loader';
import fs from 'fs';
import path from 'path';
import { runDreamCycle } from '../memory/dream-cycle';
import { runHeartbeats, pingAgent } from '../system/heartbeat';
import { synthesize, resolveAgentVoice } from '../audio/tts';
import { transcribe } from '../audio/transcribe';
import { listVoidAIVoices, listElevenLabsVoices, listAllVoices } from '../audio/voices';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectTreeItems(node: any): { path: string; parent: string; name: string }[] {
  const out: { path: string; parent: string; name: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (n: any): void => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (typeof n !== 'object') return;
    if (Array.isArray(n.items)) for (const it of n.items) {
      if (it?.full_path) out.push({ path: it.full_path, parent: it.parent_path ?? '', name: it.filename ?? it.full_path });
    }
    if (n.data) visit(n.data);
  };
  visit(node);
  return out;
}

interface TreeNode { name: string; children?: TreeNode[]; path?: string }
function buildTree(items: { path: string; parent: string; name: string }[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirIdx: Record<string, TreeNode> = {};
  // First pass: create folder nodes from parent paths so we always have a folder, even when empty.
  for (const it of items) {
    const segs = it.path.replace(/^\//, '').split('/');
    let bucket = root;
    let acc = '';
    for (let i = 0; i < segs.length - 1; i++) {
      acc += '/' + segs[i];
      if (!dirIdx[acc]) {
        const folder: TreeNode = { name: segs[i] + '/', children: [] };
        dirIdx[acc] = folder;
        bucket.push(folder);
      }
      bucket = dirIdx[acc].children!;
    }
    bucket.push({ name: segs[segs.length - 1], path: it.path });
  }
  return root;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractContentText(payload: any): string | null {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return payload.map(extractContentText).filter(Boolean).join('\n');
  // Live MCP shape: { data: { file: { content: '...' } } }
  if (payload.data?.file?.content && typeof payload.data.file.content === 'string') return payload.data.file.content;
  if (payload.file?.content    && typeof payload.file.content    === 'string') return payload.file.content;
  if (payload.data?.content    && typeof payload.data.content    === 'string') return payload.data.content;
  if (payload.content          && typeof payload.content          === 'string') return payload.content;
  if (payload.text             && typeof payload.text             === 'string') return payload.text;
  if (payload.data) return extractContentText(payload.data);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerApiRoutes(app: Hono<any>): void {
  // ── Auth middleware ──────────────────────────────────────────────────────
  app.use('/api/*', async (c, next) => {
    const cookie = c.req.header('cookie') ?? '';
    const cookieToken = /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookie)?.[1];
    const token = c.req.query('token') ?? c.req.header('x-dashboard-token') ?? cookieToken ?? '';
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
    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[]; provider?: string; exec_enabled?: boolean; model_tier?: string; skills?: string[] };
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
      skills:       Array.isArray(body.skills) ? body.skills : undefined,
    });
    return c.json(agent, 201);
  });

  app.patch('/api/agents/:id', async (c) => {
    const id    = c.req.param('id');
    const agent = getAgentById(id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[]; status?: string; provider?: string; exec_enabled?: boolean; model_tier?: string; skills?: string[]; vision_mode?: string; composio_enabled?: boolean; composio_user_id?: string | null; composio_toolkits?: string[] | null; tts_enabled?: boolean; tts_provider?: string; tts_voice?: string | null };
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
      skills:        Array.isArray(body.skills) ? body.skills : undefined,
      vision_mode:   body.vision_mode,
      composio_enabled:  body.composio_enabled,
      composio_user_id:  body.composio_user_id !== undefined ? (body.composio_user_id?.trim() || null) : undefined,
      composio_toolkits: body.composio_toolkits === null
        ? null
        : (Array.isArray(body.composio_toolkits) ? body.composio_toolkits : undefined),
      tts_enabled:   body.tts_enabled,
      tts_provider:  body.tts_provider?.trim(),
      tts_voice:     body.tts_voice === undefined ? undefined : (body.tts_voice ? body.tts_voice.trim() : null),
    });
    return c.json(getAgentById(id));
  });

  app.delete('/api/agents/:id', (c) => {
    const id = c.req.param('id');
    // ?hard=1 → permanent delete (FK refs nulled on tasks/messages/comms)
    if (c.req.query('hard') === '1' || c.req.query('hard') === 'true') {
      const result = deleteAgentHard(id);
      if (!result.ok) return c.json({ error: result.reason ?? 'Cannot delete' }, 400);
      return c.json({ ok: true, hard: true, cleared: result.cleared });
    }
    const result = deactivateAgent(id);
    if (!result.ok) return c.json({ error: result.reason ?? 'Cannot deactivate' }, 400);
    return c.json({ ok: true });
  });

  app.delete('/api/agents/:id/hard', (c) => {
    const result = deleteAgentHard(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.reason ?? 'Cannot delete' }, 400);
    return c.json({ ok: true, hard: true, cleared: result.cleared });
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

    let body: {
      status?:         TaskStatus;
      agent_id?:       string | null;
      title?:          string;
      description?:    string;
      priority?:       number;
      priority_level?: 'low' | 'medium' | 'high' | 'critical';
      project_id?:     string | null;
      parent_task_id?: string | null;
      assignee?:       string;
      task_order?:     number;
      feature?:        string | null;
      sources?:        unknown;
      code_examples?:  unknown;
      archived?:       boolean;
    };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    updateTask(id, {
      status:         body.status,
      agent_id:       body.agent_id,
      title:          body.title?.trim(),
      description:    body.description?.trim(),
      priority:       body.priority,
      priority_level: body.priority_level,
      project_id:     body.project_id,
      parent_task_id: body.parent_task_id,
      assignee:       body.assignee,
      task_order:     body.task_order,
      feature:        body.feature,
      sources:        body.sources,
      code_examples:  body.code_examples,
      archived:       body.archived,
    });
    return c.json(getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  });

  // ── Projects (Archon port — v1.9) ────────────────────────────────────────
  // Top-level grouping for tasks. Soft-delete (archived) is the default;
  // pass ?hard=1 to permanently remove (tasks reassigned to default project).

  app.get('/api/projects', (c) => {
    const includeArchived = c.req.query('include_archived') === '1' || c.req.query('include_archived') === 'true';
    return c.json(listProjects(includeArchived));
  });

  app.post('/api/projects', async (c) => {
    let body: { title?: string; description?: string; github_repo?: string; pinned?: boolean; docs?: unknown; features?: unknown; data?: unknown };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const title = (body.title ?? '').trim();
    if (!title) return c.json({ error: 'title is required' }, 400);
    const project = createProject({
      title,
      description: body.description?.trim() ?? null,
      github_repo: body.github_repo?.trim() ?? null,
      pinned:      !!body.pinned,
      docs:        body.docs,
      features:    body.features,
      data:        body.data,
    });
    return c.json(project, 201);
  });

  app.patch('/api/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (!getProject(id)) return c.json({ error: 'Project not found' }, 404);
    let body: { title?: string; description?: string | null; github_repo?: string | null; pinned?: boolean; archived?: boolean; docs?: unknown; features?: unknown; data?: unknown };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    updateProject(id, body);
    return c.json(getProject(id));
  });

  app.delete('/api/projects/:id', (c) => {
    const id = c.req.param('id');
    if (!getProject(id)) return c.json({ error: 'Project not found' }, 404);
    if (c.req.query('hard') === '1' || c.req.query('hard') === 'true') {
      const result = deleteProjectHard(id);
      if (!result.ok) return c.json({ error: result.reason ?? 'Cannot delete' }, 400);
      return c.json({ ok: true, hard: true });
    }
    archiveProject(id);
    return c.json({ ok: true, archived: true });
  });

  app.get('/api/projects/:id/tasks', (c) => {
    const projectId = c.req.param('id');
    if (!getProject(projectId)) return c.json({ error: 'Project not found' }, 404);
    const status = c.req.query('status') as TaskStatus | undefined;
    const includeArchived = c.req.query('include_archived') === '1';
    return c.json(getTasks(status, { project_id: projectId, include_archived: includeArchived }));
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

  // ── Heartbeat (manual run + status) ─────────────────────────────────────
  app.post('/api/heartbeat/run', async (c) => {
    try {
      const id = c.req.query('agentId');
      if (id) {
        const agent = getAgentById(id);
        if (!agent) return c.json({ error: 'agent not found' }, 404);
        return c.json(await pingAgent(agent));
      }
      return c.json({ ok: true, results: await runHeartbeats() });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/heartbeat/status', (c) => {
    const rows = getDb().prepare(`
      SELECT id, name, role, provider, status, temporary,
             last_heartbeat_at, heartbeat_status, heartbeat_latency_ms
      FROM agents
      WHERE status = 'active'
      ORDER BY name ASC
    `).all();
    return c.json({
      enabled:     config.heartbeat.enabled,
      intervalSec: config.heartbeat.intervalSec,
      model:       config.heartbeat.model ?? '(per-agent)',
      skipClaudeCli: config.heartbeat.skipClaudeCli,
      agents:      rows,
    });
  });

  // ── Dream Cycle (manual trigger; scheduler runs at DREAM_RUN_TIME) ─────
  app.post('/api/dream/run', async (c) => {
    try {
      const result = await runDreamCycle();
      return c.json(result, result.ok ? 200 : 500);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/dream/status', (c) => {
    const db = getDb();
    const last = db.prepare(`
      SELECT created_at, summary, metadata
      FROM hive_mind
      WHERE action IN ('dream_cycle_start','dream_cycle_complete','dream_cycle_failed')
      ORDER BY created_at DESC LIMIT 20
    `).all();
    return c.json({
      enabled:   config.dream.enabled,
      runTime:   config.dream.runTime,
      lookback:  config.dream.lookbackHours,
      model:     config.dream.model ?? '(extractor / voidai default)',
      events:    last,
    });
  });

  // ── Skills catalog (manual selection, no auto-routing) ─────────────────
  app.get('/api/skills', (c) => {
    if (c.req.query('refresh') === '1') clearSkillCache();
    const full = c.req.query('full') === '1';
    return c.json(listSkills().map(s => ({
      name:        s.name,
      description: s.description,
      triggers:    s.triggers,
      tools:       s.tools,
      scripts:     s.scripts,
      source:      s.source,
      plugin:      s.plugin ?? null,
      path:        s.path,
      always_on:   s.always_on,
      bodyPreview: s.body.slice(0, 200),
      ...(full ? { body: s.body } : {}),
    })));
  });

  app.get('/api/skills/:name', (c) => {
    const name = c.req.param('name');
    const s = getSkill(name);
    if (!s) return c.json({ error: `skill "${name}" not found` }, 404);
    return c.json({
      name:        s.name,
      description: s.description,
      triggers:    s.triggers,
      tools:       s.tools,
      scripts:     s.scripts,
      source:      s.source,
      plugin:      s.plugin ?? null,
      path:        s.path,
      always_on:   s.always_on,
      body:        s.body,
    });
  });

  app.post('/api/skills', async (c) => {
    let body: {
      name?: string; description?: string; body?: string;
      triggers?: string[]; tools?: string[];
      scripts?: Array<{ filename?: string; content?: string }>;
      always_on?: boolean;
    };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.name || !body.name.trim()) return c.json({ error: 'name required' }, 400);
    if (!body.body || !body.body.trim()) return c.json({ error: 'body required' }, 400);
    try {
      const scripts = (body.scripts ?? [])
        .filter(s => s && typeof s.filename === 'string' && typeof s.content === 'string')
        .map(s => ({ filename: s.filename!, content: s.content! }));
      const summary = createSkill({
        name:        body.name,
        description: body.description ?? '',
        body:        body.body,
        triggers:    Array.isArray(body.triggers) ? body.triggers : [],
        tools:       Array.isArray(body.tools)    ? body.tools    : [],
        scripts:     scripts.length > 0 ? scripts : undefined,
        always_on:   body.always_on === true,
      });
      return c.json(summary, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch('/api/skills/:name', async (c) => {
    const name = c.req.param('name');
    let body: { description?: string; body?: string; triggers?: string[]; tools?: string[]; always_on?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    try {
      const summary = updateSkill(name, {
        description: body.description,
        body:        body.body,
        triggers:    Array.isArray(body.triggers) ? body.triggers : undefined,
        tools:       Array.isArray(body.tools)    ? body.tools    : undefined,
        always_on:   typeof body.always_on === 'boolean' ? body.always_on : undefined,
      });
      return c.json(summary);
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  // Dedicated toggle for the dashboard "Always on" button.
  app.post('/api/skills/:name/always-on', async (c) => {
    const name = c.req.param('name');
    let body: { enabled?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400);
    if (!getSkill(name)) return c.json({ error: `skill "${name}" not found` }, 404);
    try {
      const summary = updateSkill(name, { always_on: body.enabled });
      return c.json(summary);
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  app.delete('/api/skills/:name', (c) => {
    try {
      deleteSkill(c.req.param('name'));
      return c.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  // Upload an existing SKILL.md (frontmatter optional) plus optional bundled
  // scripts. Lands the skill at .claude/skills/<name>/. 409 on duplicate name.
  app.post('/api/skills/upload', async (c) => {
    let body: {
      content?:   string;
      name?:      string;
      filename?:  string;
      scripts?:   Array<{ filename?: string; content?: string }>;
      always_on?: boolean;
    };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) return c.json({ error: 'content (the SKILL.md body) is required' }, 400);

    // Minimal frontmatter parser — same grammar as skill-loader.ts:
    //   key: value
    //   key: [a, b, c]      (inline lists only)
    // Strips wrapping quotes. Anything else is ignored.
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    const fields: Record<string, unknown> = {};
    let bodyMd: string;
    if (fmMatch) {
      const yaml = fmMatch[1];
      bodyMd = fmMatch[2];
      for (const line of yaml.split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        let val = line.slice(colon + 1).trim();
        if (!key) continue;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val.startsWith('[') && val.endsWith(']')) {
          const items = val.slice(1, -1).split(',').map(s => s.trim()).map(s => {
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
            return s;
          }).filter(Boolean);
          fields[key] = items;
          continue;
        }
        fields[key] = val;
      }
    } else {
      bodyMd = content;
    }

    // Resolve final name: explicit override > frontmatter > filename basename.
    const explicit = (body.name ?? '').trim();
    const fmName   = typeof fields.name === 'string' ? (fields.name as string).trim() : '';
    const fileBase = (body.filename ?? '').trim().replace(/\.(md|markdown)$/i, '');
    const candidate = explicit || fmName || fileBase;
    if (!candidate) {
      return c.json({ error: 'cannot determine skill name — provide `name`, include `name:` in frontmatter, or pass `filename`' }, 400);
    }

    let safeName: string;
    try { safeName = sanitizeSkillName(candidate); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }

    if (getSkill(safeName)) {
      return c.json({ error: `skill "${safeName}" already exists — delete it first or rename the upload` }, 409);
    }

    const description = typeof fields.description === 'string' ? (fields.description as string) : '';
    const triggers    = Array.isArray(fields.triggers) ? (fields.triggers as unknown[]).map(String) : [];
    const tools       = Array.isArray(fields.tools)    ? (fields.tools    as unknown[]).map(String) : [];
    const scripts = (body.scripts ?? [])
      .filter(s => s && typeof s.filename === 'string' && typeof s.content === 'string')
      .map(s => ({ filename: s.filename!, content: s.content! }));
    // Body field wins; otherwise honor frontmatter `always_on:` (string/number forms also accepted).
    const fmAlwaysOn =
      fields.always_on === true ||
      fields.always_on === 'true' ||
      fields.always_on === 1 ||
      fields.always_on === '1';
    const alwaysOn = typeof body.always_on === 'boolean' ? body.always_on : fmAlwaysOn;

    try {
      const summary = createSkill({
        name:        safeName,
        description,
        body:        bodyMd,
        triggers,
        tools,
        scripts:     scripts.length > 0 ? scripts : undefined,
        always_on:   alwaysOn,
      });
      return c.json(summary, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Install a skill / plugin via the Claude Code CLI or npx. Strict-regex
  // validation on `spec`, no shell, 90s timeout, 64KB output cap each side.
  app.post('/api/skills/install', async (c) => {
    let body: { kind?: string; spec?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const kind = (body.kind ?? '').trim();
    const spec = (body.spec ?? '').trim();
    if (!spec) return c.json({ error: 'spec required' }, 400);

    const PLUGIN_RE      = /^[a-z0-9][a-z0-9._-]{0,80}(@[a-z0-9][a-z0-9._-]{0,80})?$/i;
    const MARKETPLACE_RE = /^[a-z0-9][a-z0-9._-]{0,80}\/[a-z0-9][a-z0-9._-]{0,100}$/i;
    const NPX_RE         = /^[@a-z0-9][@a-z0-9._/-]{0,120}(\s+--[a-z0-9][a-z0-9-]{0,40})*$/i;

    // Resolve a binary even when the dashboard's inherited PATH is missing
    // common user-install dirs (npm-global, ~/.local/bin, etc.). The dashboard
    // is launched by tsx, which prepends node_modules/.bin and may strip the
    // user's login PATH — so `spawn('claude')` ENOENTs even when the binary
    // exists at /root/.local/bin/claude. Walks an env override first, then
    // a list of well-known locations, then falls back to bare name.
    const resolveBinary = (name: string, ...envVars: string[]): string => {
      const home = process.env.HOME || '/root';
      const candidates: string[] = [];
      for (const v of envVars) {
        const val = process.env[v];
        // Only treat values that look like absolute paths as candidates; bare
        // binary names (e.g. CLAUDE_CLI_COMMAND=claude) get appended below as
        // part of the standard bin-dir walk.
        if (val && val.startsWith('/')) candidates.push(val);
      }
      const binName = (envVars.length > 1 && process.env[envVars[1]] && !process.env[envVars[1]]!.startsWith('/'))
        ? process.env[envVars[1]]!
        : name;
      candidates.push(
        path.join(home, '.local/bin', binName),
        path.join(home, '.npm-global/bin', binName),
        '/usr/local/bin/' + binName,
        '/usr/bin/' + binName,
        '/opt/homebrew/bin/' + binName,
      );
      for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch { /* keep walking */ }
      }
      return binName;   // fall back to bare name; spawn will ENOENT clearly
    };

    let bin:  string;
    let argv: string[];
    if (kind === 'plugin') {
      if (!PLUGIN_RE.test(spec)) return c.json({ error: 'plugin spec must match `name[@source]` (lowercase letters/digits/dots/dashes/underscores)' }, 400);
      bin = resolveBinary('claude', 'CLAUDE_CLI_PATH', 'CLAUDE_CLI_COMMAND');
      argv = ['plugin', 'install', spec];
    } else if (kind === 'marketplace') {
      if (!MARKETPLACE_RE.test(spec)) return c.json({ error: 'marketplace spec must match `owner/repo`' }, 400);
      bin = resolveBinary('claude', 'CLAUDE_CLI_PATH', 'CLAUDE_CLI_COMMAND');
      argv = ['plugin', 'marketplace', 'add', spec];
    } else if (kind === 'npx') {
      if (!NPX_RE.test(spec)) return c.json({ error: 'npx spec must be a package name optionally followed by --flag-only args (no flag values, no shell metachars)' }, 400);
      bin = resolveBinary('npx');
      argv = spec.split(/\s+/).filter(Boolean);
    } else {
      return c.json({ error: 'kind must be one of: plugin, marketplace, npx' }, 400);
    }

    const cp = await import('child_process');
    const startedAt = Date.now();
    const MAX_BYTES = 64 * 1024;
    const TIMEOUT_MS = 90_000;

    const result: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; spawnError?: string } = {
      code: null, signal: null, stdout: '', stderr: '',
    };
    let stdoutBytes = 0;
    let stderrBytes = 0;

    try {
      await new Promise<void>((resolve) => {
        let child: ReturnType<typeof cp.spawn>;
        try {
          child = cp.spawn(bin, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          result.spawnError = (err as Error).message;
          resolve();
          return;
        }
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, TIMEOUT_MS);

        child.on('error', (err) => {
          // ENOENT etc.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            const envHint = kind === 'npx' ? '' : '$CLAUDE_CLI_PATH, ';
            result.spawnError = `binary "${bin}" not found — checked ${envHint}~/.local/bin, ~/.npm-global/bin, /usr/local/bin, /usr/bin, /opt/homebrew/bin. ${kind === 'npx' ? 'Install Node.js so npx is on PATH.' : 'Set CLAUDE_CLI_PATH in .env if the binary lives elsewhere.'}`;
          } else {
            result.spawnError = err.message;
          }
          clearTimeout(killTimer);
          resolve();
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdoutBytes >= MAX_BYTES) return;
          const remaining = MAX_BYTES - stdoutBytes;
          const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
          result.stdout += slice.toString('utf-8');
          stdoutBytes += slice.length;
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderrBytes >= MAX_BYTES) return;
          const remaining = MAX_BYTES - stderrBytes;
          const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
          result.stderr += slice.toString('utf-8');
          stderrBytes += slice.length;
        });
        child.on('close', (code, signal) => {
          clearTimeout(killTimer);
          result.code = code;
          result.signal = signal;
          resolve();
        });
      });
    } finally {
      // Always bust the cache so the next /api/skills tick sees any new files.
      clearSkillCache();
    }

    const duration_ms = Date.now() - startedAt;
    const command = [bin, ...argv].join(' ');

    try {
      const { logAudit } = await import('../db');
      logAudit('skill_install_command', 'skill', undefined, {
        kind, spec, exit_code: result.code, duration_ms,
      });
    } catch { /* audit failure is non-fatal */ }

    if (result.spawnError) {
      return c.json({
        ok: false, exit_code: null, stdout: result.stdout, stderr: result.stderr,
        duration_ms, command, error: result.spawnError,
      }, 500);
    }

    return c.json({
      ok: result.code === 0,
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms,
      command,
    });
  });

  // Convert a raw script into a one-script skill. The wrapper body is auto-
  // generated so the LLM knows to call run_skill_script(<name>, <filename>).
  app.post('/api/skills/from-script', async (c) => {
    let body: { name?: string; description?: string; filename?: string; content?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.name || !body.filename || !body.content) {
      return c.json({ error: 'name, filename, and content are required' }, 400);
    }
    try {
      const safeName = sanitizeSkillName(body.name);
      const desc = (body.description ?? '').trim() || `Run ${body.filename}`;
      const md = [
        '## Purpose',
        desc,
        '',
        '## How to use',
        `Call \`run_skill_script(skill_name="${safeName}", script="${body.filename}", args=[...])\` with whatever arguments the script needs.`,
        'Stdout/stderr come back as text — read them, then summarise the result for the user.',
      ].join('\n');
      const summary = createSkill({
        name:        safeName,
        description: desc,
        body:        md,
        triggers:    [],
        tools:       ['run_skill_script'],
        scripts:     [{ filename: body.filename, content: body.content }],
      });
      return c.json(summary, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get('/api/skills/:name/scripts/:filename', (c) => {
    const name = c.req.param('name');
    const filename = c.req.param('filename');
    const s = getSkill(name);
    if (!s) return c.json({ error: `skill "${name}" not found` }, 404);
    if (!s.scripts.includes(filename)) return c.json({ error: `script "${filename}" not in skill` }, 404);
    try {
      const target = path.join(s.dir, 'scripts', filename);
      const content = fs.readFileSync(target, 'utf-8');
      return c.json({ filename, content });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/skills/:name/scripts', async (c) => {
    const name = c.req.param('name');
    let body: { filename?: string; content?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.filename || typeof body.content !== 'string') {
      return c.json({ error: 'filename and content are required' }, 400);
    }
    try {
      const result = writeSkillScript(name, body.filename, body.content);
      return c.json({ ok: true, ...result });
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  app.delete('/api/skills/:name/scripts/:filename', (c) => {
    try {
      deleteSkillScript(c.req.param('name'), c.req.param('filename'));
      return c.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  // ── PARA Map: areas + agent assignment ───────────────────────────────────
  app.get('/api/areas', (c) => c.json(listAreas()));

  app.post('/api/areas', async (c) => {
    let body: { name?: string; icon_glyph?: string; color_token?: string; sort_order?: number };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name required' }, 400);
    const area = createArea(name, { icon_glyph: body.icon_glyph, color_token: body.color_token, sort_order: body.sort_order });
    return c.json(area, 201);
  });

  app.patch('/api/areas/:id', async (c) => {
    const id = c.req.param('id');
    let body: { name?: string; icon_glyph?: string; color_token?: string; sort_order?: number };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    updateArea(id, body);
    return c.json({ ok: true });
  });

  app.delete('/api/areas/:id', (c) => {
    deleteArea(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/agents/:id/area', async (c) => {
    const id = c.req.param('id');
    let body: { area_id?: string | null };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    setAgentArea(id, body.area_id ?? null);
    return c.json({ ok: true });
  });

  // ── Composio (1000+ external app toolkits via hosted MCP) ────────────────
  app.get('/api/composio/status', (c) => {
    return c.json({
      enabled:       config.composio.enabled,
      sessionTtlSec: config.composio.sessionTtlSec,
      apiKeySet:     !!config.composio.apiKey,
    });
  });

  app.get('/api/composio/toolkits', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured (set COMPOSIO_API_KEY)' }, 400);
    try {
      const { listComposioToolkits } = await import('../composio/client');
      const toolkits = await listComposioToolkits();
      return c.json({ ok: true, toolkits });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/composio/connected/:userId', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    try {
      const { listConnectedAccounts } = await import('../composio/client');
      const accounts = await listConnectedAccounts(c.req.param('userId'));
      return c.json({ ok: true, accounts });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // ── Discord bots (multi-bot integration) ─────────────────────────────────
  // Tokens are sensitive — list endpoint masks them; only the create/update
  // endpoints accept the raw token.
  app.get('/api/discord/bots', async (c) => {
    const { listDiscordBots, listDiscordRoutes } = await import('../db');
    const bots = listDiscordBots(true);
    return c.json({
      ok:   true,
      bots: bots.map(b => ({
        ...b,
        token:        b.token ? `${b.token.slice(0, 6)}…${b.token.slice(-4)}` : null,
        routes:       listDiscordRoutes(b.id),
      })),
    });
  });

  app.post('/api/discord/bots', async (c) => {
    const { createDiscordBot, getAgentByName, getAgentById } = await import('../db');
    const { reloadDiscordBots } = await import('../integrations/discord-bot');
    let body: { name?: string; token?: string; default_agent?: string; application_id?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    if (!body.name || !body.token) return c.json({ ok: false, error: 'name and token are required' }, 400);

    let defaultAgentId: string | null = null;
    if (body.default_agent) {
      const a = getAgentById(body.default_agent) ?? getAgentByName(body.default_agent);
      defaultAgentId = a?.id ?? null;
    }

    const row = createDiscordBot({
      name:             body.name.trim(),
      token:            body.token.trim(),
      application_id:   body.application_id?.trim() || null,
      default_agent_id: defaultAgentId,
    });
    reloadDiscordBots().catch(() => { /* fire and forget */ });
    return c.json({ ok: true, bot: { ...row, token: undefined } });
  });

  app.patch('/api/discord/bots/:id', async (c) => {
    const { updateDiscordBot, getAgentByName, getAgentById, getDiscordBot } = await import('../db');
    const { reloadDiscordBots } = await import('../integrations/discord-bot');
    const id = c.req.param('id');
    if (!getDiscordBot(id)) return c.json({ ok: false, error: 'bot not found' }, 404);

    let body: { name?: string; token?: string; default_agent?: string; application_id?: string; enabled?: boolean; auto_reply_guilds?: string[] | null; voice_enabled?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }

    const fields: Parameters<typeof updateDiscordBot>[1] = {};
    if (body.name !== undefined)               fields.name = body.name.trim();
    if (body.token !== undefined)              fields.token = body.token.trim();
    if (body.application_id !== undefined)     fields.application_id = body.application_id?.trim() || null;
    if (body.enabled !== undefined)            fields.enabled = body.enabled;
    if (body.auto_reply_guilds !== undefined)  fields.auto_reply_guilds = body.auto_reply_guilds;
    if (body.voice_enabled !== undefined)      fields.voice_enabled = body.voice_enabled;
    if (body.default_agent !== undefined) {
      const a = body.default_agent ? (getAgentById(body.default_agent) ?? getAgentByName(body.default_agent)) : null;
      fields.default_agent_id = a?.id ?? null;
    }
    updateDiscordBot(id, fields);
    reloadDiscordBots().catch(() => { /* fire and forget */ });
    return c.json({ ok: true });
  });

  // Live list of guilds (servers) the bot is currently a member of. Returns
  // 404 when the bot isn't running (no gateway connection to query). Used by
  // the dashboard's "Auto-reply servers" picker.
  app.get('/api/discord/bots/:id/guilds', async (c) => {
    const { getDiscordBot, parseAutoReplyGuilds } = await import('../db');
    const { listBotGuilds } = await import('../integrations/discord-bot');
    const id = c.req.param('id');
    const bot = getDiscordBot(id);
    if (!bot) return c.json({ ok: false, error: 'bot not found' }, 404);
    const guilds = listBotGuilds(id);
    if (guilds === null) return c.json({ ok: false, error: 'bot is not connected to the Discord gateway right now' }, 503);
    const enabled = new Set(parseAutoReplyGuilds(bot.auto_reply_guilds));
    return c.json({
      ok:     true,
      guilds: guilds.map(g => ({ ...g, auto_reply: enabled.has(g.id) })),
    });
  });

  app.delete('/api/discord/bots/:id', async (c) => {
    const { deleteDiscordBot } = await import('../db');
    const { reloadDiscordBots } = await import('../integrations/discord-bot');
    deleteDiscordBot(c.req.param('id'));
    reloadDiscordBots().catch(() => { /* fire and forget */ });
    return c.json({ ok: true });
  });

  app.post('/api/discord/bots/:id/routes', async (c) => {
    const { upsertDiscordRoute, getAgentByName, getAgentById, getDiscordBot } = await import('../db');
    const { reloadDiscordBots } = await import('../integrations/discord-bot');
    const id = c.req.param('id');
    if (!getDiscordBot(id)) return c.json({ ok: false, error: 'bot not found' }, 404);
    let body: { channel_id?: string; agent?: string; require_mention?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    if (!body.channel_id || !body.agent) return c.json({ ok: false, error: 'channel_id and agent are required' }, 400);
    const agent = getAgentById(body.agent) ?? getAgentByName(body.agent);
    if (!agent) return c.json({ ok: false, error: `agent "${body.agent}" not found` }, 404);
    const route = upsertDiscordRoute(id, body.channel_id.trim(), agent.id, body.require_mention);
    reloadDiscordBots().catch(() => { /* fire and forget */ });
    return c.json({ ok: true, route });
  });

  app.patch('/api/discord/routes/:id', async (c) => {
    const { setDiscordRouteRequireMention } = await import('../db');
    const { reloadDiscordBots } = await import('../integrations/discord-bot');
    let body: { require_mention?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    if (typeof body.require_mention !== 'boolean') return c.json({ ok: false, error: 'require_mention must be a boolean' }, 400);
    setDiscordRouteRequireMention(c.req.param('id'), body.require_mention);
    reloadDiscordBots().catch(() => { /* fire and forget */ });
    return c.json({ ok: true });
  });

  app.delete('/api/discord/routes/:id', async (c) => {
    const { deleteDiscordRoute } = await import('../db');
    const { reloadDiscordBots } = await import('../integrations/discord-bot');
    deleteDiscordRoute(c.req.param('id'));
    reloadDiscordBots().catch(() => { /* fire and forget */ });
    return c.json({ ok: true });
  });

  // ── MCP server registry (v1.9) ───────────────────────────────────────────
  // User-managed remote MCP servers. Probes happen in the background; the
  // dashboard polls /api/mcp/servers for the latest status.
  app.get('/api/mcp/servers', async (c) => {
    const { listMcpServers, parseMcpToolsCache } = await import('../db');
    const rows = listMcpServers(true);
    return c.json({
      ok:      true,
      servers: rows.map(r => ({
        id:             r.id,
        name:           r.name,
        url:            r.url,
        transport:      r.transport,
        enabled:        !!r.enabled,
        status:         r.status,
        status_detail:  r.status_detail,
        tools_count:    r.tools_count,
        last_probed_at: r.last_probed_at,
        created_at:     r.created_at,
        updated_at:     r.updated_at,
        has_headers:    !!r.headers,
        tools:          parseMcpToolsCache(r.tools_cached).map(t => ({ name: t.name, description: t.description })),
      })),
    });
  });

  app.post('/api/mcp/servers', async (c) => {
    const { createMcpServer, getMcpServerByName, sanitizeMcpServerName } = await import('../db');
    const { probeServer } = await import('../mcp/mcp-registry');
    let body: { name?: string; url?: string; transport?: 'auto' | 'http' | 'sse'; headers?: Record<string, string>; enabled?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    if (!body.name || !body.url) return c.json({ ok: false, error: 'name and url are required' }, 400);
    try { new URL(body.url); } catch { return c.json({ ok: false, error: 'url is not a valid URL' }, 400); }
    if (getMcpServerByName(sanitizeMcpServerName(body.name))) {
      return c.json({ ok: false, error: `an MCP server named "${sanitizeMcpServerName(body.name)}" already exists` }, 409);
    }
    const headers = body.headers && typeof body.headers === 'object' ? body.headers : null;
    const row = createMcpServer({ name: body.name, url: body.url, transport: body.transport, headers, enabled: body.enabled !== false });
    probeServer(row.id).catch(() => { /* best-effort */ });
    return c.json({ ok: true, server: { ...row, headers: undefined } });
  });

  app.patch('/api/mcp/servers/:id', async (c) => {
    const { updateMcpServer, getMcpServer, getMcpServerByName, sanitizeMcpServerName } = await import('../db');
    const { probeServer } = await import('../mcp/mcp-registry');
    const id = c.req.param('id');
    const existing = getMcpServer(id);
    if (!existing) return c.json({ ok: false, error: 'server not found' }, 404);
    let body: { name?: string; url?: string; transport?: 'auto' | 'http' | 'sse'; headers?: Record<string, string> | null; enabled?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }

    if (body.url !== undefined) {
      try { new URL(body.url); } catch { return c.json({ ok: false, error: 'url is not a valid URL' }, 400); }
    }
    if (body.name !== undefined) {
      const sanitized = sanitizeMcpServerName(body.name);
      const conflict = getMcpServerByName(sanitized);
      if (conflict && conflict.id !== id) return c.json({ ok: false, error: `name "${sanitized}" already in use` }, 409);
    }

    const fields: Parameters<typeof updateMcpServer>[1] = {};
    if (body.name      !== undefined) fields.name      = body.name;
    if (body.url       !== undefined) fields.url       = body.url;
    if (body.transport !== undefined) fields.transport = body.transport;
    if (body.headers   !== undefined) fields.headers   = body.headers;
    if (body.enabled   !== undefined) fields.enabled   = body.enabled;

    const reprobe = body.url !== undefined || body.headers !== undefined || body.transport !== undefined || body.enabled === true;
    updateMcpServer(id, fields);
    if (reprobe) probeServer(id).catch(() => { /* best-effort */ });
    return c.json({ ok: true, server: getMcpServer(id) });
  });

  app.delete('/api/mcp/servers/:id', async (c) => {
    const { deleteMcpServer, getMcpServer } = await import('../db');
    const id = c.req.param('id');
    if (!getMcpServer(id)) return c.json({ ok: false, error: 'server not found' }, 404);
    deleteMcpServer(id);
    return c.json({ ok: true });
  });

  app.post('/api/mcp/servers/:id/probe', async (c) => {
    const { getMcpServer, parseMcpToolsCache } = await import('../db');
    const { probeServer } = await import('../mcp/mcp-registry');
    const id = c.req.param('id');
    if (!getMcpServer(id)) return c.json({ ok: false, error: 'server not found' }, 404);
    const result = await probeServer(id);
    const row = getMcpServer(id);
    return c.json({
      ok:      result.ok,
      status:  result.status,
      detail:  result.detail,
      server:  row,
      tools:   row ? parseMcpToolsCache(row.tools_cached) : [],
    });
  });

  app.get('/api/mcp/servers/:id/tools', async (c) => {
    const { getMcpServer, parseMcpToolsCache } = await import('../db');
    const id = c.req.param('id');
    const row = getMcpServer(id);
    if (!row) return c.json({ ok: false, error: 'server not found' }, 404);
    return c.json({
      ok:             true,
      server_id:      row.id,
      server_name:    row.name,
      status:         row.status,
      last_probed_at: row.last_probed_at,
      tools:          parseMcpToolsCache(row.tools_cached),
    });
  });

  // ── NeuroVault file browser ──────────────────────────────────────────────
  app.get('/api/vault/tree', async (c) => {
    try {
      const raw = await vaultGetTree(c.req.query('vault'));
      // The MCP returns either { items: [{full_path, parent_path, filename}] }
      // or { ok, data: { items: [...] } } depending on wrapping. Normalize.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = collectTreeItems(raw as any);
      return c.json({ ok: true, items, tree: buildTree(items) });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/vault/file', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'path is required' }, 400);
    try {
      const content = await vaultReadNote({ note_id: filePath, vault: c.req.query('vault') });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = typeof content === 'string' ? content : (extractContentText(content as any) ?? JSON.stringify(content, null, 2));
      return c.json({ ok: true, path: filePath, content: text });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/vault/collections', async (c) => {
    try {
      const r = await vaultListCollections(c.req.query('vault'));
      return c.json({ ok: true, collections: r });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/vault/files', async (c) => {
    try {
      const r = await vaultListFiles(c.req.query('vault'));
      return c.json({ ok: true, files: r });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
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
    let body: {
      message?:     string;
      sessionId?:   string;
      agentId?:     string;
      attachments?: Array<{ url: string; mime_type?: string; name?: string }>;
      // Optional Discord turn context — present when the request originates
      // from the Discord bot so the agent can react / reply with real ids.
      discord?: {
        bot_id:       string;
        bot_name:     string;
        channel_id:   string;
        guild_id:     string | null;
        message_id:   string;
        author_id:    string;
        author_name:  string;
        voice_reply_enabled?: boolean;
      };
    };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

    const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter(a => a && typeof a.url === 'string')
      : [];
    if (!rawMessage && attachments.length === 0) return c.json({ error: 'message or attachments required' }, 400);

    const resolved = await resolveAgent(rawMessage || '(image)', body.agentId);
    const { agent } = resolved;
    let { message } = resolved;
    const sessionId    = body.sessionId ?? createSession(agent.id, 'Dashboard Chat');
    const systemPrompt = agent.system_prompt ?? 'You are a helpful AI assistant.';

    // Discord turn context goes in `extraSystemContext`, NOT systemPrompt.
    // The chat stream functions overwrite systemPrompt with the agent's own
    // stored prompt on every turn (so live edits to the prompt take effect),
    // which would erase any per-turn additions. Instead we thread the
    // Discord block through a separate parameter that's appended last,
    // after team section + skills + memory blocks, so it always wins.
    let extraSystemContext: string | undefined;
    if (body.discord) {
      const d = body.discord;
      extraSystemContext = `

---
You are currently responding via the Discord bot integration "${d.bot_name}". Use these ids when calling Discord tools (discord_react, etc.) — do NOT ask the user for them:
  - bot_id:     ${d.bot_id}
  - channel_id: ${d.channel_id}
  - message_id: ${d.message_id}   (the user's most recent message in this thread)
  - guild_id:   ${d.guild_id ?? '(direct message)'}
  - author:     ${d.author_name} (id: ${d.author_id})
When the user says "react to my message" or similar, call discord_react with the bot_id + channel_id + message_id above. Your text reply is automatically posted back to the same channel — you don't need a separate tool to send it.${d.voice_reply_enabled ? `

Voice output: your text reply WILL be automatically synthesized to speech and attached to this Discord message as an .mp3 (the user hears you AND reads you). You DO have voice output here — do not say you're text-only or that you can't speak. Write naturally; punctuation and short sentences sound better when spoken. Avoid long code blocks, ASCII tables, or markdown that doesn't translate to audio.

If the user asks you to stop sending audio (or to start again), call \`discord_set_user_voice(bot_id="${d.bot_id}", user_id="${d.author_id}", enabled=false|true, reason="…")\` so the preference sticks for future replies. Don't argue — honor the request immediately.` : `

Voice output is NOT enabled for this turn — you only have a text channel back to the user. If the user asks you to start sending audio replies, call \`discord_set_user_voice(bot_id="${d.bot_id}", user_id="${d.author_id}", enabled=true)\`. (This still requires the bot's voice toggle and your TTS to be on globally; if either is off, audio_configure_discord_bot / audio_configure_agent are the right tools.)`}`;
    }

    // Vision routing — decide once, before chatStream, what to do with the images:
    //   'preprocess' → describe via VISION_MODEL and inline the descriptions into
    //                  the user message (universal fallback that works for every provider).
    //   'native'     → pass attachments through to chatStream so the agent's own
    //                  multi-modal LLM sees the image directly (OpenAI/VoidAI path).
    let nativeAttachments: typeof attachments = [];
    if (attachments.length > 0) {
      const { resolveVisionMode, describeImages } = await import('../vision/vision-service');
      const mode = resolveVisionMode(agent);
      if (mode === 'preprocess') {
        try {
          // Forward the user's question into the describer so it knows what to
          // focus on (e.g. "what does it say?" → describer prioritizes text).
          const descriptions = await describeImages(attachments, { userPrompt: rawMessage });
          const block = descriptions
            .map((d, i) => `[Image ${i + 1}${attachments[i].name ? ` "${attachments[i].name}"` : ''}: ${d}]`)
            .join('\n');
          message = (rawMessage ? `${block}\n\n${rawMessage}` : block).trim();
        } catch (err) {
          // Don't fail the chat — agent at least sees that an image came in.
          message = `[image attached but description failed: ${(err as Error).message.slice(0, 120)}]\n\n${rawMessage}`;
        }
      } else {
        // Native: pass through to chatStream verbatim.
        nativeAttachments = attachments;
      }
    }

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
          }, systemPrompt, agent.id, onMeta, nativeAttachments, extraSystemContext);
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

  // ── Audio: TTS + transcription ──────────────────────────────────────────
  // Surfaces: dashboard chat (mic + speaker buttons) and Discord bot inbound/outbound.
  // Token gating is shared with all other /api routes via the dashboard server middleware.

  app.get('/api/audio/voices', async (c) => {
    const provider = c.req.query('provider');
    if (provider === 'voidai') return c.json({ voices: listVoidAIVoices() });
    if (provider === 'elevenlabs') {
      try {
        const voices = await listElevenLabsVoices();
        return c.json({ voices, available: config.audio.elevenlabs.enabled });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    }
    try {
      const all = await listAllVoices();
      return c.json(all);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.post('/api/audio/transcribe', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    if (!ct.includes('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data with a "file" field' }, 400);
    }
    let form: FormData;
    try { form = await c.req.formData(); }
    catch { return c.json({ error: 'invalid form data' }, 400); }
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'missing "file"' }, 400);

    const maxBytes = config.audio.maxFileMb * 1024 * 1024;
    if (file.size > maxBytes) return c.json({ error: `file exceeds ${config.audio.maxFileMb} MB` }, 413);

    const language = (form.get('language') as string | null)?.trim() || undefined;
    const prompt   = (form.get('prompt')   as string | null)?.trim() || undefined;

    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const result = await transcribe({
        audio:    buf,
        mimeType: file.type || 'audio/webm',
        filename: file.name,
        language,
        prompt,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.post('/api/audio/speak', async (c) => {
    let body: { text?: string; agentId?: string; provider?: string; voice?: string; format?: 'mp3' | 'wav' | 'opus' };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'invalid JSON' }, 400); }
    const text = (body.text ?? '').trim();
    if (!text) return c.json({ error: 'text is required' }, 400);

    // Resolve voice config: explicit body fields > agent's stored config > env defaults.
    let provider: 'voidai' | 'elevenlabs' = body.provider === 'elevenlabs' ? 'elevenlabs' : 'voidai';
    let voiceId = body.voice?.trim() || '';
    if (body.agentId) {
      const agent = getAgentById(body.agentId);
      if (!agent) return c.json({ error: 'agent not found' }, 404);
      const resolved = resolveAgentVoice(agent);
      if (!body.provider) provider = resolved.provider;
      if (!voiceId)        voiceId = resolved.voiceId;
    }

    try {
      const out = await synthesize({
        text,
        provider,
        voiceId: voiceId || undefined,
        format:  body.format ?? 'mp3',
      });
      return new Response(new Uint8Array(out.buffer), {
        status: 200,
        headers: {
          'Content-Type':   out.mimeType,
          'Content-Length': String(out.buffer.length),
          'Cache-Control':  'no-store',
          'X-Voice-Id':     out.voiceId,
          'X-Tts-Provider': out.provider,
        },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });
}
