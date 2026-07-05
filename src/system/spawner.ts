import { randomUUID } from 'crypto';
import { getDb, getAgentById, logAudit, getSpawnConfig, type AgentRecord } from '../db';
import { config } from '../config';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';
import { pickModel, pickModelAsync } from './model-triage';

// ── In-flight spawn deduplication ───────────────────────────────────────────
// Prevents duplicate spawns when the same request comes in rapidly before the
// first one commits to the database.
const inFlightSpawns = new Set<string>();
const SPAWN_KEY_TTL_MS = 5000; // auto-cleanup after 5 seconds

function getSpawnKey(req: SpawnRequest): string {
  return `${req.parentAgentId}:${req.name}:${req.role}`;
}

function markSpawnInFlight(key: string): boolean {
  if (inFlightSpawns.has(key)) return false; // already in progress
  inFlightSpawns.add(key);
  // Auto-cleanup in case something goes wrong
  setTimeout(() => inFlightSpawns.delete(key), SPAWN_KEY_TTL_MS);
  return true;
}

function clearSpawnInFlight(key: string): void {
  inFlightSpawns.delete(key);
}

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
  const spawnKey = getSpawnKey(req);
  
  // Check for duplicate in-flight spawn
  if (!markSpawnInFlight(spawnKey)) {
    logger.warn('spawner: duplicate spawn blocked', { name: req.name, parentAgentId: req.parentAgentId });
    return { ok: false, reason: 'Duplicate spawn request in progress' };
  }

  const rtCfg = getSpawnConfig();

  if (!rtCfg.enabled) {
    clearSpawnInFlight(spawnKey);
    return { ok: false, reason: 'Agent spawning is disabled' };
  }

  const parent = getAgentById(req.parentAgentId);
  if (!parent) {
    clearSpawnInFlight(spawnKey);
    return { ok: false, reason: 'Parent agent not found' };
  }
  if (parent.status !== 'active') {
    clearSpawnInFlight(spawnKey);
    return { ok: false, reason: 'Parent agent is not active' };
  }

  const spawnDepth = (parent.spawn_depth ?? 0) + 1;
  if (spawnDepth > rtCfg.maxDepth) {
    clearSpawnInFlight(spawnKey);
    const reason = `Spawn depth limit reached (depth ${spawnDepth} > ${rtCfg.maxDepth})`;
    logHive('spawn_denied', `spawner: ${reason}`, req.parentAgentId, { name: req.name, spawnDepth });
    return { ok: false, reason };
  }

  const activeCount = countActiveTempAgents();
  if (activeCount >= rtCfg.hardLimit) {
    clearSpawnInFlight(spawnKey);
    const reason = `Hard limit: ${activeCount}/${rtCfg.hardLimit} temporary agents already active`;
    logHive('spawn_denied', `spawner: ${reason}`, req.parentAgentId, { name: req.name, activeCount });
    logger.warn('spawner: hard limit reached', { activeCount });
    return { ok: false, reason };
  }

  if (activeCount >= rtCfg.softLimit) {
    logger.warn('spawner: soft limit reached', { activeCount, softLimit: rtCfg.softLimit });
    logHive('spawn_request', `spawner: Soft limit warning: ${activeCount}/${rtCfg.softLimit} temp agents active`, req.parentAgentId);
  }

  const expiresAt = new Date(Date.now() + rtCfg.ttlHours * 3_600_000).toISOString();

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
  // Global cross-provider triage for tiered spawns: the task difficulty drives
  // model selection from the full pool (voidai + anthropic + ollama) rather than
  // being locked to the parent agent's provider.
  const useGlobalTriage = tierForSpawn !== 'pinned';
  const triageOpts = {
    text:        triageText,
    provider:    useGlobalTriage ? undefined : (parent.provider ?? 'voidai'),
    agentTier:   tierForSpawn,
    pinnedModel: parent.model ?? config.voidai.model,
    spawnDepth,
    agentId:     req.parentAgentId,
    global:      useGlobalTriage,
  };

  if (asyncPick) {
    return (async () => {
      try {
        const triage = await pickModelAsync(triageOpts);
        return finalizeSpawn(req, parent, spawnDepth, expiresAt, augmentedPrompt, tierForSpawn, triage, spawnKey);
      } catch (err) {
        clearSpawnInFlight(spawnKey);
        throw err;
      }
    })();
  }
  const triage = pickModel(triageOpts);
  return finalizeSpawn(req, parent, spawnDepth, expiresAt, augmentedPrompt, tierForSpawn, triage, spawnKey);
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
  spawnKey: string,
): SpawnResult {
  try {
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
      triage.resolvedProvider ?? parent.provider ?? 'voidai',
      tierForSpawn,
    );

    if (triage.depthPenalty) {
      logger.info('spawner: cascade-depth penalty applied', triage.depthPenalty);
    }
    logAudit('agent_spawned', 'agent', id, {
      name: req.name, parentAgentId: req.parentAgentId, expiresAt,
      chosenModel, tierForSpawn,
      triageScore: triage.decision?.score, triageTier: triage.decision?.tier,
      depthPenalty: triage.depthPenalty, spawnDepth,
    });
    logHive('spawn_success', `spawner: ${parent.name} spawned temporary agent "${req.name}" (depth ${spawnDepth}, expires ${new Date(expiresAt).toLocaleString()})`, req.parentAgentId, { agentId: id, name: req.name, expiresAt, spawnDepth });
    logger.info('spawner: agent spawned', { name: req.name, id, parentAgentId: req.parentAgentId, expiresAt });

    return {
      ok:    true,
      agent: getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRecord,
    };
  } finally {
    clearSpawnInFlight(spawnKey);
  }
}

