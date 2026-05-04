// Agent heartbeat — periodic 1-token LLM ping to keep agents (and the
// underlying MCP / provider connections) warm.
//
// Why: cold MCP connections can add 500ms-1s to the first user message in a
// new session because the vault socket has to re-establish. A 60s heartbeat
// keeps everything hot so the first turn pays the same cost as the tenth.
//
// Provider rules:
//   - VoidAI / OpenAI agents → ping via OpenAI client. Cheap (~6 in / 1 out).
//   - Anthropic-API agents   → ping via Anthropic SDK. Cheap.
//   - Claude-CLI agents      → SKIPPED by default (would burn subscription
//                              quota every interval). Set HEARTBEAT_SKIP_CLAUDE_CLI=false to override.

import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';
import { getDb, getAllAgents, type AgentRecord } from '../db';
import { getClient as getOpenAi } from '../agent/openai-client';
import { getAnthropicClient } from '../agent/anthropic-client';

export type HeartbeatStatus = 'ok' | 'fail' | 'skipped' | 'never';

export interface HeartbeatResult {
  agentId:    string;
  agentName:  string;
  status:     HeartbeatStatus;
  latencyMs:  number;
  model?:     string;
  reason?:    string;
}

// ── Per-provider ping ───────────────────────────────────────────────────────

