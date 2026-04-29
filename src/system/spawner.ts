import { randomUUID } from 'crypto';
import { getDb, getAgentById, logAudit, type AgentRecord } from '../db';
import { config } from '../config';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

export interface SpawnRequest {
  name:            string;
  role:            string;
  description:     string;
  capabilities:    string[];
  systemPrompt:    string;
  parentAgentId:   string;
  taskDescription?: string;
}

export interface SpawnResult {
  ok:     boolean;
  agent?: AgentRecord;
  reason?: string;
}

export function countActiveTempAgents(): number {
  return (getDb()
    .prepare("SELECT COUNT(*) as n FROM agents WHERE temporary = 1 AND status = 'active'")
    .get() as { n: number }).n;
}

const MAX_SPAWN_DEPTH = 3;

export function spawnAgent(req: SpawnRequest): SpawnResult {
  if (!config.spawning.enabled) {
    return { ok: false, reason: 'Agent spawning is disabled (SPAWN_AGENTS_ENABLED=false)' };
  }

  const parent = getAgentById(req.parentAgentId);
  if (!parent)                      return { ok: false, reason: 'Parent agent not found' };
  if (parent.status !== 'active')   return { ok: false, reason: 'Parent agent is not active' };

  const spawnDepth = (parent.spawn_depth ?? 0) + 1;
  if (spawnDepth > MAX_SPAWN_DEPTH) {
    const reason = `Spawn depth limit reached (depth ${spawnDepth} > ${MAX_SPAWN_DEPTH})`;
    logHive('spawn_denied', reason, req.parentAgentId, { name: req.name, spawnDepth });
    return { ok: false, reason };
  }

  const activeCount = countActiveTempAgents();
  if (activeCount >= config.spawning.hardLimit) {
    const reason = `Hard limit: ${activeCount}/${config.spawning.hardLimit} temporary agents already active`;
    logHive('spawn_denied', reason, req.parentAgentId, { name: req.name, activeCount });
    logger.warn('Spawner: hard limit reached', { activeCount });
    return { ok: false, reason };
  }

  if (activeCount >= config.spawning.softLimit) {
    logger.warn('Spawner: soft limit reached', { activeCount, softLimit: config.spawning.softLimit });
    logHive('spawn_request', `Soft limit warning: ${activeCount}/${config.spawning.softLimit} temp agents active`, req.parentAgentId);
  }

  const expiresAt = new Date(Date.now() + config.spawning.ttlHours * 3_600_000).toISOString();

  const augmentedPrompt =
    req.systemPrompt +
    `\n\nYou are a temporary agent created by ${parent.name}.` +
    `\nYou will expire at ${expiresAt}. Complete your task efficiently.` +
    `\nPrefer delegation over further spawning. Do NOT spawn agents unnecessarily.`;

  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO agents
      (id, name, description, system_prompt, model, role, capabilities,
       status, temporary, spawn_depth, parent_agent_id, created_by_agent_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)
  `).run(
    id,
    req.name,
    req.description,
    augmentedPrompt,
    parent.model ?? config.voidai.model,
    req.role,
    JSON.stringify(req.capabilities ?? []),
    spawnDepth,
    req.parentAgentId,
    req.parentAgentId,
    expiresAt,
  );

  logAudit('agent_spawned', 'agent', id, { name: req.name, parentAgentId: req.parentAgentId, expiresAt });
  logHive(
    'spawn_success',
    `${parent.name} spawned temporary agent "${req.name}" (depth ${spawnDepth}, expires ${new Date(expiresAt).toLocaleString()})`,
    req.parentAgentId,
    { agentId: id, name: req.name, expiresAt, spawnDepth },
  );
  logger.info('Agent spawned', { name: req.name, id, parentAgentId: req.parentAgentId, expiresAt });

  return {
    ok:    true,
    agent: getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRecord,
  };
}

