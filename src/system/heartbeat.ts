// Agent heartbeat — periodic 1-token LLM ping to keep agents (and the
// underlying MCP / provider connections) warm.
//
// Why: cold MCP connections can add 500ms-1s to the first user message in a
// new session because the vault socket has to re-establish. A 60s heartbeat
// keeps everything hot so the first turn pays the same cost as the tenth.
//
// Provider rules:
//   - VoidAI / OpenAI agents → ping via OpenRouter (openai/gpt-5-nano).
//   - Anthropic-API agents   → ping via Anthropic SDK. Cheap.
//   - Venice agents          → ping via Venice client (OpenAI-compatible).
//   - Kimi-API agents        → ping via Kimi API client.
//   - Claude-CLI agents      → SKIPPED by default (would burn subscription
//                              quota every interval). Set HEARTBEAT_SKIP_CLAUDE_CLI=false to override.
//   - Codex/Opencode CLI agents → skipped by default for subscription quota.

import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';
import { getDb, getAllAgents, logAnalytics, type AgentRecord } from '../db';
import { getClient as getOpenAi } from '../agent/openai-client';
import { getOllamaClient } from '../agent/ollama-client';
import { getOpenRouterClient } from '../agent/openrouter-client';
import { getAnthropicClient } from '../agent/anthropic-client';
import { getKimiApiClient } from '../agent/kimi-api-client';
import { getVeniceClient } from '../agent/venice-client';
import { getAbacusClient } from '../agent/abacus-client';
import { getHermesProxyClient } from '../agent/hermes-proxy-client';
import { getHeartbeatOllamaClient } from '../agent/heartbeat-ollama-client';
import { probeAntigravity } from '../providers/antigravity';
import OpenAI from 'openai';

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