async function pingViaOpenAi(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getOpenAi().chat.completions.create({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `openai ping (${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function pingViaAnthropic(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getAnthropicClient().messages.create({
        model,
        max_tokens: 1,
        messages:   [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `anthropic ping (${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// ── Single agent heartbeat ──────────────────────────────────────────────────

// Cached cheap-model picks per provider. The heartbeat's purpose is connection
// warmth, not "does this agent's exact model still respond" — using each
// agent's pinned model causes 30+ second pings on heavyweight models. Use the
// cheapest available low-tier model in the same provider's catalog instead.
let cachedCheapVoidaiModel: string | null = null;
let cachedCheapAnthropicModel: string | null = null;
const HEARTBEAT_CHEAP_OPENAI_FALLBACK    = 'gpt-4o-mini';
const HEARTBEAT_CHEAP_ANTHROPIC_FALLBACK = 'claude-haiku-4-5-20251001';

// Preferred picks per provider, by reliability + cost. We pick the first one
// that's actually in the live catalog. For VoidAI, Anthropic-namespaced models
// can 500 even when listed; OpenAI / Gemini variants route more reliably.
const PREFERRED_VOIDAI = [
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'deepseek-v4-flash',
];
const PREFERRED_ANTHROPIC = [
  'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-latest',
  'claude-3-5-haiku-20241022',
];

function firstAvailable(provider: string, candidates: string[]): string | null {
  try {
    const placeholders = candidates.map(() => '?').join(',');
    const rows = getDb().prepare(`
      SELECT model_id FROM model_catalog
      WHERE provider = ? AND model_id IN (${placeholders}) AND is_available = 1
    `).all(provider, ...candidates) as { model_id: string }[];
    const set = new Set(rows.map(r => r.model_id));
    for (const c of candidates) if (set.has(c)) return c;
  } catch { /* table missing or empty */ }
  return null;
}

function pickCheapModel(provider: string): string {
  if (config.heartbeat.model) return config.heartbeat.model;
  if (provider === 'anthropic') {
    if (cachedCheapAnthropicModel) return cachedCheapAnthropicModel;
    cachedCheapAnthropicModel = firstAvailable('anthropic', PREFERRED_ANTHROPIC) ?? HEARTBEAT_CHEAP_ANTHROPIC_FALLBACK;
    return cachedCheapAnthropicModel;
  }
  // VoidAI / OpenAI-compatible
  if (cachedCheapVoidaiModel) return cachedCheapVoidaiModel;
  cachedCheapVoidaiModel = firstAvailable('voidai', PREFERRED_VOIDAI) ?? HEARTBEAT_CHEAP_OPENAI_FALLBACK;
  return cachedCheapVoidaiModel;
}

/** Reset model cache (so a manual refresh picks up tier overrides). */
export function clearHeartbeatModelCache(): void {
  cachedCheapVoidaiModel = null;
  cachedCheapAnthropicModel = null;
}

function pickModelFor(agent: AgentRecord): string {
  return pickCheapModel(agent.provider ?? 'voidai');
}

// Hard timeout per heartbeat ping so a hanging provider doesn't hold the
// scheduler open. Bumped to 30s — VoidAI cold-routes can take 10-15s on
// first call to a model and we don't want to flap on that.
const HEARTBEAT_TIMEOUT_MS = 30_000;

// Consecutive-fail counter to dampen heartbeat noise. We only emit a FAIL
// hive event after N pings in a row fail, and only emit a "recovered" when
// we've actually been failing. Single transient timeouts stay quiet.
const FAIL_THRESHOLD = 3;
const failStreaks = new Map<string, number>();

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export async function pingAgent(agent: AgentRecord): Promise<HeartbeatResult> {
  const t0 = Date.now();

  // ── Skip rules ──
  if (agent.status !== 'active') {
    return record(agent, 'skipped', Date.now() - t0, undefined, 'agent inactive');
  }
  if (agent.temporary) {
    return record(agent, 'skipped', Date.now() - t0, undefined, 'temporary agent');
  }
  if (agent.provider === 'anthropic' && config.claude.backend === 'claude-cli' && config.heartbeat.skipClaudeCli) {
    return record(agent, 'skipped', Date.now() - t0, undefined, 'claude-cli backend (subscription quota)');
  }
  // Codex CLI agents also use subscription auth — skip heartbeats by default.
  if (agent.provider === 'codex' && config.codex.backend === 'cli') {
    return record(agent, 'skipped', Date.now() - t0, undefined, 'codex-cli backend (subscription quota)');
  }

  const model = pickModelFor(agent);

  // ── Provider routing ──
  let result: { ok: true } | { ok: false; reason: string };
  if (agent.provider === 'anthropic' && config.claude.backend === 'anthropic-api') {
    result = await pingViaAnthropic(model);
  } else {
    // OpenAI / VoidAI path (also covers anthropic agents that have somehow
    // ended up routed through the OpenAI-compatible endpoint).
    result = await pingViaOpenAi(model);
  }

  const latencyMs = Date.now() - t0;
  return record(agent, result.ok ? 'ok' : 'fail', latencyMs, model, result.ok ? undefined : result.reason);
}

function record(agent: AgentRecord, status: HeartbeatStatus, latencyMs: number, model?: string, reason?: string): HeartbeatResult {
  // Persist on the agent row (best-effort; never throw upstream).
  try {
    getDb().prepare(`
      UPDATE agents
      SET last_heartbeat_at    = datetime('now'),
          heartbeat_status     = ?,
          heartbeat_latency_ms = ?
      WHERE id = ?
    `).run(status, latencyMs, agent.id);
  } catch (err) {
    logger.warn('heartbeat: persist failed', { agentId: agent.id, err: (err as Error).message });
  }

  // Consecutive-fail dampening: don't shout FAIL on a single transient timeout.
  // Only log to hive_mind when we've crossed FAIL_THRESHOLD consecutive fails,
  // and emit "recovered" only if we actually were in a failing streak.
  const prevStreak = failStreaks.get(agent.id) ?? 0;

  if (status === 'fail') {
    const newStreak = prevStreak + 1;
    failStreaks.set(agent.id, newStreak);
    // Only log on the threshold-crossing fail. Subsequent failures stay silent
    // until streak ends; saves 100s of noise events on extended outages.
    if (newStreak === FAIL_THRESHOLD) {
      try { logHive('agent_heartbeat', `${agent.name}: FAIL (${newStreak} consecutive) — ${reason ?? 'unknown'} (${latencyMs}ms)`, agent.id, { status, latencyMs, reason, model, streak: newStreak }); } catch { /* best-effort */ }
    }
  } else if (status === 'ok') {
    if (prevStreak >= FAIL_THRESHOLD) {
      try { logHive('agent_heartbeat', `${agent.name}: recovered after ${prevStreak} fails (${latencyMs}ms)`, agent.id, { status, latencyMs, model, prevStreak }); } catch { /* best-effort */ }
    }
    failStreaks.set(agent.id, 0);
  }

  return {
    agentId:   agent.id,
    agentName: agent.name,
    status,
    latencyMs,
    model,
    reason,
  };
}

// ── Batch ───────────────────────────────────────────────────────────────────

export async function runHeartbeats(): Promise<HeartbeatResult[]> {
  const agents = getAllAgents().filter(a => a.status === 'active' && !a.temporary);
  // Run in parallel — keeps total wall-time roughly equal to the slowest single ping.
  const results = await Promise.all(agents.map(a => pingAgent(a).catch(err => record(a, 'fail', 0, undefined, (err as Error).message))));
  return results;
}

/**
 * Pre-warm a specific agent inline (used by chat path on first message in a
 * new session, when last_heartbeat_at is older than 2× the interval).
 * Fire-and-forget; never blocks the caller.
 */
export function prewarmAgentAsync(agent: AgentRecord): void {
  if (!config.heartbeat.enabled) return;
  // Skip if heartbeat just ran (same as scheduler skip rules).
  const intervalMs = config.heartbeat.intervalSec * 1000;
  if (agent.last_heartbeat_at) {
    const age = Date.now() - new Date(agent.last_heartbeat_at).getTime();
    if (age < 2 * intervalMs) return;
  }
  pingAgent(agent).catch(err => logger.warn('heartbeat: pre-warm failed', { agentId: agent.id, err: (err as Error).message }));
}

// ── Scheduler ───────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

export function startHeartbeatScheduler(): void {
  if (!config.heartbeat.enabled) {
    logger.info('Heartbeat: disabled (HEARTBEAT_ENABLED=false)');
    return;
  }
  const intervalMs = Math.max(15, config.heartbeat.intervalSec) * 1000;
  // Run once at boot (after a short delay so other startup work finishes), then on interval.
  setTimeout(() => { runHeartbeats().catch(() => {}); }, 5_000);
  timer = setInterval(() => { runHeartbeats().catch(() => {}); }, intervalMs);
  logger.info('Heartbeat: scheduler started', { intervalSec: intervalMs / 1000 });
}

export function stopHeartbeatScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
