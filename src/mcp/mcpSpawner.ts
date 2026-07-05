/**
 * mcp/mcpSpawner.ts — supervisor-pattern MCP launcher (spec v3 §7).
 *
 * Workflow:
 *   1. Caller invokes `spawnMcp({ entrypoint, manifestPath?, command? })`.
 *   2. Spawner loads `<mcp>.secrets.yaml` (next to entrypoint by default).
 *   3. Mints a fresh `nc-supervisor` HMAC token (30s TTL, one per spawn).
 *   4. POSTs to /api/broker/agent/inject with the secret-name list.
 *   5. Broker returns `{ env: {...} }`.
 *   6. Spawner launches the child with `env: { ...process.env, ...injected }`.
 *      NC_AGENT_TOKEN is NOT passed to the child — supervisor is the sole
 *      identity broker talks to.
 *   7. The live MCP is tracked in `liveMcps`; rotation events look up the
 *      child here and apply the manifest's strategy.
 *
 * Process-local — doesn't manage MCPs across reboots.
 */
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { EventEmitter } from 'events';
import { mintAgentToken } from '../broker/agentToken';
import { initBrokerHmacKey, handleSecretRotation } from '../broker/bootstrap';
import {
  loadManifest, findManifestForEntrypoint,
  type McpSecretManifest,
} from './secretManifest';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';

const SUPERVISOR_IDENTITY = 'nc-supervisor';

interface LiveMcp {
  mcp: string;
  child: ChildProcess;
  manifest: McpSecretManifest;
  spec: SpawnSpec;
  startedAt: string;
}

const liveMcps = new Map<string, LiveMcp>();

export const mcpSpawnerEvents = new EventEmitter();

export interface SpawnSpec {
  name?: string;
  entrypoint: string;
  manifestPath?: string;
  command?: string[];
  cwd?: string;
  extraEnv?: Record<string, string>;
}

function dashboardAuthHeaders(): Record<string, string> {
  return { 'x-dashboard-token': config.dashboard.token };
}