async function pingViaOllama(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getOllamaClient().chat.completions.create({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `ollama ping (${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function pingViaHeartbeatOllama(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getHeartbeatOllamaClient().chat.completions.create({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `heartbeat-ollama ping (${model})`,
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

async function pingViaOpenRouter(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    // Detect if this is a reasoning model that needs the reasoning parameter
    const isReasoningModel = /(-oss-|deepseek.*r1|\/o1|\/o3|\/o4|thinking)/i.test(model);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestBody: any = {
      model,
      max_tokens: 16,  // Azure-routed models reject max_tokens < 16
      temperature: 0,
      messages: [{ role: 'user', content: 'ping' }],
    };
    
    if (isReasoningModel) {
      requestBody.reasoning = { enabled: true };
    }
    
    await withTimeout(
      getOpenRouterClient().chat.completions.create(requestBody),
      HEARTBEAT_TIMEOUT_MS,
      `openrouter ping (${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function pingViaVenice(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getVeniceClient().chat.completions.create({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `venice ping (${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function pingViaAbacus(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getAbacusClient().chat.completions.create({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `abacus ping (${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function pingViaKimiApi(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getKimiApiClient().chat.completions.create({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `kimi-api ping (${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function pingViaHermes(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getHermesProxyClient().chat.completions.create({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `hermes ping (${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

let _pollinationsClient: OpenAI | null = null;
function getPollinationsClient(): OpenAI {
  if (!_pollinationsClient) {
    _pollinationsClient = new OpenAI({
      apiKey:  config.pollinations.apiKey ?? 'noop',
      baseURL: config.pollinations.baseURL + '/v1',
    });
  }
  return _pollinationsClient;
}

async function pingViaPollinations(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await withTimeout(
      getPollinationsClient().chat.completions.create({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      HEARTBEAT_TIMEOUT_MS,
      `pollinations ping (${model})`,
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
let cachedCheapVoidaiModel:      string | null = null;
let cachedCheapAnthropicModel:   string | null = null;
let cachedCheapOpenRouterModel:  string | null = null;
let cachedCheapOllamaModel:      string | null = null;
let cachedCheapVeniceModel:      string | null = null;
let cachedCheapAbacusModel:      string | null = null;
let cachedCheapPollinationsModel: string | null = null;
let cachedCheapKimiApiModel:     string | null = null;
const HEARTBEAT_CHEAP_OPENAI_FALLBACK      = 'gpt-4o-mini';
const HEARTBEAT_CHEAP_ANTHROPIC_FALLBACK   = 'claude-haiku-4-5-20251001';
const HEARTBEAT_CHEAP_OPENROUTER_FALLBACK  = 'openai/gpt-5-nano';
const HEARTBEAT_CHEAP_VENICE_FALLBACK      = 'zai-org-glm-5';
const HEARTBEAT_CHEAP_OLLAMA_FALLBACK      = 'llama3.2'; // matches config.ollama.model default

// Preferred picks per provider, by reliability + cost. We pick the first one
// that's actually in the live catalog. For VoidAI, Anthropic-namespaced models
// can 500 even when listed; OpenAI / Gemini variants route more reliably.
const PREFERRED_VOIDAI = [
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'deepseek-v4-flash',
];
const PREFERRED_ANTHROPIC = [
  'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-latest',
  'claude-3-5-haiku-20241022',
];
const PREFERRED_OPENROUTER = [
  'openai/gpt-5-nano',
  'openai/gpt-4o-mini',
  'google/gemini-3.1-flash-lite',
  'anthropic/claude-3-haiku',
  'google/gemini-flash-1.5',
  'meta-llama/llama-3.1-8b-instruct',
];
const PREFERRED_VENICE = [
  'zai-org-glm-5',
  'kimi-k2-5',
  'venice-uncensored',
];
const PREFERRED_POLLINATIONS = [
  'openai-fast',
  'mistral',
  'gemini-fast',
  'llama',
  'openai',
];
const HEARTBEAT_CHEAP_POLLINATIONS_FALLBACK = 'openai-fast';
const PREFERRED_KIMI_API = ['kimi-for-coding'];

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

// Pick the cheapest chat-capable model for a provider straight from the catalog.
// Used by media-heavy providers (e.g. Abacus) where most models are non-chat and
// we have no curated PREFERRED list — pinging a media model would false-fail.
function firstChatCapable(provider: string): string | null {
  try {
    const tierRank = `CASE tier WHEN 'low' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END`;
    const row = getDb().prepare(`
      SELECT model_id FROM model_catalog
      WHERE provider = ? AND is_available = 1 AND chat_capable = 1
      ORDER BY ${tierRank} ASC, model_id ASC
      LIMIT 1
    `).get(provider) as { model_id: string } | undefined;
    return row?.model_id ?? null;
  } catch { return null; }
}

function pickCheapModel(provider: string): string {
  // HEARTBEAT_MODEL is a VoidAI/OpenAI override — don't apply it to providers
  // with their own model routing (OpenRouter has its own preferred-model list).
  if (config.heartbeat.model && provider !== 'openrouter' && provider !== 'ollama' && provider !== 'anthropic') return config.heartbeat.model;
  if (provider === 'anthropic') {
    if (cachedCheapAnthropicModel) return cachedCheapAnthropicModel;
    cachedCheapAnthropicModel = firstAvailable('anthropic', PREFERRED_ANTHROPIC) ?? HEARTBEAT_CHEAP_ANTHROPIC_FALLBACK;
    return cachedCheapAnthropicModel;
  }
  if (provider === 'openrouter') {
    if (cachedCheapOpenRouterModel) return cachedCheapOpenRouterModel;
    cachedCheapOpenRouterModel = firstAvailable('openrouter', PREFERRED_OPENROUTER) ?? HEARTBEAT_CHEAP_OPENROUTER_FALLBACK;
    return cachedCheapOpenRouterModel;
  }
  if (provider === 'ollama') {
    if (cachedCheapOllamaModel !== null) return cachedCheapOllamaModel;
    // Pick the first available model from catalog, falling back to configured default.
    const rows = (() => {
      try {
        return getDb().prepare(`SELECT model_id FROM model_catalog WHERE provider = 'ollama' AND is_available = 1 LIMIT 1`).all() as { model_id: string }[];
      } catch { return []; }
    })();
    // Use ?? to ensure we always cache a string (never undefined), so the `!== null`
    // sentinel check above correctly short-circuits on subsequent heartbeat ticks.
    cachedCheapOllamaModel = rows[0]?.model_id ?? config.ollama.model ?? HEARTBEAT_CHEAP_OLLAMA_FALLBACK;
    return cachedCheapOllamaModel;
  }
  if (provider === 'pollinations') {
    if (cachedCheapPollinationsModel) return cachedCheapPollinationsModel;
    cachedCheapPollinationsModel = firstAvailable('pollinations', PREFERRED_POLLINATIONS) ?? HEARTBEAT_CHEAP_POLLINATIONS_FALLBACK;
    return cachedCheapPollinationsModel;
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
  cachedCheapOpenRouterModel = null;
  cachedCheapOllamaModel = null;
  cachedCheapVeniceModel = null;
  cachedCheapAbacusModel = null;
  cachedCheapPollinationsModel = null;
  cachedCheapKimiApiModel = null;
  _pollinationsClient = null;
}

function pickModelFor(agent: AgentRecord): string {
  if (config.heartbeat.useOllamaProvider) {
    return config.heartbeatOllama.model;
  }
  if (agent.provider === 'openrouter' && config.heartbeat.openrouterViaVoidai) {
    return pickCheapModel('voidai');
  }
  if (agent.provider === 'venice') {
    if (cachedCheapVeniceModel) return cachedCheapVeniceModel;
    cachedCheapVeniceModel = firstAvailable('venice', PREFERRED_VENICE) ?? HEARTBEAT_CHEAP_VENICE_FALLBACK;
    return cachedCheapVeniceModel;
  }
  if (agent.provider === 'abacus') {
    if (cachedCheapAbacusModel) return cachedCheapAbacusModel;
    cachedCheapAbacusModel = firstChatCapable('abacus') ?? config.abacus.model;
    return cachedCheapAbacusModel;
  }
  // Providers with dedicated pickCheapModel branches keep their own model selection.
  if (agent.provider === 'anthropic' || agent.provider === 'openrouter' || agent.provider === 'ollama') {
    return pickCheapModel(agent.provider);
  }
  if (agent.provider === 'kimi-api') {
    if (cachedCheapKimiApiModel) return cachedCheapKimiApiModel;
    cachedCheapKimiApiModel = firstAvailable('kimi-api', PREFERRED_KIMI_API) ?? config.kimiApi.model;
    return cachedCheapKimiApiModel;
  }
  if (agent.provider === 'hermes') {
    return config.hermes.model;  // e.g. grok-4.3 — single proxy model, no catalog needed
  }
  // openai, voidai, and any unknown provider ping via OpenRouter (gpt-5-nano).
  return pickCheapModel('openrouter');
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
  // Codex CLI agents use subscription auth — skip heartbeats by default.
  if (agent.provider === 'codex' && config.codex.backend === 'cli') {
    return record(agent, 'skipped', Date.now() - t0, undefined, 'codex-cli backend (subscription quota)');
  }
  // Opencode CLI agents use subscription auth — skip heartbeats by default.
  if (agent.provider === 'opencode') {
    return record(agent, 'skipped', Date.now() - t0, undefined, 'opencode-cli backend (subscription quota)');
  }
  // Antigravity uses a managed OAuth token flow — no connection to keep warm.
  if (agent.provider === 'antigravity') {
    return record(agent, 'skipped', Date.now() - t0, undefined, 'antigravity (managed auth — no warmup needed)');
  }

  const model = pickModelFor(agent);

  // ── Provider routing ──
  let result: { ok: true } | { ok: false; reason: string };
  if (config.heartbeat.useOllamaProvider) {
    result = await pingViaHeartbeatOllama(model);
  } else if (agent.provider === 'anthropic' && config.claude.backend === 'anthropic-api') {
    result = await pingViaAnthropic(model);
  } else if (agent.provider === 'venice') {
    result = await pingViaVenice(model);
  } else if (agent.provider === 'abacus') {
    result = await pingViaAbacus(model);
  } else if (agent.provider === 'openrouter' && !config.heartbeat.openrouterViaVoidai) {
    result = await pingViaOpenRouter(model);
  } else if (agent.provider === 'kimi-api') {
    result = await pingViaKimiApi(model);
  } else if (agent.provider === 'hermes') {
    result = await pingViaHermes(model);
  } else if (agent.provider === 'ollama') {
    result = await pingViaOllama(model);
  } else if (agent.provider === 'pollinations') {
    result = await pingViaPollinations(model);
  } else {
    // OpenRouter ping — covers openai/voidai and any unknown-provider agents (gpt-5-nano).
    result = await pingViaOpenRouter(model);
  }

  const latencyMs = Date.now() - t0;
  return record(agent, result.ok ? 'ok' : 'fail', latencyMs, model, result.ok ? undefined : result.reason);
}

function record(agent: AgentRecord, status: HeartbeatStatus, latencyMs: number, model?: string, reason?: string): HeartbeatResult {
  // Consecutive-fail dampening — must run BEFORE the DB write so we know
  // whether this is a transient blip or a sustained outage.
  //
  // Rule: only flip heartbeat_status → 'fail' in the DB once FAIL_THRESHOLD
  // consecutive pings have failed. Transient single timeouts update the
  // timestamp/latency only (preserving the prior 'ok'/'skipped' status) so
  // the dashboard dot does NOT turn red on a one-off VoidAI cold-route timeout.
  const prevStreak = failStreaks.get(agent.id) ?? 0;
  let suppressStatusWrite = false;

  if (status === 'fail') {
    const newStreak = prevStreak + 1;
    failStreaks.set(agent.id, newStreak);
    // Below threshold: keep the existing DB status; only update timestamp/latency.
    if (newStreak < FAIL_THRESHOLD) suppressStatusWrite = true;
    // Only log to hive_mind on the threshold-crossing fail. Subsequent failures
    // stay silent until the streak ends; saves noise on extended outages.
    if (newStreak === FAIL_THRESHOLD) {
      try { logHive('agent_heartbeat', `heartbeat: ${agent.name}: FAIL (${newStreak} consecutive) — ${reason ?? 'unknown'} (${latencyMs}ms)`, agent.id, { status, latencyMs, reason, model, streak: newStreak }); } catch { /* best-effort */ }
    }
  } else if (status === 'ok') {
    if (prevStreak >= FAIL_THRESHOLD) {
      try { logHive('agent_heartbeat', `heartbeat: ${agent.name}: recovered after ${prevStreak} fails (${latencyMs}ms)`, agent.id, { status, latencyMs, model, prevStreak }); } catch { /* best-effort */ }
    }
    failStreaks.set(agent.id, 0);
  }

  // Persist on the agent row (best-effort; never throw upstream).
  try {
    if (suppressStatusWrite) {
      // Transient fail (below threshold): update timestamp + latency only.
      // heartbeat_status stays at its current value so the dot stays green/skipped.
      getDb().prepare(`
        UPDATE agents
        SET last_heartbeat_at    = datetime('now'),
            heartbeat_latency_ms = ?
        WHERE id = ?
      `).run(latencyMs, agent.id);
    } else {
      getDb().prepare(`
        UPDATE agents
        SET last_heartbeat_at    = datetime('now'),
            heartbeat_status     = ?,
            heartbeat_latency_ms = ?
        WHERE id = ?
      `).run(status, latencyMs, agent.id);
    }
  } catch (err) {
    logger.warn('heartbeat: persist failed', { agentId: agent.id, err: (err as Error).message });
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

// Maximum simultaneous pings. Sending 15+ concurrent requests to the same
// VoidAI endpoint causes tail requests to stall until the 30s hard timeout.
// 5 slots keeps wall-time low (~2-3 passes × 3s each) without flooding.
const HEARTBEAT_CONCURRENCY = 5;

async function runWithConcurrency(
  agents: AgentRecord[],
  limit: number,
): Promise<HeartbeatResult[]> {
  const results: HeartbeatResult[] = new Array(agents.length);
  let idx = 0;
  async function worker() {
    while (idx < agents.length) {
      const i = idx++;
      results[i] = await pingAgent(agents[i]).catch((err: unknown) => record(agents[i], 'fail', 0, undefined, (err as Error).message));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, agents.length) }, worker));
  return results;
}

export async function runHeartbeats(): Promise<HeartbeatResult[]> {
  const agents = getAllAgents().filter(a => a.status === 'active' && !a.temporary);
  // Prune failStreaks for agents that are no longer in the active set (deactivated
  // or expired temp agents). The map is only ever set/reset elsewhere, so without
  // this it grows monotonically with every distinct agent id that ever failed a
  // ping.
  if (failStreaks.size > agents.length) {
    const live = new Set(agents.map(a => a.id));
    for (const id of failStreaks.keys()) if (!live.has(id)) failStreaks.delete(id);
  }
  const startTime = Date.now();
  const results = await runWithConcurrency(agents, HEARTBEAT_CONCURRENCY);
  const totalMs = Date.now() - startTime;
  
  // Track heartbeat batch summary in analytics
  const okCount = results.filter(r => r.status === 'ok').length;
  const failCount = results.filter(r => r.status === 'fail').length;
  const skippedCount = results.filter(r => r.status === 'skipped').length;
  const avgLatency = results.filter(r => r.status === 'ok').reduce((sum, r) => sum + r.latencyMs, 0) / (okCount || 1);
  
  logAnalytics('heartbeat_batch', {
    totalAgents: agents.length,
    ok: okCount,
    fail: failCount,
    skipped: skippedCount,
    avgLatencyMs: Math.round(avgLatency),
    totalDurationMs: totalMs,
  });
  
  return results;
}

/**
 * Pre-warm a specific agent inline (used by chat path on first message in a
 * new session, when last_heartbeat_at is older than 2× the interval).
 * Fire-and-forget; never blocks the caller.
 */
export function prewarmAgentAsync(agent: AgentRecord): void {
  if (!config.heartbeat.enabled) return;
  const intervalMs = config.heartbeat.intervalSec * 1000;
  if (agent.last_heartbeat_at) {
    const age = Date.now() - new Date(agent.last_heartbeat_at).getTime();
    // Skip if the last heartbeat was recent AND it succeeded — a recent failed
    // heartbeat means the connection is cold and should be warmed immediately.
    if (age < 2 * intervalMs && agent.heartbeat_status !== 'fail') return;
  }
  pingAgent(agent).catch(err => logger.warn('heartbeat: pre-warm failed', { agentId: agent.id, err: (err as Error).message }));
}

// ── Scheduler ───────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let heartbeatRunning = false;

// Reentrancy guard: a heartbeat batch (concurrency-capped pings, each up to the
// ping timeout) can exceed the interval (as low as 15s) when many agents are
// configured. Without this, setInterval stacks overlapping batches, doubling
// load on shared provider clients — the very stall the concurrency cap targets.
async function tickHeartbeats(): Promise<void> {
  if (heartbeatRunning) {
    logger.debug('heartbeat: previous batch still running — skipping this tick');
    return;
  }
  heartbeatRunning = true;
  try { await runHeartbeats(); }
  catch { /* runHeartbeats is internally guarded; never let a tick reject */ }
  finally { heartbeatRunning = false; }
}

export function startHeartbeatScheduler(): void {
  if (!config.heartbeat.enabled) {
    logger.info('heartbeat: disabled (HEARTBEAT_ENABLED=false)');
    return;
  }
  const intervalMs = Math.max(15, config.heartbeat.intervalSec) * 1000;
  // Run once at boot (after a short delay so other startup work finishes), then on interval.
  setTimeout(() => { void tickHeartbeats(); }, 5_000);
  timer = setInterval(() => { void tickHeartbeats(); }, intervalMs);
  logger.info('heartbeat: scheduler started', { intervalSec: intervalMs / 1000 });
}

export function stopHeartbeatScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
