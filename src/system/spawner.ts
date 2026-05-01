import { randomUUID } from 'crypto';
import { getDb, getAgentById, logAudit, type AgentRecord } from '../db';
import { config } from '../config';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { pickModel, pickModelAsync } from './model-triage';

export interface SpawnRequest {
  name:            string;
  role:            string;
  description:     string;
  capabilities:    string[];
  systemPrompt:    string;
  parentAgentId:   string;
  taskDescription?: string;
  model?:          string;     // optional override; otherwise triaged
  modelTier?:      string;     // optional override; otherwise inherits parent or 'auto'
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

/**
 * Async variant — runs the full triage pipeline including borderline LLM
 * escalation, cascade-depth penalty, and budget guard. Prefer this from
 * orchestrators that can afford the extra cheap classifier round-trip.
 */
export async function spawnAgentAsync(req: SpawnRequest): Promise<SpawnResult> {
  return spawnAgentInternal(req, true);
}

export function spawnAgent(req: SpawnRequest): SpawnResult {
  // Sync path — no LLM escalation. Used from existing call sites that don't await.
  return spawnAgentInternal(req, false) as SpawnResult;
}

function spawnAgentInternal(req: SpawnRequest, asyncPick: boolean): SpawnResult | Promise<SpawnResult> {
  if (asyncPick) return runSpawn(req, true);
  return runSpawn(req, false) as SpawnResult;
}

function runSpawn(req: SpawnRequest, asyncPick: false): SpawnResult;
function runSpawn(req: SpawnRequest, asyncPick: true):  Promise<SpawnResult>;
function runSpawn(req: SpawnRequest, asyncPick: boolean): SpawnResult | Promise<SpawnResult> {
  return runSpawnImpl(req, asyncPick);
}

function runSpawnImpl(req: SpawnRequest, asyncPick: boolean): SpawnResult | Promise<SpawnResult> {
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

  // Decide the spawned agent's model. Precedence:
  //   1. explicit req.model
  //   2. triage on the task description if a tier is implied (auto / req.modelTier)
  //   3. inherit parent's model
  const triageText = req.taskDescription ?? req.description ?? '';
  const tierForSpawn = req.modelTier ?? 'auto';
  const triageOpts = {
    text:        triageText,
    provider:    parent.provider ?? 'voidai',
    agentTier:   tierForSpawn,
    pinnedModel: parent.model ?? config.voidai.model,
    spawnDepth,
    agentId:     req.parentAgentId,
  };

  if (asyncPick) {
    return (async () => {
      const triage = await pickModelAsync(triageOpts);
      return finalizeSpawn(req, parent, spawnDepth, expiresAt, augmentedPrompt, tierForSpawn, triage);
    })();
  }
  const triage = pickModel(triageOpts);
  return finalizeSpawn(req, parent, spawnDepth, expiresAt, augmentedPrompt, tierForSpawn, triage);
}

function finalizeSpawn(
  req: SpawnRequest,
  parent: AgentRecord,
  spawnDepth: number,
  expiresAt: string,
  augmentedPrompt: string,
  tierForSpawn: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  triage: any,
): SpawnResult {
  const chosenModel =
    req.model
    ?? (tierForSpawn !== 'pinned' ? triage.model : null)
    ?? parent.model
    ?? config.voidai.model;

  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO agents
      (id, name, description, system_prompt, model, role, capabilities,
       status, temporary, spawn_depth, parent_agent_id, created_by_agent_id, expires_at,
       provider, model_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.name,
    req.description,
    augmentedPrompt,
    chosenModel,
    req.role,
    JSON.stringify(req.capabilities ?? []),
    spawnDepth,
    req.parentAgentId,
    req.parentAgentId,
    expiresAt,
    parent.provider ?? 'openai',
    tierForSpawn,
  );

  if (triage.depthPenalty) {
    logger.info('Spawner: cascade-depth penalty applied', triage.depthPenalty);
  }
  logAudit('agent_spawned', 'agent', id, {
    name: req.name, parentAgentId: req.parentAgentId, expiresAt,
    chosenModel, tierForSpawn,
    triageScore: triage.decision?.score, triageTier: triage.decision?.tier,
    depthPenalty: triage.depthPenalty, spawnDepth,
  });
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