async function fetchInjectedEnv(targetMcp: string, secrets: string[]): Promise<Record<string, string>> {
  if (secrets.length === 0) return {};

  initBrokerHmacKey();
  const token = mintAgentToken(SUPERVISOR_IDENTITY, randomUUID());

  const url = `http://127.0.0.1:${config.dashboard.port}/api/broker/agent/inject`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...dashboardAuthHeaders(),
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ target_mcp: targetMcp, secrets }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`broker inject failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as { env?: Record<string, string>; error?: string; failed?: string[] };
  if (body.error) {
    throw new Error(`broker inject error: ${body.error}${body.failed ? ` (missing: ${body.failed.join(',')})` : ''}`);
  }
  return body.env ?? {};
}

export async function spawnMcp(spec: SpawnSpec): Promise<LiveMcp> {
  const entrypointAbs = path.resolve(spec.entrypoint);
  const manifestPath = spec.manifestPath ?? findManifestForEntrypoint(entrypointAbs);
  if (!manifestPath) {
    throw new Error(`mcp-spawn: no manifest found for ${entrypointAbs} (looked for *.secrets.yaml)`);
  }
  const manifest = loadManifest(manifestPath);
  const mcpName = spec.name ?? manifest.mcp;

  if (liveMcps.has(mcpName)) {
    throw new Error(`mcp-spawn: an MCP named ${mcpName} is already running`);
  }

  const injected = await fetchInjectedEnv(mcpName, manifest.secrets);

  const cmd = spec.command ?? [process.execPath, entrypointAbs];
  if (cmd.length === 0) throw new Error('mcp-spawn: command must have at least one arg');

  const cwd = spec.cwd ?? path.dirname(entrypointAbs);

  // Build a clean child env: scrub broker/dashboard internals then layer on
  // operator-supplied extraEnv and broker-resolved secrets. NC_AGENT_TOKEN is
  // the supervisor's identity token — MCPs must not inherit it.
  const MCP_SCRUB_KEYS = [
    'NC_BROKER_HMAC_KEY', 'NC_AGENT_TOKEN',
    'DASHBOARD_TOKEN', 'VOIDAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
    'LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY',
    'NC_BROKER_INFISICAL_CLIENT_SECRET', 'NC_BROKER_INFISICAL_CLIENT_ID',
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of MCP_SCRUB_KEYS) delete env[k];
  Object.assign(env, spec.extraEnv ?? {}, injected);

  const child = spawn(cmd[0], cmd.slice(1), {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });

  const record: LiveMcp = {
    mcp: mcpName, child, manifest, spec, startedAt: new Date().toISOString(),
  };
  liveMcps.set(mcpName, record);

  child.on('exit', (code, signal) => {
    liveMcps.delete(mcpName);
    logger.info('mcp-spawn: child exited', { mcp: mcpName, code, signal });
    mcpSpawnerEvents.emit('exit', { mcp: mcpName, code, signal });
  });
  child.on('error', (err) => {
    logger.error('mcp-spawn: child errored', { mcp: mcpName, err: err.message });
  });

  logHive(
    'mcp_spawned',
    `mcp-spawn: ${mcpName} started (pid ${child.pid}, ${manifest.secrets.length} secrets injected)`,
    undefined,
    { mcp: mcpName, pid: child.pid, secrets_count: manifest.secrets.length, rotation: manifest.rotation.strategy },
  );
  mcpSpawnerEvents.emit('spawned', { mcp: mcpName, pid: child.pid });
  return record;
}

export function listLiveMcps(): Array<{
  mcp: string;
  pid: number | undefined;
  startedAt: string;
  secrets: string[];
  rotation: string;
}> {
  return [...liveMcps.values()].map((r) => ({
    mcp: r.mcp,
    pid: r.child.pid,
    startedAt: r.startedAt,
    secrets: r.manifest.secrets,
    rotation: r.manifest.rotation.strategy,
  }));
}

export async function stopMcp(name: string): Promise<void> {
  const rec = liveMcps.get(name);
  if (!rec) return;
  rec.child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      try { rec.child.kill('SIGKILL'); } catch { /* gone */ }
      resolve();
    }, 5000);
    rec.child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
}

export async function notifyRotation(rotatedSecret: string): Promise<void> {
  // Re-inject known env-var-backed secrets (Kimi, Venice, VoidAI bg, etc.)
  // before handling MCP subprocess restarts. The lazy API clients detect the
  // updated process.env value on their next call via cached-key comparison.
  await handleSecretRotation(rotatedSecret);

  const affected = [...liveMcps.values()].filter((r) => r.manifest.secrets.includes(rotatedSecret));
  if (affected.length === 0) {
    logger.info('mcp-spawn: rotation event with no live consumers', { secret: rotatedSecret });
    return;
  }

  for (const rec of affected) {
    const strat = rec.manifest.rotation.strategy;
    logger.info('mcp-spawn: applying rotation strategy', {
      mcp: rec.mcp, strategy: strat, secret: rotatedSecret,
    });
    mcpSpawnerEvents.emit('rotated', { mcp: rec.mcp, secret: rotatedSecret, strategy: strat });
    logHive(
      'mcp_rotation_applied',
      `mcp-spawn: rotation applied to ${rec.mcp} (strategy=${strat})`,
      undefined,
      { mcp: rec.mcp, secret: rotatedSecret, strategy: strat },
    );

    if (strat === 'sighup') {
      try { rec.child.kill('SIGHUP'); }
      catch (err) {
        logger.warn('mcp-spawn: SIGHUP failed', { mcp: rec.mcp, err: (err as Error).message });
        logHive('mcp_rotation_failed', `mcp-spawn: SIGHUP failed for ${rec.mcp}`, undefined, { mcp: rec.mcp });
      }
    } else if (strat === 'restart') {
      const spec = rec.spec;
      await stopMcp(rec.mcp);
      try { await spawnMcp(spec); }
      catch (err) {
        logger.error('mcp-spawn: restart failed', { mcp: rec.mcp, err: (err as Error).message });
        logHive('mcp_rotation_failed', `mcp-spawn: restart failed for ${rec.mcp}`, undefined, { mcp: rec.mcp });
      }
    } else {
      logger.warn('mcp-spawn: rotation requires manual restart', { mcp: rec.mcp, secret: rotatedSecret });
    }
  }
}

export function _resetLiveMcpsForTests(): void {
  liveMcps.clear();
}
