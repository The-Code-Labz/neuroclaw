import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { tokenMatches } from './auth';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  getDb, createSession, getAllAgents, getAgentById, getAgentByName,
  createAgentRecord, updateAgentRecord, deactivateAgent, activateAgent, deleteAgentHard,
  getSessions, getSessionsWithPreviews, searchSessions, getSessionById, getSessionMessages, updateSessionTitle, mergeSessions, setSessionChatMode, setSessionPinned, setSessionStatus,
  getAgentMessages, createAgentMessage, updateAgentMessageResponse,
  createCommsNote, getCommsNotes, deleteCommsNote, updateCommsNote,
  getAgentUserMessages, getAgentUserMessageById, markAgentUserMessageRead, markAgentUserMessageDismissed, getUnreadAgentUserMessageCount, createAgentUserMessage,
  listAreas, createArea, updateArea, deleteArea, setAgentArea,
  listProjects, getProject, createProject, updateProject, archiveProject, deleteProjectHard,
  startRun, endRun, getRun, listRuns, getRunHiveEvents, markRunDelivered,
  appendPartialOutput, detachRun, findResumableRun,
  createApproval, getApproval, resolveApproval, listApprovals,
  getSpawnConfig, setSpawnConfig,
  listMcpServers,
  listAnalystAlerts, dismissAnalystAlert,
  saveMessage,
  getCliTools, createCliTool, updateCliTool, getCliTool,
  type SessionRecord, type MessageRecord,
  getDebugLogs, type DebugLogRow,
} from '../db';
import { listManagedSessions, capturePane, isAlive as tmuxIsAlive } from '../system/claude-tmux';
import { approvalEvents } from '../system/approval-events';
import { notificationEvents } from '../system/notification-events';
import { config } from '../config';
import { getAnalyticsSummary, getSystemHealthStats, getRecentErrors, getMessageSparkline, getTopTools, getActivityHeatmap, getHealthSummary, getDowntimeEvents, getUptimeTimeline } from '../system/analytics';
import { getRecentLogs } from '../system/audit';
import { logEvents, readRecentLogLines, readFilteredLogLines, logger, type ParsedLogLine } from '../utils/logger';
import { translateClaudeError } from '../utils/claudeErrorLabel';
import { getMemories, saveMemory } from '../memory/memory-service';
import { getMemoryStore } from '../memory/memory-store';
import {
  startImport, cancelImport, importEvents,
} from '../memory/memory-importer';
import { listImportSessions, getImportSession } from '../db';
import { getTasks, createTask, updateTask, TASK_STATUSES, type TaskStatus } from '../system/task-manager';
import { configEvents } from '../system/config-watcher';
import { chatStream, orchestrateMultiAgent, resolveAgent, clearHistory, type MetaEvent } from '../agent/alfred';
import { setRelayDispatch, clearRelayDispatch, createPending, resolvePending } from '../system/relay';
import { registerStream, clearStream, stopStream } from '../system/stream-control';
import { startHeartbeat } from '../agent/heartbeat';
import { agentBus, type AgentEvent } from '../system/event-bus';
import { markTurnDone, startTurn, clearTurn } from '../agent/turn-state';
import { spawnAgent } from '../system/spawner';
import { getHiveEvents, getHiveErrors, hiveEvents, logHive, type HiveEvent } from '../system/hive-mind';
import { broadcastIntroduction } from '../system/herald';
import { taskEvents, getTasksBySession, type BackgroundTask } from '../system/background-tasks';
import { getAnthropicAuthStatus } from '../agent/anthropic-client';
import { getOpenRouterClient } from '../agent/openrouter-client';
import { probeClaudeCli } from '../providers/claude-cli';
import { getCodexCliQueueLength, probeCodexCli } from '../providers/codex-cli';
import { fetchCodexUsage } from '../infra/codex-usage';
import { probeAntigravity, getAntigravityQueueLength } from '../providers/antigravity';
import { probeOpencodeCli, getOpencodeCliQueueLength } from '../providers/opencode-cli';
import {
  listCatalog, refreshCatalog, setTierOverride, setPriceOverride,
  MODEL_PROVIDERS, type ModelTier, type ModelProvider,
} from '../system/model-catalog';
import { spendLastHourWithCost, spendByTierLastHour, spendByModelLastHour, spendByProvider, spendByProviderAndAgent } from '../system/model-spend';
import { getWikiTree, getWikiArticle } from './wiki-loader';
import {
  listSkills, clearSkillCache, getSkill,
  createSkill, updateSkill, deleteSkill,
  writeSkillScript, deleteSkillScript,
  sanitizeSkillName,
} from '../skills/skill-loader';
import { syncSkillExports } from '../skills/exporters';
import fs from 'fs';
import path from 'path';
import { runDreamCycle } from '../memory/dream-cycle';
import { startAutonomousLoop, stopAutonomousLoop, getAutonomousStatus } from '../system/autonomous-loop';
import { runHeartbeats, pingAgent } from '../system/heartbeat';
import { getSentinelStatus, runSentinelScan, getActiveSentinelEscalations } from '../system/sentinel';
import { runStephanieAnalysis, getStephanieStatus } from '../system/stephanie';
import { getSessionCleanupStatus, cleanupStaleSessions, getSessionStats, deleteSessionWithRelated } from '../system/session-cleanup';
import { performBackup, listBackups, getBackupStatus } from '../system/db-backup';
import { synthesize, resolveAgentVoice, type TtsProvider } from '../audio/tts';
import { enqueueJob, getCachedAudio, buildAudioCacheKey } from '../db';
import { transcribe } from '../audio/transcribe';
import { listVoidAIVoices, listElevenLabsVoices, listAllVoices, listKokoroVoices, listChatterboxVoices } from '../audio/voices';
import { sessionQueueManager } from '../system/session-queue-manager';
import {
  listCronJobs, getCronJob, getCronJobBySlug,
  createCronJob, updateCronJob, deleteCronJob, listCronRuns,
  type CronJob,
} from '../db';
import { getSkillTelemetry } from '../db';
import cron from 'node-cron';
import { syncJob, executeJobNow, cronEvents } from '../system/cron-scheduler';
import {
  getEnvVariables, getEnvByCategory, getEnvSchema,
  updateEnvVariables, deleteEnvVariable, getRawEnvValue,
} from '../system/env-manager';
import { generateRoomToken, getRoomParticipants, LIVEKIT_ROOM_NAME } from '../integrations/livekit-room';
import { getRoomSessionId, sendToRoom } from '../system/room-session';
import { dispatchSlash, getCommandCatalog } from '../system/slash-registry';
import { browserlessRequest } from '../system/browser';
import { registerBrokerRoutes, registerBrokerPublicRoutes } from '../broker/server';

// ── Browserless status cache (30s TTL, shared across buildProviderSummaries) ─
interface BrowserStatusCache {
  status: 'online' | 'offline' | 'unconfigured';
  latency_ms: number | null;
  error: string | null;
  checked_at: string;
}

interface GitStatusSummary {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

let _gitStatusCache: GitStatusSummary | null = null;
let _gitStatusCachedAt = 0;
const GIT_STATUS_TTL_MS = 15_000;

function getGitStatusSummary(): GitStatusSummary {
  const now = Date.now();
  if (_gitStatusCache && now - _gitStatusCachedAt < GIT_STATUS_TTL_MS) return _gitStatusCache;

  try {
    const out = execFileSync('git', ['status', '--short', '--branch'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
    const lines = out.split('\n').filter(Boolean);
    const head = lines[0] || '## unknown';
    const branch = head
      .replace(/^##\s+/, '')
      .replace(/\.\.\..*$/, '')
      .replace(/\s+\[.*\]$/, '') || 'unknown';
    const ahead = Number(/\bahead\s+(\d+)/.exec(head)?.[1] || 0);
    const behind = Number(/\bbehind\s+(\d+)/.exec(head)?.[1] || 0);
    _gitStatusCache = { branch, dirty: lines.length > 1, ahead, behind };
  } catch {
    _gitStatusCache = { branch: 'unknown', dirty: false, ahead: 0, behind: 0 };
  }
  _gitStatusCachedAt = now;
  return _gitStatusCache;
}
let _browserStatusCache: BrowserStatusCache | null = null;
let _browserStatusCachedAt = 0;
const BROWSER_STATUS_TTL_MS = 30_000;

async function probeBrowserless(): Promise<BrowserStatusCache> {
  if (!config.browser.enabled) {
    return { status: 'unconfigured', latency_ms: null, error: null, checked_at: new Date().toISOString() };
  }
  const now = Date.now();
  if (_browserStatusCache && now - _browserStatusCachedAt < BROWSER_STATUS_TTL_MS) {
    return _browserStatusCache;
  }
  const start = now;
  try {
    await browserlessRequest('/content', { url: 'data:text/html,<h1>ping</h1>', gotoOptions: { waitUntil: 'load' } }, { responseType: 'text', timeoutMs: 5000 });
    _browserStatusCache = { status: 'online', latency_ms: Date.now() - start, error: null, checked_at: new Date().toISOString() };
  } catch (err) {
    _browserStatusCache = { status: 'offline', latency_ms: null, error: (err as Error).message, checked_at: new Date().toISOString() };
  }
  _browserStatusCachedAt = Date.now();
  return _browserStatusCache;
}


// ── State-stream broadcast registry ───────────────────────────────────────
// All open /api/state/stream connections register a writer here. broadcastState
// fans out to every live connection; dead writers are pruned automatically.
type StateWriter = (event: object) => Promise<void>;
const _stateWriters = new Set<StateWriter>();

async function broadcastState(event: object): Promise<void> {
  if (_stateWriters.size === 0) return;
  const dead: StateWriter[] = [];
  for (const write of _stateWriters) {
    try { await write(event); }
    catch { dead.push(write); }
  }
  for (const w of dead) _stateWriters.delete(w);
}

// Wire existing event buses to broadcast incremental updates.
// Module-level so listeners are registered once per process lifetime.
agentBus.on('agent', () => {
  broadcastState({ type: 'agents', agents: getAllAgents() }).catch(() => {});
});
hiveEvents.on('event', (evt: import('../system/hive-mind').HiveEvent) => {
  broadcastState({ type: 'hive_event', event: evt }).catch(() => {});
});
taskEvents.on('task_created', () => {
  broadcastState({ type: 'tasks', tasks: getTasks() }).catch(() => {});
});
taskEvents.on('task_complete', () => {
  broadcastState({ type: 'tasks', tasks: getTasks() }).catch(() => {});
});
taskEvents.on('task_failed', () => {
  broadcastState({ type: 'tasks', tasks: getTasks() }).catch(() => {});
});
notificationEvents.on('notification', (evt: import('../system/notification-events').DashboardNotificationEvent) => {
  broadcastState({ type: 'notification', notification: evt }).catch(() => {});
});

// ── Core-status cache (15s TTL) — shared between /api/core/status and state-stream ─
let _coreStatusCache: Awaited<ReturnType<typeof buildCoreStatus>> | null = null;
let _coreStatusCachedAt = 0;
const CORE_STATUS_TTL_MS = 15_000;

async function getCachedCoreStatus() {
  const now = Date.now();
  if (_coreStatusCache && now - _coreStatusCachedAt < CORE_STATUS_TTL_MS) {
    return _coreStatusCache;
  }
  _coreStatusCache = await buildCoreStatus();
  _coreStatusCachedAt = Date.now();
  return _coreStatusCache;
}

// ── State snapshot (all primary-wave data in one shot) ────────────────────
async function buildStateSnapshot() {
  const db = getDb();
  const core     = await getCachedCoreStatus();
  const agents   = getAllAgents();
  const sessions = getSessionsWithPreviews(100);
  const tasks    = getTasks();
  const hive     = getHiveEvents(120);
  const anthropic = getAnthropicAuthStatus();
  const notifList = getAgentUserMessages({ limit: 80, unreadOnly: false, undismissedOnly: true });
  const unreadCount = getUnreadAgentUserMessageCount();
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const status = {
    status:    'online',
    version:   process.env.npm_package_version || '1.0.0',
    checkedAt: new Date().toISOString(),
    model:     config.voidai.model,
    uptime:    process.uptime(),
    agents:    agents.filter((a: { status: string }) => a.status === 'active').length,
    sessions:  (db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n,
    messages:  (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n,
    tempAgents: agents.filter((a: { temporary: number; status: string }) => a.temporary && a.status === 'active').length,
    parallelSessions: sessionQueueManager.activeCount(),
    process: {
      pid: process.pid,
      memory: { rssMb: Math.round(mem.rss/1024/1024), heapUsedMb: Math.round(mem.heapUsed/1024/1024), heapTotalMb: Math.round(mem.heapTotal/1024/1024), externalMb: Math.round(mem.external/1024/1024) },
      cpuMicros: { user: cpu.user, system: cpu.system },
    },
    git: getGitStatusSummary(),
    anthropic,
  };
  return { core, agents, sessions, tasks, hive, notifications: { notifications: notifList, unreadCount }, status, claude: anthropic };
}

// ── CLI probe result cache (30s TTL, shared across buildProviderSummaries + buildCoreStatus) ─
interface CliProbeCache {
  claudeProbe:     { ok: boolean; version: string | null; binaryPath: string | null; error: string | null };
  codexProbe:      { ok: boolean; version: string | null; error: string | null };
  antigravityProbe:{ ok: boolean; model: string | null; error: string | null };
  opencodeProbe:   { ok: boolean; binaryPath: string | null; version: string | null; error: string | null };
}
let _cliProbeCache: CliProbeCache | null = null;
let _cliProbeCachedAt = 0;
const CLI_PROBE_TTL_MS = 30_000;

async function getCliProbes(): Promise<CliProbeCache> {
  const now = Date.now();
  if (_cliProbeCache && now - _cliProbeCachedAt < CLI_PROBE_TTL_MS) {
    return _cliProbeCache;
  }
  const [claudeProbe, codexProbe, antigravityProbe, opencodeProbe] = await Promise.all([
    probeClaudeCli().catch(err     => ({ ok: false as const, version: null as string | null, binaryPath: null as string | null, error: (err as Error).message })),
    probeCodexCli().catch(err      => ({ ok: false as const, version: null as string | null, error: (err as Error).message })),
    probeAntigravity().catch(err   => ({ ok: false as const, model: null as string | null, error: (err as Error).message })),
    probeOpencodeCli().catch(err   => ({ ok: false as const, binaryPath: null as string | null, version: null as string | null, error: (err as Error).message })),
  ]);
  const result: CliProbeCache = { claudeProbe, codexProbe, antigravityProbe, opencodeProbe };
  _cliProbeCache = result;
  _cliProbeCachedAt = Date.now();
  return result;
}

// ── Webhook deduplication ────────────────────────────────────────────────────
// Prevents rapid-fire webhooks from triggering duplicate job executions.
// Uses a slug+hash key with a short TTL window.
const recentWebhooks = new Map<string, number>(); // key → timestamp
const WEBHOOK_DEDUP_WINDOW_MS = 2000; // 2 second window
const WEBHOOK_DEDUP_CAP = 500; // max entries before cleanup

function isWebhookDuplicate(slug: string, bodyHash: string): boolean {
  const key = `${slug}:${bodyHash}`;
  const now = Date.now();
  const lastSeen = recentWebhooks.get(key);
  
  // Cleanup old entries if map gets too large
  if (recentWebhooks.size > WEBHOOK_DEDUP_CAP) {
    for (const [k, ts] of recentWebhooks) {
      if (now - ts > WEBHOOK_DEDUP_WINDOW_MS) recentWebhooks.delete(k);
    }
  }
  
  if (lastSeen && now - lastSeen < WEBHOOK_DEDUP_WINDOW_MS) {
    return true; // Duplicate within window
  }
  
  recentWebhooks.set(key, now);
  return false;
}

function hashBody(body: unknown): string {
  // Simple hash for dedup purposes
  return JSON.stringify(body).slice(0, 200);
}

type CoreCheckState = 'ok' | 'warn' | 'fail' | 'off';

interface CoreCheck {
  state: CoreCheckState;
  label: string;
  detail: string;
  value?: number;
  total?: number;
}

// Safe integer query-param: a non-numeric ?limit=abc makes parseInt return NaN,
// which better-sqlite3 then rejects when bound to LIMIT/OFFSET → a 500. Coerce
// any non-finite/negative value to `def` and cap at `max`.
function intQuery(raw: string | undefined | null, def: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = parseInt(raw ?? '', 10);
  return Math.min(max, Number.isFinite(n) && n >= 0 ? n : def);
}

function countSafe(db: ReturnType<typeof getDb>, sql: string): number {
  try {
    return (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  } catch {
    return 0;
  }
}

function cfgVal(db: ReturnType<typeof getDb>, key: string): string | null {
  return (db.prepare('SELECT value FROM config_items WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

function normalizeProviderKey(provider: string | null | undefined): string {
  const p = (provider ?? '').trim().toLowerCase();
  if (!p || p === 'openai') return 'voidai';
  return p;
}

function providerName(provider: string): string {
  if (provider === 'voidai') return 'VoidAI';
  if (provider === 'anthropic') return config.claude.backend === 'claude-cli' ? 'Claude CLI' : 'Anthropic API';
  if (provider === 'codex') return config.codex.backend === 'cli' ? 'Codex CLI' : 'Codex API';
  if (provider === 'antigravity') return 'Antigravity';
  if (provider === 'opencode') return 'OpenCode CLI';
  if (provider === 'kimi-api') return 'Kimi Code API';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'venice') return 'Venice';
  if (provider === 'ollama') return 'Ollama';
  if (provider === 'abacus') return 'Abacus AI';
  if (provider === 'mcp') return 'MCP-backed';
  return provider.split(/[-_]/).filter(Boolean).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ') || 'Provider';
}

function providerBackend(provider: string): string {
  if (provider === 'voidai') return 'openai-compatible';
  if (provider === 'anthropic') return config.claude.backend;
  if (provider === 'codex') return config.codex.backend === 'cli' ? 'codex-cli' : 'codex-api';
  if (provider === 'antigravity') return 'Google Unified Gateway';
  if (provider === 'opencode') return 'opencode-cli';
  if (provider === 'kimi-api') return 'kimi-api';
  if (provider === 'openrouter') return 'openai-compatible';
  if (provider === 'venice') return 'openai-compatible';
  if (provider === 'ollama') return 'openai-compatible';
  if (provider === 'abacus') return 'openai-compatible';
  if (provider === 'mcp') return 'mcp';
  return 'custom';
}

interface ProviderSummary {
  id: string;
  name: string;
  backend: string;
  model: string;
  status: 'online' | 'warn' | 'offline' | 'idle';
  queue: number;
  errors: number;
  rate: string;
  models: number;
  high: number;
  mid: number;
  low: number;
  agents: number;
  configured: boolean;
  refreshable: boolean;
  detail?: string;
}

async function buildProviderSummaries(): Promise<ProviderSummary[]> {
  const db = getDb();
  const catalogRows = listCatalog({ includeUnavailable: true });
  const providerIds = new Set<string>(MODEL_PROVIDERS);
  const agentRows = db.prepare(`
    SELECT provider, COUNT(*) as n
    FROM agents
    WHERE status = 'active'
    GROUP BY provider
  `).all() as Array<{ provider: string | null; n: number }>;

  for (const row of catalogRows) providerIds.add(normalizeProviderKey(row.provider));
  for (const row of agentRows) providerIds.add(normalizeProviderKey(row.provider));

  const agentCounts = new Map<string, number>();
  for (const row of agentRows) {
    const key = normalizeProviderKey(row.provider);
    agentCounts.set(key, (agentCounts.get(key) ?? 0) + row.n);
  }

  const { claudeProbe, codexProbe, antigravityProbe, opencodeProbe } = await getCliProbes();
  const recentClaude429 = countSafe(db, "SELECT COUNT(*) as n FROM hive_mind WHERE action = 'claude_cli_throttled' AND created_at > datetime('now', '-1 hour')");

  const summaries: ProviderSummary[] = Array.from(providerIds).sort((a, b) => {
    const order = new Map<string, number>(MODEL_PROVIDERS.map((p, i) => [p, i]));
    return (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b);
  }).map(provider => {
    const rows = catalogRows.filter(r => normalizeProviderKey(r.provider) === provider && r.is_available);
    const counts = rows.reduce((acc, row) => {
      acc[row.tier] = (acc[row.tier] ?? 0) + 1;
      return acc;
    }, { high: 0, mid: 0, low: 0 } as Record<ModelTier, number>);

    let configured = rows.length > 0;
    let status: ProviderSummary['status'] = rows.length > 0 ? 'online' : 'idle';
    let queue = 0;
    let errors = 0;
    let model = rows[0]?.model_id ?? '—';
    let detail: string | undefined;

    if (provider === 'voidai') {
      configured = !!config.voidai.apiKey.trim();
      model = config.voidai.model || model;
      status = configured ? 'online' : rows.length > 0 ? 'warn' : 'offline';
      detail = configured ? config.voidai.baseURL : 'VOIDAI_API_KEY not set';
    } else if (provider === 'anthropic') {
      configured = config.claude.backend === 'claude-cli' ? !!claudeProbe.ok : config.anthropic.enabled;
      queue = 0;
      errors = recentClaude429;
      model = config.claude.backend === 'claude-cli' ? (claudeProbe.version ?? model) : model;
      status = configured && errors === 0 ? 'online' : configured ? 'warn' : 'offline';
      detail = config.claude.backend === 'claude-cli'
        ? (claudeProbe.error ?? config.claude.cliCommand)
        : (config.anthropic.enabled ? 'ANTHROPIC_API_KEY set' : 'ANTHROPIC_API_KEY not set');
    } else if (provider === 'codex') {
      configured = config.codex.backend === 'cli' ? !!codexProbe.ok : false;
      queue = getCodexCliQueueLength();
      model = config.codex.backend === 'cli' ? (codexProbe.version ?? model) : model;
      status = configured ? 'online' : rows.length > 0 ? 'warn' : 'offline';
      detail = config.codex.backend === 'cli'
        ? (codexProbe.error ?? config.codex.cliCommand)
        : 'CODEX_BACKEND=api is not wired yet';
    } else if (provider === 'antigravity') {
      configured = !!antigravityProbe.ok;
      queue      = getAntigravityQueueLength();
      model      = antigravityProbe.model ?? config.antigravity.model;
      status     = configured ? 'online' : rows.length > 0 ? 'warn' : 'offline';
      detail     = antigravityProbe.ok
        ? `agy ${antigravityProbe.model ?? model}`
        : (antigravityProbe.error ?? 'run `agy` once to authenticate');
    } else if (provider === 'opencode') {
      configured = !!opencodeProbe.ok;
      queue      = getOpencodeCliQueueLength();
      model      = config.opencode.cliCommand;
      status     = configured ? 'online' : rows.length > 0 ? 'warn' : 'offline';
      detail     = opencodeProbe.ok ? (opencodeProbe.binaryPath ?? 'opencode') : (opencodeProbe.error ?? 'opencode binary not found');
    } else if (provider === 'kimi-api') {
      configured = !!(config.kimiApi.apiKey.trim());
      model = config.kimiApi.model || model;
      status = configured ? 'online' : rows.length > 0 ? 'warn' : 'offline';
      detail = config.kimiApi.apiKey.trim()
        ? `api · ${config.kimiApi.model}`
        : 'KIMI_API_KEY not set';
    } else if (provider === 'openrouter') {
      configured = config.openrouter.enabled;
      model = config.openrouter.model || model;
      status = configured ? 'online' : rows.length > 0 ? 'warn' : 'offline';
      detail = configured ? config.openrouter.baseURL : 'OPENROUTER_API_KEY not set';
    } else if (provider === 'venice') {
      configured = config.venice.enabled;
      model = config.venice.model || model;
      status = configured ? 'online' : rows.length > 0 ? 'warn' : 'offline';
      detail = configured ? config.venice.baseURL : 'VENICE_API_KEY not set';
    } else if (provider === 'ollama') {
      configured = true;
      model = config.ollama.model || model;
      status = (agentCounts.get(provider) ?? 0) > 0 ? 'online' : 'idle';
      detail = config.ollama.baseURL;
    } else if (provider === 'abacus') {
      configured = config.abacus.enabled;
      model = config.abacus.model || model;
      status = configured ? 'online' : rows.length > 0 ? 'warn' : 'offline';
      detail = configured ? config.abacus.baseURL : 'ABACUS_API_KEY not set';
    } else if (provider === 'mcp') {
      configured = (agentCounts.get(provider) ?? 0) > 0;
      status = configured ? 'online' : 'idle';
      detail = configured ? 'active MCP-backed agents' : 'no active MCP-backed agents';
    }

    return {
      id: provider,
      name: providerName(provider),
      backend: providerBackend(provider),
      model,
      status,
      queue,
      errors,
      rate: '—',
      models: rows.length,
      high: counts.high ?? 0,
      mid: counts.mid ?? 0,
      low: counts.low ?? 0,
      agents: agentCounts.get(provider) ?? 0,
      configured,
      refreshable: MODEL_PROVIDERS.includes(provider as ModelProvider),
      detail,
    };
  });

  // Append Browserless as a non-model integration card (reads from cache, never probes inline).
  const browserCached = _browserStatusCache;
  const browserStatus: ProviderSummary['status'] = browserCached
    ? (browserCached.status === 'unconfigured' ? 'idle' : browserCached.status)
    : (config.browser.enabled ? 'online' : 'idle');
  summaries.push({
    id:          'browserless',
    name:        'Browserless',
    backend:     'hosted chromium',
    model:       config.browser.url || '—',
    status:      browserStatus,
    queue:       0,
    errors:      0,
    rate:        '—',
    models:      0,
    high:        0,
    mid:         0,
    low:         0,
    agents:      0,
    configured:  config.browser.enabled,
    refreshable: false,
    detail:      config.browser.enabled ? config.browser.url : 'set BROWSERLESS_URL + BROWSERLESS_TOKEN',
  });

  return summaries;
}

function checkScore(state: CoreCheckState): number {
  if (state === 'ok') return 1;
  if (state === 'warn') return 0.62;
  if (state === 'off') return 0.35;
  return 0;
}

function coreStateFor(score: number, checks: Record<string, CoreCheck>): 'awake' | 'degraded' | 'booting' | 'offline' {
  if (checks.router.state === 'fail' || checks.providers.state === 'fail') return 'offline';
  if (Object.values(checks).some(check => check.state === 'fail')) return score >= 0.55 ? 'degraded' : 'booting';
  if (score >= 0.82) return 'awake';
  if (score >= 0.55) return 'degraded';
  if (score > 0.15) return 'booting';
  return 'offline';
}

async function buildCoreStatus() {
  const db = getDb();
  const uptimeSec = Math.round(process.uptime());
  const activeAgents = countSafe(db, "SELECT COUNT(*) as n FROM agents WHERE status = 'active'");
  const permanentAgents = countSafe(db, "SELECT COUNT(*) as n FROM agents WHERE status = 'active' AND temporary = 0");
  const activeSessions = countSafe(db, 'SELECT COUNT(*) as n FROM sessions');
  const pendingTasks = countSafe(db, "SELECT COUNT(*) as n FROM tasks WHERE status IN ('todo','doing','review')");
  const memStats = await (await getMemoryStore()).getStats();
  const memories = memStats.total;
  const memoryLastHour = memStats.lastHour;
  const recent429 = countSafe(db, "SELECT COUNT(*) as n FROM hive_mind WHERE action = 'claude_cli_throttled' AND created_at > datetime('now', '-1 hour')");
  const queueLength = 0;

  const heartbeatRows = db.prepare(`
    SELECT heartbeat_status, heartbeat_latency_ms, last_heartbeat_at, temporary
    FROM agents
    WHERE status = 'active'
  `).all() as Array<{ heartbeat_status: string | null; heartbeat_latency_ms: number | null; last_heartbeat_at: string | null; temporary: number }>;
  const heartbeatOk = heartbeatRows.filter(r => r.heartbeat_status === 'ok').length;
  const heartbeatFail = heartbeatRows.filter(r => r.heartbeat_status === 'fail').length;
  const heartbeatSkipped = heartbeatRows.filter(r => r.heartbeat_status === 'skipped').length;
  const heartbeatUnknown = heartbeatRows.filter(r => !r.heartbeat_status).length;
  const heartbeatLatencies = heartbeatRows
    .map(r => typeof r.heartbeat_latency_ms === 'number' ? r.heartbeat_latency_ms : null)
    .filter((n): n is number => n !== null);
  const avgHeartbeatMs = heartbeatLatencies.length
    ? Math.round(heartbeatLatencies.reduce((a, b) => a + b, 0) / heartbeatLatencies.length)
    : null;

  const { claudeProbe } = await getCliProbes();
  const anthropic = getAnthropicAuthStatus();
  const claudeReady = config.claude.backend === 'claude-cli'
    ? claudeProbe.ok
    : !!process.env.ANTHROPIC_API_KEY?.trim();
  const voidaiReady = !!config.voidai.apiKey.trim();

  const mcpRows = listMcpServers(true);
  const enabledMcp = mcpRows.filter(r => !!r.enabled);
  const readyMcp = enabledMcp.filter(r => r.status === 'ready').length;
  const errorMcp = enabledMcp.filter(r => r.status === 'error').length;
  const totalTools = enabledMcp.reduce((sum, r) => sum + (r.status === 'ready' ? (r.tools_count || 0) : 0), 0);

  const sentinel = getSentinelStatus();
  const catalogModels = countSafe(db, 'SELECT COUNT(*) as n FROM model_catalog WHERE is_available = 1');
  const bgTotal = 6;
  const bgReady = [
    sentinel.enabled,
    config.heartbeat.enabled,
    config.dream.enabled,
    true, // config watcher is started with the dashboard process
    true, // cleanup scheduler is started with the dashboard process
    catalogModels > 0,
  ].filter(Boolean).length;

  const router: CoreCheck = activeAgents > 0
    ? { state: 'ok', label: 'Router', detail: `${activeAgents} active agents · ${sessionQueueManager.activeCount()} active queues`, value: activeAgents }
    : { state: 'fail', label: 'Router', detail: 'no active agents registered', value: 0 };

  const providerState: CoreCheckState = claudeReady && recent429 === 0
    ? 'ok'
    : claudeReady || voidaiReady
      ? 'warn'
      : 'fail';
  const providers: CoreCheck = {
    state: providerState,
    label: 'Providers',
    detail: `${config.claude.backend}${claudeReady ? ' ready' : ' unavailable'} · q${queueLength} · ${recent429} throttles`,
    value: [claudeReady, voidaiReady].filter(Boolean).length,
    total: 2,
  };

  const agentState: CoreCheckState = activeAgents === 0
    ? 'fail'
    : heartbeatFail > 0
      ? 'warn'
      : heartbeatOk > 0 || heartbeatSkipped > 0
        ? 'ok'
        : 'warn';
  const agents: CoreCheck = {
    state: agentState,
    label: 'Agents',
    detail: `${heartbeatOk} ok · ${heartbeatFail} fail · ${heartbeatSkipped} skipped · ${heartbeatUnknown} unknown`,
    value: heartbeatOk + heartbeatSkipped,
    total: activeAgents,
  };

  const memory: CoreCheck = memories > 0
    ? { state: memoryLastHour > 0 ? 'ok' : 'warn', label: 'Memory', detail: `${memories} indexed · ${memoryLastHour}/h`, value: memories }
    : { state: 'off', label: 'Memory', detail: 'memory index is empty', value: 0 };

  const mcp: CoreCheck = enabledMcp.length === 0
    ? { state: 'off', label: 'Tools', detail: 'no MCP servers enabled', value: 0, total: 0 }
    : readyMcp === 0
      ? { state: 'fail', label: 'Tools', detail: `${readyMcp}/${enabledMcp.length} servers ready · ${totalTools} tools`, value: readyMcp, total: enabledMcp.length }
      : readyMcp < enabledMcp.length || errorMcp > 0
        ? { state: 'warn', label: 'Tools', detail: `${readyMcp}/${enabledMcp.length} servers ready · ${totalTools} tools`, value: readyMcp, total: enabledMcp.length }
        : { state: 'ok', label: 'Tools', detail: `${readyMcp}/${enabledMcp.length} servers ready · ${totalTools} tools`, value: readyMcp, total: enabledMcp.length };

  const background: CoreCheck = {
    state: bgReady === bgTotal ? 'ok' : bgReady >= 4 ? 'warn' : 'fail',
    label: 'Daemons',
    detail: `${bgReady}/${bgTotal} schedulers enabled · sentinel ${sentinel.enabled ? 'on' : 'off'}`,
    value: bgReady,
    total: bgTotal,
  };

  const checks = { router, providers, agents, memory, mcp, background };
  const weights: Record<keyof typeof checks, number> = {
    router: 0.2,
    providers: 0.2,
    agents: 0.2,
    memory: 0.15,
    mcp: 0.15,
    background: 0.1,
  };
  const score = Object.entries(checks).reduce((sum, [key, check]) => (
    sum + checkScore(check.state) * weights[key as keyof typeof checks]
  ), 0);

  return {
    state: coreStateFor(score, checks),
    score: Number(score.toFixed(3)),
    checkedAt: new Date().toISOString(),
    uptimeSec,
    checks,
    actions: {
      activeAgents,
      permanentAgents,
      tempAgents: activeAgents - permanentAgents,
      activeSessions,
      pendingTasks,
      queuePressure: queueLength,
      heartbeatOk,
      heartbeatFailures: heartbeatFail,
      heartbeatSkipped,
      heartbeatUnknown,
      avgHeartbeatMs,
      mcpReady: readyMcp,
      mcpTotal: enabledMcp.length,
      mcpTools: totalTools,
      recent429s: recent429,
      memories,
      memoryLastHour,
      backgroundReady: bgReady,
      backgroundTotal: bgTotal,
      dreamLastRun: cfgVal(db, 'dream_last_run'),
      catalogModels,
      claude: {
        backend: config.claude.backend,
        ready: claudeReady,
        version: claudeProbe.version,
        error: claudeProbe.error,
        anthropic,
      },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerApiRoutes(app: Hono<any>): void {
  // ── Inbound webhooks (public — no token) ─────────────────────────────────
  app.post('/webhooks/:slug', async (c) => {
    const slug = c.req.param('slug');
    const job  = getCronJobBySlug(slug);
    if (!job)         return c.json({ error: 'not found' }, 404);
    if (!job.enabled) return c.json({ error: 'job disabled' }, 403);

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    
    // Dedup rapid-fire webhooks with identical payloads
    const bodyHash = hashBody(body);
    if (isWebhookDuplicate(slug, bodyHash)) {
      return c.json({ error: 'duplicate webhook (ignored)', deduped: true }, 200);
    }

    if (job.job_type === 'agent_message') {
      try {
        // Re-read inside a synchronous transaction so concurrent webhook
        // requests for the same slug serialize and each append their own
        // payload rather than one clobbering the other (TOCTOU race).
        getDb().transaction(() => {
          const fresh = getCronJobBySlug(slug);
          if (!fresh) return;
          const cfg = JSON.parse(fresh.config) as { agentId?: string; message?: string; sessionId?: string };
          cfg.message = (cfg.message ?? '') + '\n\nWebhook payload: ' + JSON.stringify(body);
          updateCronJob(fresh.id, { config: JSON.stringify(cfg) });
        })();
      } catch { /* ignore malformed config */ }
    }

    const runId = await executeJobNow(job.id, 'inbound_webhook');
    logHive('cron_inbound_trigger', `dashboard: Inbound webhook fired job "${job.name}"`, undefined, { jobId: job.id, runId, slug });
    return c.json({ runId });
  });

  // ── Public broker webhooks (HMAC-signature gated, no dashboard token) ────
  // Must be registered BEFORE the /api/* auth middleware so external services
  // (Infisical, etc.) can reach /webhooks/broker/* without a dashboard token.
  registerBrokerPublicRoutes(app);

  // ── Cookie Sync CORS — must be registered BEFORE the auth middleware ────
  // The Chrome extension origin (chrome-extension://<id>) must be allowed.
  // This middleware also handles OPTIONS preflight so the extension never hits
  // the auth wall on a preflight request.
  app.use('/api/cookies/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-token');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  // Health check — no token required (extension "Test Connection" button).
  // Registered here, before the /api/* auth middleware, so it runs unauthenticated.
  app.get('/api/cookies/health', (c) => c.json({ ok: true }));

  // ── Auth middleware ──────────────────────────────────────────────────────
  app.use('/api/*', async (c, next) => {
    const cookie = c.req.header('cookie') ?? '';
    const cookieToken = /(?:^|;\s*)dashboard-token=([^;]+)/.exec(cookie)?.[1];
    const token = c.req.query('token') ?? c.req.header('x-dashboard-token') ?? cookieToken ?? '';
    if (!tokenMatches(token, config.dashboard.token)) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });

  // ── NC Broker (secrets) — mounts /api/broker/{agent,admin}/* ────────────
  // Agent routes add an HMAC Bearer check on top of the dashboard token;
  // admin routes inherit dashboard-token gating from the middleware above.
  registerBrokerRoutes(app);

  // ── Status ───────────────────────────────────────────────────────────────
  // Builders shared by the individual routes and the /api/boot aggregation so
  // the snapshot can never drift from what the standalone endpoints return.
  const buildStatusPayload = () => {
    const db = getDb();
    const anthropic = getAnthropicAuthStatus();
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      status:     'online',
      version:    process.env.npm_package_version || '1.0.0',
      checkedAt:  new Date().toISOString(),
      model:      config.voidai.model,
      uptime:     process.uptime(),
      agents:     (db.prepare("SELECT COUNT(*) as n FROM agents WHERE status = 'active'").get() as { n: number }).n,
      sessions:   (db.prepare('SELECT COUNT(*) as n FROM sessions').get() as { n: number }).n,
      messages:   (db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n,
      tempAgents: (db.prepare("SELECT COUNT(*) as n FROM agents WHERE temporary = 1 AND status = 'active'").get() as { n: number }).n,
      parallelSessions: sessionQueueManager.activeCount(),
      process: {
        pid: process.pid,
        memory: {
          rssMb:      Math.round(memory.rss / 1024 / 1024),
          heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
          externalMb: Math.round(memory.external / 1024 / 1024),
        },
        cpuMicros: {
          user:   cpu.user,
          system: cpu.system,
        },
      },
      git: getGitStatusSummary(),
      anthropic,
    };
  };

  const buildClaudeStatusPayload = async () => {
    const probe = await probeClaudeCli();
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
    const recent429 = (getDb().prepare(
      "SELECT COUNT(*) as n FROM hive_mind WHERE action = 'claude_cli_throttled' AND created_at > datetime('now', '-1 hour')"
    ).get() as { n: number }).n;
    return {
      backend:           config.claude.backend,
      cliCommand:        config.claude.cliCommand,
      cliBinaryFound:    probe.ok,
      cliVersion:        probe.version,
      cliError:          probe.error,
      maxTurns:          'unlimited',
      timeoutMs:         config.claude.timeoutMs,
      queueLength:       0,
      retryMax:          config.claude.retryMax,
      retryBaseMs:       config.claude.retryBaseMs,
      anthropicApiKeySet: !!apiKey,
      auth:              getAnthropicAuthStatus(),
      throttled1h:       recent429,
    };
  };

  app.get('/api/status', (c) => c.json(buildStatusPayload()));

  app.get('/api/core/status', async (c) => {
    try {
      return c.json(await getCachedCoreStatus());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/core/wake', async (c) => {
    const results = await Promise.allSettled([
      runHeartbeats(),
      runSentinelScan(),
      (async () => {
        const { probeAll } = await import('../mcp/mcp-registry');
        await probeAll(true);
        return { ok: true };
      })(),
      refreshCatalog('anthropic'),
      refreshCatalog('codex'),
      config.voidai.apiKey.trim() ? refreshCatalog('voidai') : Promise.resolve({ added: 0, updated: 0, missing: 0 }),
    ]);
    const labels = ['heartbeat', 'sentinel', 'mcp', 'catalogAnthropic', 'catalogCodex', 'catalogVoidai'];
    const actions = Object.fromEntries(results.map((r, i) => [
      labels[i],
      r.status === 'fulfilled'
        ? { ok: true, result: r.value }
        : { ok: false, error: (r.reason as Error)?.message ?? String(r.reason) },
    ]));
    return c.json({ ok: results.every(r => r.status === 'fulfilled'), actions, core: await buildCoreStatus() });
  });

  // ── Claude backend status ────────────────────────────────────────────────
  app.get('/api/claude/status', async (c) => c.json(await buildClaudeStatusPayload()));

  // ── Interactive tmux sessions (Studio › Interactive watch view) ───────────
  // Lists the live REPL tmux sessions across both interactive providers
  // (claude-interactive `nc-<id>`, antigravity `nclaw-agy-<hash>`) and captures
  // a session's pane (read-only). Capture validates the name against the live
  // managed list so the endpoint can't dump arbitrary tmux sessions.
  app.get('/api/tmux/sessions', async (c) => {
    return c.json({ sessions: await listManagedSessions() });
  });

  app.get('/api/tmux/sessions/:name/capture', async (c) => {
    const name = c.req.param('name');
    const managed = await listManagedSessions();
    if (!managed.some(s => s.name === name)) return c.json({ error: 'unknown session' }, 404);
    const scrollback = Math.min(2000, Math.max(0, parseInt(c.req.query('scrollback') ?? '200', 10) || 0));
    const alive = await tmuxIsAlive(name);
    return c.json({ name, alive, pane: alive ? await capturePane(name, scrollback) : '' });
  });

  // ── Boot snapshot (Dashboard v3 §3.1) ─────────────────────────────────────
  // One aggregated call that returns exactly what the shell + Overview need on
  // first paint — the server-side join of the 8 primary endpoints. Reuses the
  // same functions/builders the individual routes call, so it can't drift.
  // Limits match today's primary fetches (hive 120, notifications 80) so the
  // bell's unread count and Hive Mind first render see identical windows.
  // Inherits the global /api/* auth guard (?token= / x-dashboard-token).
  app.get('/api/boot', async (c) => {
    const [core, claude] = await Promise.all([
      getCachedCoreStatus().catch(() => null),
      buildClaudeStatusPayload().catch(() => null),
    ]);
    return c.json({
      status:        buildStatusPayload(),
      core,
      agents:        getAllAgents(),
      sessions:      getSessionsWithPreviews(100),
      tasks:         getTasks(),
      hive:          getHiveEvents(120),
      notifications: {
        notifications: getAgentUserMessages({ limit: 80, unreadOnly: false, undismissedOnly: true }),
        unreadCount:   getUnreadAgentUserMessageCount(),
      },
      claude,
    });
  });

  // ── Browserless health ──────────────────────────────────────────────────
  app.get('/api/browser/status', async (c) => {
    const probe = await probeBrowserless();
    return c.json({
      enabled:    config.browser.enabled,
      url:        config.browser.url || null,
      token_set:  !!config.browser.token,
      status:     probe.status,
      latency_ms: probe.latency_ms,
      error:      probe.error,
      cached:     _browserStatusCache?.checked_at === probe.checked_at && Date.now() - _browserStatusCachedAt < BROWSER_STATUS_TTL_MS,
      checked_at: probe.checked_at,
    });
  });

  // ── Provider summaries ──────────────────────────────────────────────────
  app.get('/api/providers', async (c) => {
    try {
      return c.json(await buildProviderSummaries());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/providers/refresh', async (c) => {
    const requested = c.req.query('provider');
    const providers = requested
      ? [requested]
      : [...MODEL_PROVIDERS];

    const invalid = providers.filter(p => !MODEL_PROVIDERS.includes(p as ModelProvider));
    if (invalid.length > 0) {
      return c.json({ error: `Unsupported provider: ${invalid.join(', ')}` }, 400);
    }

    const results = await Promise.allSettled(providers.map(provider => refreshCatalog(provider as ModelProvider)));
    const refreshed = Object.fromEntries(results.map((result, index) => [
      providers[index],
      result.status === 'fulfilled'
        ? { ok: true, ...result.value }
        : { ok: false, error: (result.reason as Error)?.message ?? String(result.reason) },
    ]));
    return c.json({ ok: results.every(r => r.status === 'fulfilled'), refreshed, providers: await buildProviderSummaries() });
  });

  app.get('/api/providers/codex/usage', async (c) => {
    try {
      const snapshot = await fetchCodexUsage();
      return c.json(snapshot);
    } catch (err) {
      return c.json({ ok: false, provider: 'codex', windows: [], error: (err as Error).message }, 500);
    }
  });

  app.get('/api/providers/minimax/usage', async (c) => {
    try {
      const { fetchMinimaxUsage } = await import('../infra/minimax-usage');
      return c.json(await fetchMinimaxUsage());
    } catch (err) {
      return c.json({ ok: false, provider: 'minimax', windows: [], error: (err as Error).message }, 500);
    }
  });

  app.get('/api/providers/kimi/usage', async (c) => {
    try {
      const { fetchKimiUsage } = await import('../infra/kimi-usage');
      return c.json(await fetchKimiUsage());
    } catch (err) {
      return c.json({ ok: false, provider: 'kimi', windows: [], error: (err as Error).message }, 500);
    }
  });

  app.get('/api/providers/antigravity/usage', async (c) => {
    try {
      // Per-model quota windows from Google Code Assist (cloudcode-pa). The old
      // `agy --print /usage` CLI scrape hangs (agy is interactive-only now), so
      // we hit the same backend agy does. See src/infra/antigravity-usage.ts.
      const { fetchAntigravityUsage } = await import('../infra/antigravity-usage');
      const result = await fetchAntigravityUsage();
      // Enrich with the active model as the panel sub-line, when readable.
      try {
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const settingsDir = config.antigravity.settingsDir || path.join(os.homedir(), '.gemini', 'antigravity-cli');
        const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8')) as { model?: string };
        if (settings.model) (result as { plan?: string }).plan = settings.model;
      } catch { /* non-fatal */ }
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, provider: 'antigravity', windows: [], error: (err as Error).message }, 500);
    }
  });

  app.get('/api/providers/claude/usage', async (c) => {
    try {
      const { fetchClaudeUsage } = await import('../infra/claude-usage');
      return c.json(await fetchClaudeUsage());
    } catch (err) {
      return c.json({ ok: false, provider: 'claude', windows: [], error: (err as Error).message }, 500);
    }
  });

  // ── Provider health (WS2 cooldown layer) ──────────────────────────────────
  app.get('/api/providers/health', async (c) => {
    try {
      const { getAllProviderHealth } = await import('../infra/provider-health');
      return c.json({ ok: true, providers: getAllProviderHealth() });
    } catch (err) {
      return c.json({ ok: false, providers: [], error: (err as Error).message }, 500);
    }
  });

  app.post('/api/providers/health/:provider/reset', async (c) => {
    try {
      const { resetProviderHealth } = await import('../infra/provider-health');
      resetProviderHealth(c.req.param('provider'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // ── CLI Tools ────────────────────────────────────────────────────────────
  app.get('/api/cli-tools', (c) => {
    const status = c.req.query('status');
    return c.json(getCliTools(status || undefined));
  });

  app.post('/api/cli-tools', async (c) => {
    let body: { name?: string; slug?: string; description?: string; status?: string; install_command?: string; features?: string[]; tool_order?: number };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.name) return c.json({ error: 'name required' }, 400);
    if (!body.slug) return c.json({ error: 'slug required' }, 400);
    const tool = createCliTool(body as { name: string; slug: string; description?: string; status?: string; install_command?: string; features?: string[]; tool_order?: number });
    return c.json(tool, 201);
  });

  app.patch('/api/cli-tools/:id', async (c) => {
    const existing = getCliTool(c.req.param('id'));
    if (!existing) return c.json({ error: 'Not found' }, 404);
    let body: { name?: string; slug?: string; description?: string | null; status?: string; install_command?: string | null; features?: string[]; tool_order?: number };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    updateCliTool(c.req.param('id'), body);
    return c.json(getCliTool(c.req.param('id')));
  });

  // ── Sessions / Messages ──────────────────────────────────────────────────
  app.get('/api/sessions', (c) => {
    return c.json(getSessionsWithPreviews(100));
  });

  app.get('/api/sessions/search', (c) => {
    const q       = c.req.query('q')?.trim() || undefined;
    const source  = c.req.query('source')?.trim() || undefined;
    const status  = c.req.query('status')?.trim() || undefined;
    const pinnedQ = c.req.query('pinned');
    const pinned  = pinnedQ === undefined ? undefined : pinnedQ === '1' || pinnedQ === 'true';
    const limit   = c.req.query('limit')  ? parseInt(c.req.query('limit')!, 10)  : undefined;
    const offset  = c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : undefined;
    return c.json(searchSessions({
      q, source, status, pinned,
      limit:  Number.isFinite(limit as number)  ? limit  : undefined,
      offset: Number.isFinite(offset as number) ? offset : undefined,
    }));
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
    // Always operate on the resolved internal id (getSessionById accepts external_id too).
    const id = session.id;
    let body: { title?: string; pinned?: unknown; status?: unknown };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) return c.json({ error: 'title must be non-empty' }, 400);
      updateSessionTitle(id, t, 'user'); // manual rename: provenance becomes 'user'
    }
    if (body.pinned !== undefined) {
      setSessionPinned(id, body.pinned === true || body.pinned === 1 || body.pinned === '1');
    }
    if (body.status !== undefined) {
      const s = String(body.status);
      if (s !== 'active' && s !== 'archived') return c.json({ error: "status must be 'active' or 'archived'" }, 400);
      setSessionStatus(id, s);
    }
    return c.json(getSessionById(id));
  });

  app.delete('/api/sessions/:id', async (c) => {
    const session = getSessionById(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const id = session.id;
    // Safe delete: deletes transient rows, detaches analytics/spend/memories,
    // and nullifies runs/tasks/hive_mind/agent_messages (no orphans).
    await deleteSessionWithRelated(id);
    // Drop in-memory per-agent histories for this session (both planes).
    clearHistory(id);
    return c.json({ ok: true });
  });

  // ── Session merge ────────────────────────────────────────────────────────
  // Merges one or more split/orphaned sessions into a single surviving session.
  // Useful when a gateway reset caused the Discord bot to scatter a conversation
  // across multiple session rows before the external_id fix landed (v2.1).
  //
  // Body: { keepSessionId: string, mergeSessionIds: string[], externalId?: string }
  // Response: { merged: number, messagesRehoused: number }
  app.post('/api/sessions/merge', async (c) => {
    let body: { keepSessionId?: string; mergeSessionIds?: unknown; externalId?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const keepId = (body.keepSessionId ?? '').trim();
    if (!keepId) return c.json({ error: 'keepSessionId is required' }, 400);

    if (!Array.isArray(body.mergeSessionIds) || body.mergeSessionIds.length === 0) {
      return c.json({ error: 'mergeSessionIds must be a non-empty array' }, 400);
    }

    const mergeIds: string[] = body.mergeSessionIds
      .map((id: unknown) => String(id).trim())
      .filter(Boolean);

    if (mergeIds.length === 0) {
      return c.json({ error: 'mergeSessionIds contained no valid IDs' }, 400);
    }

    // Validate that the survivor exists.
    const keepSession = getSessionById(keepId);
    if (!keepSession) return c.json({ error: `Session not found: ${keepId}` }, 404);

    // Validate that every source session exists (and is not the survivor itself).
    for (const id of mergeIds) {
      if (id === keepId) return c.json({ error: `mergeSessionIds must not include keepSessionId (${keepId})` }, 400);
      if (!getSessionById(id)) return c.json({ error: `Session not found: ${id}` }, 404);
    }

    const externalId = typeof body.externalId === 'string' ? body.externalId.trim() || null : null;

    const result = mergeSessions(keepId, mergeIds, externalId);
    return c.json(result);
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
    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[]; provider?: string; exec_enabled?: boolean; chat_mode?: boolean; model_tier?: string; skills?: string[]; mcp_server_id?: string; mcp_tool_name?: string; mcp_input_field?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (getDb().prepare('SELECT id FROM agents WHERE name = ? COLLATE NOCASE').get(name)) {
      return c.json({ error: 'An agent with that name already exists' }, 409);
    }

    if (body.provider === 'mcp' && (!body.mcp_server_id || !body.mcp_tool_name)) {
      return c.json({ error: 'provider=mcp requires mcp_server_id and mcp_tool_name' }, 400);
    }

    const provider    = body.provider ?? 'voidai';
    const defaultModel = provider === 'anthropic'
      ? 'claude-sonnet-4-6'
      : provider === 'kimi-api'
          ? config.kimiApi.model
          : provider === 'openrouter'
            ? config.openrouter.model
            : provider === 'venice'
              ? config.venice.model
              : provider === 'ollama'
                ? config.ollama.model
                : provider === 'abacus'
                  ? config.abacus.model
                  : config.voidai.model;
    const agent = createAgentRecord(name, {
      description:  body.description?.trim(),
      systemPrompt: body.system_prompt?.trim(),
      model:        body.model?.trim() || defaultModel,
      role:         body.role ?? 'agent',
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      provider,
      exec_enabled: !!body.exec_enabled,
      chat_mode:    !!body.chat_mode,
      model_tier:   body.model_tier,
      skills:       Array.isArray(body.skills) ? body.skills : undefined,
      mcp_server_id:   body.mcp_server_id ?? null,
      mcp_tool_name:   body.mcp_tool_name ?? null,
      mcp_input_field: body.mcp_input_field ?? null,
    });
    broadcastIntroduction(agent);
    return c.json(agent, 201);
  });

  app.patch('/api/agents/:id', async (c) => {
    const id    = c.req.param('id');
    const agent = getAgentById(id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    let body: { name?: string; description?: string; system_prompt?: string; model?: string; role?: string; capabilities?: string[]; status?: string; provider?: string; exec_enabled?: boolean; chat_mode?: boolean; model_tier?: string; skills?: string[]; vision_mode?: string; vision_provider?: string | null; extra_core_tools?: string[] | null; composio_enabled?: boolean; composio_user_id?: string | null; composio_toolkits?: string[] | null; tts_enabled?: boolean; tts_provider?: string; tts_voice?: string | null; mcp_server_id?: string | null; mcp_tool_name?: string | null; mcp_input_field?: string | null; spawn_exempt?: boolean; avatar_url?: string | null };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    if (agent.name === 'Alfred' && body.name && body.name.trim() !== 'Alfred') {
      return c.json({ error: 'Alfred cannot be renamed' }, 403);
    }
    if (body.name && body.name.trim().toLowerCase() === 'alfred' && agent.name !== 'Alfred') {
      return c.json({ error: "'Alfred' is a reserved agent name" }, 400);
    }
    if (body.name && body.name.trim().length > 100) {
      return c.json({ error: 'Agent name must be 100 characters or fewer' }, 400);
    }
    if (body.system_prompt && body.system_prompt.length > 32_000) {
      return c.json({ error: 'system_prompt must be 32 000 characters or fewer' }, 400);
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
      chat_mode:     body.chat_mode,
      model_tier:    body.model_tier,
      skills:        Array.isArray(body.skills) ? body.skills : undefined,
      vision_mode:   body.vision_mode,
      vision_provider: body.vision_provider,
      extra_core_tools: body.extra_core_tools,
      composio_enabled:  body.composio_enabled,
      composio_user_id:  body.composio_user_id !== undefined ? (body.composio_user_id?.trim() || null) : undefined,
      composio_toolkits: body.composio_toolkits === null
        ? null
        : (Array.isArray(body.composio_toolkits) ? body.composio_toolkits : undefined),
      tts_enabled:   body.tts_enabled,
      tts_provider:  body.tts_provider?.trim(),
      tts_voice:     body.tts_voice === undefined ? undefined : (body.tts_voice ? body.tts_voice.trim() : null),
      mcp_server_id:   body.mcp_server_id,
      mcp_tool_name:   body.mcp_tool_name,
      mcp_input_field: body.mcp_input_field,
      spawn_exempt:    body.spawn_exempt,
      avatar_url:      body.avatar_url !== undefined ? body.avatar_url : undefined,
    });
    return c.json(getAgentById(id));
  });

  app.post('/api/agents/:id/avatar', async (c) => {
    const id = c.req.param('id');
    const agent = getAgentById(id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);
    let form: FormData;
    try { form = await c.req.formData(); } catch { return c.json({ error: 'Invalid form data' }, 400); }
    const file = form.get('image') as File | null;
    if (!file || !file.type.startsWith('image/')) return c.json({ error: 'No valid image provided' }, 400);
    const buf = await file.arrayBuffer();
    if (buf.byteLength > 5 * 1024 * 1024) return c.json({ error: 'Image too large (max 5 MB)' }, 400);
    const ext = (file.name.split('.').pop() ?? 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
    const filename = `${id}-${Date.now()}.${ext}`;
    const dir = path.resolve(process.cwd(), 'uploads', 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from(buf));
    const avatarUrl = `/uploads/avatars/${filename}`;
    updateAgentRecord(id, { avatar_url: avatarUrl });
    return c.json({ ok: true, avatar_url: avatarUrl });
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
    try {
      const result = deleteAgentHard(c.req.param('id'));
      if (!result.ok) return c.json({ error: result.reason ?? 'Cannot delete' }, 400);
      return c.json({ ok: true, hard: true, cleared: result.cleared });
    } catch (err) {
      console.error('[routes] hard delete agent failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'Delete failed' }, 500);
    }
  });

  app.post('/api/agents/:id/activate', (c) => {
    const id = c.req.param('id');
    if (!getAgentById(id)) return c.json({ error: 'Agent not found' }, 404);
    activateAgent(id);
    return c.json({ ok: true });
  });

  // ── Spawn config (runtime-mutable gating settings) ───────────────────────
  app.get('/api/spawn/config', (c) => c.json(getSpawnConfig()));

  app.patch('/api/spawn/config', async (c) => {
    let body: Partial<{ enabled: boolean; maxDepth: number; ttlHours: number; softLimit: number; hardLimit: number; autoApprove: boolean; evalThreshold: number }>;
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (body.maxDepth      !== undefined && (body.maxDepth < 1 || body.maxDepth > 10))            return c.json({ error: 'maxDepth must be 1-10' }, 400);
    if (body.hardLimit     !== undefined && body.softLimit !== undefined && body.hardLimit < body.softLimit) return c.json({ error: 'hardLimit must be >= softLimit' }, 400);
    if (body.evalThreshold !== undefined && (body.evalThreshold < 0 || body.evalThreshold > 1))   return c.json({ error: 'evalThreshold must be 0-1' }, 400);
    setSpawnConfig(body);
    return c.json(getSpawnConfig());
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
    const includeArchived = c.req.query('include_archived') === '1' || c.req.query('include_archived') === 'true';
    return c.json(getTasks(status, { include_archived: includeArchived }));
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

    // Validate status against the canonical set (the tasks.status CHECK
    // constraint) BEFORE the write — otherwise an out-of-set value reaches the
    // SQL UPDATE, trips the CHECK, and throws an unhandled 500.
    if (body.status != null && !TASK_STATUSES.includes(body.status)) {
      return c.json({ error: `invalid status "${String(body.status)}" — must be one of ${TASK_STATUSES.join(', ')}` }, 400);
    }

    try {
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
    } catch (err) {
      return c.json({ error: `update failed: ${(err as Error).message}` }, 400);
    }
    return c.json(getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  });

  app.delete('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    const task = getDb().prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) return c.json({ error: 'not found' }, 404);
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  // Bulk-archive (soft delete). Body { status?: 'todo'|'doing'|'review'|'done' }
  // — omit status to archive EVERY active task (full board wipe). Optional
  // project_id scopes it to one project. Returns how many rows were archived.
  app.post('/api/tasks/archive-all', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const valid = TASK_STATUSES;
    // Safety: only the EXPLICIT absence of status means "archive everything". A
    // present-but-invalid status must NOT silently fall through to a full wipe.
    if (body.status != null && (typeof body.status !== 'string' || !valid.includes(body.status))) {
      return c.json({ ok: false, error: `invalid status "${String(body.status)}" — omit status to archive all` }, 400);
    }
    const status    = typeof body.status === 'string' ? body.status : null;
    const projectId = typeof body.project_id === 'string' ? body.project_id : null;
    const where: string[] = ['archived = 0'];
    const args:  unknown[] = [];
    if (status && valid.includes(status)) { where.push('status = ?');     args.push(status); }
    if (projectId)                        { where.push('project_id = ?'); args.push(projectId); }
    const result = getDb()
      .prepare(`UPDATE tasks SET archived = 1, archived_at = datetime('now'), archived_by = 'dashboard' WHERE ${where.join(' AND ')}`)
      .run(...args);
    return c.json({ ok: true, archived: result.changes });
  });

  // ── Task discipline (hive-mind engagement metrics per agent) ─────────────
  // Reports how much each agent self-drives the task board (claimed / self-updated)
  // vs having work pipeline-assigned, plus their current open task counts.
  app.get('/api/tasks/discipline', (c) => {
    const db = getDb();
    const hive = db.prepare(`
      SELECT agent_id, action, COUNT(*) AS n
      FROM hive_mind
      WHERE action IN ('task_claimed','task_self_updated') AND agent_id IS NOT NULL
      GROUP BY agent_id, action
    `).all() as Array<{ agent_id: string; action: string; n: number }>;
    const taskCounts = db.prepare(`
      SELECT agent_id, status, COUNT(*) AS n
      FROM tasks
      WHERE agent_id IS NOT NULL AND archived = 0
      GROUP BY agent_id, status
    `).all() as Array<{ agent_id: string; status: string; n: number }>;
    const agents = db.prepare(`SELECT id, name FROM agents WHERE status = 'active'`).all() as Array<{ id: string; name: string }>;

    const byAgent = new Map<string, { agentId: string; agentName: string; claimed: number; selfUpdated: number; openTasks: number; byStatus: Record<string, number> }>();
    const ensure = (id: string, name: string) => {
      if (!byAgent.has(id)) byAgent.set(id, { agentId: id, agentName: name, claimed: 0, selfUpdated: 0, openTasks: 0, byStatus: {} });
      return byAgent.get(id)!;
    };
    const nameOf = new Map(agents.map(a => [a.id, a.name]));
    for (const h of hive) {
      const row = ensure(h.agent_id, nameOf.get(h.agent_id) ?? h.agent_id);
      if (h.action === 'task_claimed') row.claimed += h.n;
      else if (h.action === 'task_self_updated') row.selfUpdated += h.n;
    }
    for (const t of taskCounts) {
      const row = ensure(t.agent_id, nameOf.get(t.agent_id) ?? t.agent_id);
      row.byStatus[t.status] = (row.byStatus[t.status] ?? 0) + t.n;
      if (t.status === 'todo' || t.status === 'doing' || t.status === 'review') row.openTasks += t.n;
    }
    const list = [...byAgent.values()].sort((a, b) => (b.claimed + b.selfUpdated) - (a.claimed + a.selfUpdated));
    const totals = list.reduce(
      (acc, r) => ({ claimed: acc.claimed + r.claimed, selfUpdated: acc.selfUpdated + r.selfUpdated, openTasks: acc.openTasks + r.openTasks }),
      { claimed: 0, selfUpdated: 0, openTasks: 0 },
    );
    return c.json({ agents: list, totals });
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

  // ── Docs / Wiki ──────────────────────────────────────────────────────────
  app.get('/api/docs/tree', (c) => {
    return c.json({ ok: true, sections: getWikiTree() });
  });

  app.get('/api/docs/article/:section/:slug', (c) => {
    const section = c.req.param('section');
    const slug    = c.req.param('slug');
    let article;
    try {
      article = getWikiArticle(section, slug);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (!article) {
      return c.json({ error: 'Article not found' }, 404);
    }
    return c.json({ ok: true, article });
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
  app.get('/api/memory/index', async (c) => {
    const limit = intQuery(c.req.query('limit'), 100, 2000);
    const offset = intQuery(c.req.query('offset'), 0);
    const type  = c.req.query('type');
    const sessionId = c.req.query('sessionId');
    // Route through the active memory store (sqlite|supabase). The store has no
    // offset param, so over-fetch limit+offset and slice for pagination.
    const rows = await (await getMemoryStore()).listMemoryIndex({
      limit: limit + offset,
      type: type ?? undefined,
      sessionId: sessionId ?? undefined,
    });
    return c.json(rows.slice(offset, offset + limit));
  });

  app.get('/api/memory/index/stats', async (c) => {
    const store = await getMemoryStore();
    const stats = await store.getStats();
    const total      = stats.total;
    const byType     = (await store.countByType()).map(r => ({ type: r.type, n: r.n }));
    const lastHour   = stats.lastHour;
    const lastDay    = stats.lastDay;
    const db = getDb();
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

  // ── Memory Import ──────────────────────────────────────────────────────────

  app.post('/api/memory/import', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    if (!ct.includes('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data with "file" and "source" fields' }, 400);
    }
    let form: FormData;
    try { form = await c.req.formData(); } catch { return c.json({ error: 'invalid form data' }, 400); }

    const file   = form.get('file');
    const source = (form.get('source') as string | null)?.trim();
    if (!(file instanceof File)) return c.json({ error: 'missing "file" field' }, 400);
    if (!source || !['chatgpt', 'claude_code', 'gemini', 'generic'].includes(source)) {
      return c.json({ error: 'source must be one of: chatgpt, claude_code, gemini, generic' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await startImport(buffer, source as 'chatgpt' | 'claude_code' | 'gemini' | 'generic', file.name);
    if (!result.ok) return c.json({ error: result.reason }, result.httpStatus as 400 | 409 | 413);
    return c.json({ importId: result.importId }, 201);
  });

  app.get('/api/memory/import/watch/:importId', (c) => {
    const importId = c.req.param('importId');
    return streamSSE(c, async (stream) => {
      let closed = false;
      c.req.raw.signal.addEventListener('abort', () => { closed = true; }, { once: true });

      // Send current snapshot immediately (handles page-refresh reconnects).
      const session = getImportSession(importId);
      if (session) {
        if (session.status === 'done') {
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ created: session.created, skipped: session.skipped, total: session.total }) });
          return;
        }
        if (session.status === 'failed') {
          await stream.writeSSE({ event: 'failed', data: JSON.stringify({ error: session.error }) });
          return;
        }
        if (session.status === 'cancelled') {
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ cancelled: true }) });
          return;
        }
        await stream.writeSSE({ event: 'progress', data: JSON.stringify({ processed: session.processed, total: session.total, created: session.created, skipped: session.skipped, status: 'running' }) });
      }

      // Subscribe to live progress events.
      const onProgress = async (data: object) => {
        if (closed) return;
        try { await stream.writeSSE({ event: 'progress', data: JSON.stringify(data) }); } catch { closed = true; }
      };
      const onDone = async (data: object) => {
        if (closed) return;
        try {
          const hasError = (data as Record<string, unknown>).error;
          await stream.writeSSE({ event: hasError ? 'failed' : 'done', data: JSON.stringify(data) });
        } catch { /* client gone */ }
        closed = true;
      };

      importEvents.on(importId, onProgress);
      importEvents.once(`${importId}:done`, onDone);

      // Keep the stream open until the import finishes or client disconnects.
      const keepalive = setInterval(async () => {
        if (closed) { clearInterval(keepalive); return; }
        try { await stream.writeln(':'); } catch { closed = true; clearInterval(keepalive); }
      }, 15_000);

      // Spin until closed.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => { if (closed) { clearInterval(check); resolve(); } }, 200);
      });

      clearInterval(keepalive);
      importEvents.off(importId, onProgress);
      importEvents.off(`${importId}:done`, onDone);
    });
  });

  app.get('/api/memory/import/:importId', (c) => {
    const session = getImportSession(c.req.param('importId'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json(session);
  });

  app.delete('/api/memory/import/:importId', (c) => {
    const ok = cancelImport(c.req.param('importId'));
    if (!ok) return c.json({ error: 'import not found or not running' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/memory/imports', (c) => {
    return c.json(listImportSessions(10));
  });

  // ── Knowledge Base (RAG Docs) ──────────────────────────────────────────────
  // List all indexed sources with page/code counts.
  app.get('/api/kb/sources', async (c) => {
    if (!config.kb.enabled) return c.json({ enabled: false, sources: [] });
    const { listSourcesDetailed } = await import('../kb/kb-search');
    const r = await listSourcesDetailed();
    if (!r.ok) return c.json({ enabled: true, error: r.error, sources: [] }, 502);
    return c.json({ enabled: true, sources: r.sources });
  });

  // Drill into one source: its indexed pages/chunks.
  app.get('/api/kb/sources/:sourceId/pages', async (c) => {
    if (!config.kb.enabled) return c.json({ enabled: false, pages: [], total: 0 });
    const sourceId = decodeURIComponent(c.req.param('sourceId'));
    const limit = parseInt(c.req.query('limit') ?? '200', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const { listSourcePages } = await import('../kb/kb-search');
    const r = await listSourcePages(sourceId, { limit, offset });
    if (!r.ok) return c.json({ enabled: true, error: r.error, pages: [], total: 0 }, 502);
    return c.json({ enabled: true, pages: r.pages, total: r.total });
  });

  app.get('/api/memory/hive', (c) => {
    const limit = intQuery(c.req.query('limit'), 100, 500);
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

  // ── Ollama live models ───────────────────────────────────────────────────────
  app.get('/api/ollama/models', async (c) => {
    try {
      const res = await fetch(`${config.ollama.baseURL}/models`, {
        headers: { Authorization: 'Bearer ollama' },
        signal:  AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return c.json({ ok: false, error: `Ollama returned HTTP ${res.status}`, models: [] });
      }
      const data = await res.json() as { data?: Array<{ id: string }> };
      const models = (data?.data ?? []).map((m: { id: string }) => ({ id: m.id, name: m.id }));
      return c.json({ ok: true, models });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      return c.json({ ok: false, error: msg, models: [] });
    }
  });

  // ── OpenRouter live models (fetches directly from OpenRouter API) ──────────
  app.get('/api/openrouter/models', async (c) => {
    if (!config.openrouter.enabled) {
      return c.json({ 
        ok: false, 
        error: 'OpenRouter not configured (OPENROUTER_API_KEY not set)', 
        models: [],
        debug: {
          hasKey: !!config.openrouter.apiKey,
          keyLength: config.openrouter.apiKey?.length || 0,
          baseURL: config.openrouter.baseURL,
        }
      });
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await getOpenRouterClient().models.list();
      const data = Array.isArray(result?.data) ? result.data : [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const models = data.map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length,
        pricing: m.pricing,
        description: m.description,
        architecture: m.architecture,
        top_provider: m.top_provider,
        // Derive tier from pricing
        tier: (m.pricing?.prompt === '0' || m.pricing?.prompt === 0) ? 'free'
            : parseFloat(m.pricing?.prompt || '0') > 0.005 ? 'high'
            : parseFloat(m.pricing?.prompt || '0') > 0.001 ? 'mid'
            : 'low',
      }));
      return c.json({ ok: true, models, count: models.length });
    } catch (err) {
      const errMsg = (err as Error).message;
      return c.json({ 
        ok: false, 
        error: errMsg, 
        models: [],
        debug: {
          hasKey: !!config.openrouter.apiKey,
          keyLength: config.openrouter.apiKey?.length || 0,
          keyPrefix: config.openrouter.apiKey?.substring(0, 8) || '',
          baseURL: config.openrouter.baseURL,
        }
      }, errMsg.includes('401') ? 401 : 500);
    }
  });

  // Search/filter OpenRouter models
  app.get('/api/openrouter/models/search', async (c) => {
    if (!config.openrouter.enabled) {
      return c.json({ ok: false, error: 'OpenRouter not configured', models: [] });
    }
    const query = (c.req.query('q') || '').toLowerCase();
    const tier = c.req.query('tier'); // free, low, mid, high
    const limit = intQuery(c.req.query('limit'), 100);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await getOpenRouterClient().models.list();
      const data = Array.isArray(result?.data) ? result.data : [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let models = data.map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length,
        pricing: m.pricing,
        description: m.description,
        tier: (m.pricing?.prompt === '0' || m.pricing?.prompt === 0) ? 'free'
            : parseFloat(m.pricing?.prompt || '0') > 0.005 ? 'high'
            : parseFloat(m.pricing?.prompt || '0') > 0.001 ? 'mid'
            : 'low',
      }));
      // Filter by query
      if (query) {
        models = models.filter((m: { id: string; name: string; description?: string }) =>
          m.id.toLowerCase().includes(query) ||
          m.name.toLowerCase().includes(query) ||
          (m.description || '').toLowerCase().includes(query)
        );
      }
      // Filter by tier
      if (tier) {
        models = models.filter((m: { tier: string }) => m.tier === tier);
      }
      return c.json({ ok: true, models: models.slice(0, limit), count: models.length });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, models: [] }, 500);
    }
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
      openrouterViaVoidai: config.heartbeat.openrouterViaVoidai,
      useOllamaProvider: config.heartbeat.useOllamaProvider,
      ollamaProvider: config.heartbeatOllama.enabled
        ? { baseURL: config.heartbeatOllama.baseURL, model: config.heartbeatOllama.model }
        : null,
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

  // ── Autonomous Mission Control loop ──────────────────────────────────────
  app.post('/api/autonomous/start', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const overrides: Record<string, unknown> = {};
      if (typeof body.maxTasks === 'number')               overrides.maxTasks = body.maxTasks;
      if (typeof body.maxMinutes === 'number')             overrides.maxMinutes = body.maxMinutes;
      if (typeof body.maxConsecutiveFailures === 'number') overrides.maxConsecutiveFailures = body.maxConsecutiveFailures;
      if (typeof body.maxTaskAgeDays === 'number')         overrides.maxTaskAgeDays = body.maxTaskAgeDays;
      if (typeof body.projectId === 'string')              overrides.projectId = body.projectId;
      if (typeof body.defaultAgentName === 'string')       overrides.defaultAgentName = body.defaultAgentName;
      overrides.triggeredBy = 'dashboard';
      const result = startAutonomousLoop(overrides);
      return c.json(result, result.ok ? 200 : 409);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/autonomous/stop', (c) => {
    const result = stopAutonomousLoop();
    return c.json(result, result.ok ? 200 : 409);
  });

  app.get('/api/autonomous/status', (c) => {
    return c.json(getAutonomousStatus());
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

  app.get('/api/dream/history', (c) => {
    const db = getDb();
    const completes = db.prepare(`
      SELECT id, metadata, created_at FROM hive_mind
      WHERE action = 'dream_cycle_complete'
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as { id: string; metadata: string | null; created_at: string }[];

    const totalCount = (db.prepare(`
      SELECT COUNT(*) as n FROM hive_mind WHERE action = 'dream_cycle_complete'
    `).get() as { n: number }).n;

    const entries = completes.map((row, i) => {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(row.metadata ?? '{}'); } catch { /* ignore bad JSON */ }
      const vaultPaths = (meta.vaultPaths as { procedures: string[]; insights: string[]; log: string | null; plan: string | null }) ?? { procedures: [], insights: [], log: null, plan: null };
      return {
        id:          row.id,
        number:      totalCount - i,
        startedAt:   (meta.startedAt  as string)  ?? row.created_at,
        completedAt: (meta.completedAt as string)  ?? row.created_at,
        durationMs:  (meta.durationMs  as number)  ?? 0,
        status:      (meta.ok as boolean) === false
          ? 'failed'
          : (meta.errors as string[] | undefined)?.length
            ? 'partial'
            : 'complete',
        scope:       (meta.scope       as Record<string, number>) ?? {},
        output:      (meta.output      as Record<string, number>) ?? {},
        vaultPaths,
        errors:      (meta.errors      as string[]) ?? [],
        planNote:    null,
      };
    });

    return c.json({ history: entries });
  });

  // ── Sentinel ─────────────────────────────────────────────────────────────
  app.get('/api/sentinel/status', (c) => {
    return c.json(getSentinelStatus());
  });

  app.get('/api/sentinel/active', (c) => {
    return c.json(getActiveSentinelEscalations());
  });

  app.post('/api/sentinel/run', async (c) => {
    try {
      const result = await runSentinelScan();
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // ── Background agents roster ──────────────────────────────────────────────
  app.get('/api/bg-agents', (c) => {
    const db = getDb();

    function cfgVal(key: string): string | null {
      return (db.prepare('SELECT value FROM config_items WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
    }

    const sentinelStatus = getSentinelStatus();
    const catalogCount   = db.prepare('SELECT COUNT(*) AS n FROM model_catalog WHERE is_available = 1').get() as { n: number } | undefined;
    const expiredCount   = db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'agent_expired'").get() as { n: number };
    const lastDream      = cfgVal('dream_last_run');
    const lastCatalog    = cfgVal('catalog_last_refresh');
    const lastEnvReload  = cfgVal('config_watcher_last_reload');

    const agents = [
      {
        key:         'sentinel',
        name:        'Sentinel',
        description: 'Monitors stalled tasks and escalates intelligently',
        enabled:     sentinelStatus.enabled,
        lastRunAt:   sentinelStatus.lastRun,
        nextRunAt:   sentinelStatus.nextRun,
        intervalSec: sentinelStatus.intervalSec,
        keyStat:     { label: 'check-ins sent', value: sentinelStatus.checkInsTotal },
        avatar:      cfgVal('bg_agent_avatar_sentinel'),
      },
      {
        key:         'heartbeat',
        name:        'Heartbeat',
        description: 'Periodic 1-token LLM ping to keep agent connections warm',
        enabled:     true,
        lastRunAt:   cfgVal('heartbeat_last_run'),
        nextRunAt:   null,
        intervalSec: parseInt(process.env.HEARTBEAT_INTERVAL_SEC ?? '60', 10) || 60,
        keyStat:     {
          label: 'agents monitored',
          value: (db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status = 'active' AND temporary = 0").get() as { n: number } | undefined)?.n ?? 0,
        },
        avatar:      cfgVal('bg_agent_avatar_heartbeat'),
      },
      {
        key:         'dream',
        name:        'Dream Cycle',
        description: 'Nightly memory consolidation — episodic → semantic, prune noise, day plan',
        enabled:     process.env.DREAM_ENABLED !== 'false',
        lastRunAt:   lastDream,
        nextRunAt:   null,
        intervalSec: null,
        keyStat:     { label: 'last run', value: lastDream ? new Date(lastDream).toLocaleDateString() : 'never' },
        avatar:      cfgVal('bg_agent_avatar_dream'),
      },
      {
        key:         'config_watcher',
        name:        'Config Watcher',
        description: 'Polls .env every 2s for changes and hot-reloads API keys',
        enabled:     true,
        lastRunAt:   lastEnvReload,
        nextRunAt:   null,
        intervalSec: 2,
        keyStat:     { label: 'last reload', value: lastEnvReload ? new Date(lastEnvReload).toLocaleTimeString() : 'never' },
        avatar:      cfgVal('bg_agent_avatar_config_watcher'),
      },
      {
        key:         'cleanup',
        name:        'Cleanup Scheduler',
        description: 'Expires temporary agents past their TTL, runs every 5 minutes',
        enabled:     true,
        lastRunAt:   cfgVal('cleanup_last_run'),
        nextRunAt:   null,
        intervalSec: 300,
        keyStat:     { label: 'agents expired (lifetime)', value: expiredCount.n },
        avatar:      cfgVal('bg_agent_avatar_cleanup'),
      },
      {
        key:         'model_catalog',
        name:        'Model Catalog',
        description: 'Refreshes available models from provider APIs hourly',
        enabled:     true,
        lastRunAt:   lastCatalog,
        nextRunAt:   null,
        intervalSec: 3600,
        keyStat:     { label: 'available models', value: catalogCount?.n ?? 0 },
        avatar:      cfgVal('bg_agent_avatar_model_catalog'),
      },
      {
        key:         'stephanie',
        name:        'Stephanie',
        description: 'Monitors agent load distribution and recommends team restructuring',
        enabled:     true,
        lastRunAt:   cfgVal('stephanie_last_run'),
        nextRunAt:   cfgVal('stephanie_next_run'),
        intervalSec: null,
        cron:        (() => { try { return getStephanieStatus().cron; } catch { return null; } })(),
        keyStat:     (() => {
          const st = getStephanieStatus();
          const warn = (st.alertCounts.warn ?? 0) + (st.alertCounts.critical ?? 0);
          return { label: 'open alerts', value: warn };
        })(),
        avatar:      cfgVal('bg_agent_avatar_stephanie'),
      },
      {
        key:         'session_cleanup',
        name:        'Session Cleanup',
        description: 'Purges stale sessions hourly — comms, dashboard chats, spawns (preserves Discord)',
        enabled:     (() => { const st = getSessionCleanupStatus(); return st.enabled; })(),
        lastRunAt:   cfgVal('session_cleanup_last_run'),
        nextRunAt:   null,
        intervalSec: 3600,
        keyStat:     (() => {
          const st = getSessionCleanupStatus();
          return { label: 'sessions cleaned', value: st.lifetimeSessionsCleaned };
        })(),
        avatar:      cfgVal('bg_agent_avatar_session_cleanup'),
      },
      {
        key:         'db_backup',
        name:        'DB Backup',
        description: 'Daily database backup with 7-day retention',
        enabled:     (() => { const st = getBackupStatus(); return st.enabled; })(),
        lastRunAt:   (() => { const st = getBackupStatus(); return st.lastBackup?.createdAt?.toISOString() ?? null; })(),
        nextRunAt:   (() => { const st = getBackupStatus(); return st.nextBackupAt; })(),
        intervalSec: 86400, // 24 hours
        keyStat:     (() => {
          const st = getBackupStatus();
          return { label: 'backups kept', value: st.backupCount };
        })(),
        avatar:      cfgVal('bg_agent_avatar_db_backup'),
      },
      {
        key:         'herald',
        name:        'Herald',
        description: 'Broadcasts introduction messages to all active agents when a new agent joins the team',
        enabled:     true,
        lastRunAt:   (() => {
          const row = db.prepare("SELECT created_at FROM hive_mind WHERE action = 'agent_introduced' ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | undefined;
          return row?.created_at ?? null;
        })(),
        nextRunAt:   null,
        intervalSec: null,
        keyStat:     {
          label: 'intros sent (lifetime)',
          value: (db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE from_name = 'Herald'").get() as { n: number } | undefined)?.n ?? 0,
        },
        avatar:      cfgVal('bg_agent_avatar_herald'),
      },
      {
        key:         'task_archivist',
        name:        'Task Archivist',
        description: 'Auto-archives done tasks older than 24h, sweeps every 30 minutes',
        enabled:     true,
        lastRunAt:   (() => {
          const row = db.prepare("SELECT created_at FROM hive_mind WHERE action = 'tasks_archived' ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | undefined;
          return row?.created_at ?? null;
        })(),
        nextRunAt:   null,
        intervalSec: 1800,
        keyStat:     {
          label: 'tasks archived (lifetime)',
          value: (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE archived = 1 AND archived_by = 'task-archivist'").get() as { n: number } | undefined)?.n ?? 0,
        },
        avatar:      cfgVal('bg_agent_avatar_task_archivist'),
      },
      {
        key:         'curator',
        name:        'Curator',
        description: 'Nightly memory backstop — archives memories from every session not yet fully captured, with no length truncation',
        enabled:     true,
        lastRunAt:   (() => {
          const row = db.prepare("SELECT created_at FROM hive_mind WHERE action = 'memory_sweep_completed' ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | undefined;
          return row?.created_at ?? null;
        })(),
        nextRunAt:   null,
        intervalSec: null,
        keyStat:     {
          label: 'sessions archived (lifetime)',
          value: (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE archived_at IS NOT NULL").get() as { n: number } | undefined)?.n ?? 0,
        },
        avatar:      cfgVal('bg_agent_avatar_curator'),
      },
    ];

    return c.json(agents);
  });

  app.patch('/api/bg-agents/:key/avatar', async (c) => {
    const key = c.req.param('key');
    const validKeys = ['sentinel', 'heartbeat', 'dream', 'config_watcher', 'cleanup', 'model_catalog', 'stephanie', 'session_cleanup', 'db_backup', 'curator'];
    if (!validKeys.includes(key)) return c.json({ error: 'unknown agent key' }, 400);

    let body: { avatar?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const avatar = (body.avatar ?? '').trim();
    if (!avatar) return c.json({ error: 'avatar is required' }, 400);
    if (avatar.length > 500_000) return c.json({ error: 'avatar too large (max 500KB)' }, 400);
    const isValidAvatar =
      avatar.startsWith('data:image/') ||
      avatar.startsWith('https://') ||
      avatar.startsWith('http://') ||
      avatar.startsWith('/');
    if (!isValidAvatar) return c.json({ error: 'avatar must be a URL or data:image/ URI' }, 400);

    getDb().prepare(
      `INSERT INTO config_items (key, value, description)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(`bg_agent_avatar_${key}`, avatar, `bg agent avatar: ${key}`);

    return c.json({ ok: true, key });
  });

  // ── Session Cleanup manual trigger ─────────────────────────────────────────
  app.get('/api/session-cleanup/status', (c) => {
    return c.json(getSessionCleanupStatus());
  });

  app.get('/api/session-cleanup/stats', (c) => {
    return c.json(getSessionStats());
  });

  app.post('/api/session-cleanup/run', async (c) => {
    try {
      const result = await cleanupStaleSessions();
      return c.json({
        ok: true,
        deleted: result.deleted,
        messagesDeleted: result.messagesDeleted,
        forced: result.forced,
        archived: result.archived,
      });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // ── Database Backup ────────────────────────────────────────────────────────
  app.get('/api/backup/status', (c) => {
    return c.json(getBackupStatus());
  });

  app.get('/api/backup/list', (c) => {
    return c.json(listBackups());
  });

  app.post('/api/backup/run', async (c) => {
    try {
      const result = await performBackup();
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // ── Analyst / Stephanie ───────────────────────────────────────────────────

  app.get('/api/analyst/alerts', (c) => {
    const unreadOnly = c.req.query('unread') === 'true';
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
    return c.json(listAnalystAlerts({ unreadOnly, limit }));
  });

  app.post('/api/analyst/alerts/:id/dismiss', async (c) => {
    const id = c.req.param('id');
    const result = dismissAnalystAlert(id);
    if (result === 'not_found') return c.json({ error: 'alert not found' }, 404);
    if (result === 'already_dismissed') return c.json({ error: 'alert already dismissed' }, 409);
    return c.json({ ok: true });
  });

  app.post('/api/analyst/run', async (c) => {
    try {
      await runStephanieAnalysis();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/analyst/status', (c) => {
    return c.json(getStephanieStatus());
  });

  app.get('/api/commands', (c) => {
    return c.json(getCommandCatalog('dashboard'));
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

  // Skill telemetry (Pillar 3 of MED skill plan) — passive, read-only.
  // Returns one row per skill with fire count + last-used timestamp + tier
  // breakdown. The UI merges this against listSkills() so dormant skills
  // show as "never fired". We deliberately put this BEFORE /api/skills/:name
  // so Hono doesn't route "telemetry" as a skill name.
  app.get('/api/skills/telemetry', (c) => {
    const rows = getSkillTelemetry();
    // Index by name for O(1) merge on the client. Caller can rebuild a list
    // from this map if they prefer.
    const byName: Record<string, typeof rows[number]> = {};
    for (const r of rows) byName[r.skill_name] = r;
    return c.json({
      rows,
      byName,
      total_invocations: rows.reduce((acc, r) => acc + r.fire_count, 0),
      tracked_skills:    rows.length,
    });
  });

  // Skill collision audit (Pillar 4) — surfaces overlapping descriptions across
  // the entire live catalog. Hint-only; nothing is blocked or pruned. Run on
  // demand from the Skills page "Audit overlaps" button or via the SPA on load.
  app.get('/api/skills/collisions', (c) => {
    const threshold = parseFloat(c.req.query('threshold') ?? '0.5');
    const { listAllCollisions } = require('../skills/collisions') as typeof import('../skills/collisions');
    const pairs = listAllCollisions(Number.isFinite(threshold) ? threshold : 0.5);
    return c.json({ pairs, threshold });
  });

  // Single-shot collision check used by the Skills edit form. Pass a draft
  // description; returns the top-N existing skills with overlapping descriptions
  // above the threshold. Empty array means no collisions worth mentioning.
  app.post('/api/skills/check-collision', async (c) => {
    let body: { name?: string; description?: string; threshold?: number; limit?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
    if (!body.description || typeof body.description !== 'string') {
      return c.json({ error: '`description` is required' }, 400);
    }
    const { checkCollision } = require('../skills/collisions') as typeof import('../skills/collisions');
    const hits = checkCollision({
      name:        body.name,
      description: body.description,
      threshold:   typeof body.threshold === 'number' ? body.threshold : undefined,
      limit:       typeof body.limit     === 'number' ? body.limit     : undefined,
    });
    return c.json({ hits });
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
      await syncSkillExports();
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
      await syncSkillExports();
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
      await syncSkillExports();
      return c.json(summary);
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  app.delete('/api/skills/:name', async (c) => {
    try {
      deleteSkill(c.req.param('name'));
      await syncSkillExports();
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
      await syncSkillExports();
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
    await syncSkillExports();

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
      await syncSkillExports();
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
      await syncSkillExports();
      return c.json({ ok: true, ...result });
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

  app.delete('/api/skills/:name/scripts/:filename', async (c) => {
    try {
      deleteSkillScript(c.req.param('name'), c.req.param('filename'));
      await syncSkillExports();
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

  // ── Composio connections panel ────────────────────────────────────────────
  //
  // Backs /dashboard/connections. Lists every connected account with our
  // dashboard-managed owner/shared metadata merged in, plus the pending
  // queue (T2 conflicts + T3 admin approvals). The agent-side enforcement
  // happens in src/composio/connection-policy.ts; these routes are the
  // user-facing manual override layer.
  app.get('/api/composio/connections', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    try {
      const { listAccountsWithMeta } = await import('../composio/connection-policy');
      const { tierFor, tierLabel }    = await import('../composio/tier-policy');
      const accounts = await listAccountsWithMeta();
      return c.json({
        ok: true,
        accounts: accounts.map(a => ({
          id:         a.id,
          toolkit:    a.toolkit,
          owner:      a.owner,
          shared:     a.shared,
          status:     a.status,
          tier:       tierFor(a.toolkit),
          tierLabel:  tierLabel(tierFor(a.toolkit)),
        })),
      });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.patch('/api/composio/connections/:id', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    let body: { owner?: string | null; shared?: boolean; toolkit?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    try {
      const { setAccountMeta, listAccountsWithMeta } = await import('../composio/connection-policy');
      // We need the toolkit slug to upsert the meta row when it doesn't exist yet.
      const id  = c.req.param('id');
      const all = await listAccountsWithMeta();
      const existing = all.find(a => a.id === id);
      if (!existing) return c.json({ ok: false, error: 'connection not found' }, 404);

      setAccountMeta({
        account_id: id,
        toolkit:    body.toolkit ?? existing.toolkit,
        owner:      body.owner   !== undefined ? body.owner   : undefined,
        shared:     body.shared  !== undefined ? body.shared  : undefined,
      });
      // Any change to a connection means cached sessions wired to it are stale.
      const { clearComposioSessionCache } = await import('../composio/client');
      clearComposioSessionCache();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.delete('/api/composio/connections/:id', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    try {
      const { deleteConnectedAccount } = await import('../composio/client');
      await deleteConnectedAccount(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/composio/auth-configs', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    try {
      const { listAuthConfigs } = await import('../composio/client');
      const configs = await listAuthConfigs();
      return c.json({ ok: true, configs });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // POST /api/composio/connections/initiate — start OAuth for a specific user.
  // The dashboard collects (userId, authConfigId) from the UI, we ask
  // Composio for a redirect URL, then the user completes OAuth in a popup /
  // new tab. Upon success Composio redirects back to our callback URL where
  // we stamp the owner.
  app.post('/api/composio/connections/initiate', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    let body: { userId?: string; authConfigId?: string; toolkit?: string; share?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    if (!body.userId)        return c.json({ ok: false, error: 'userId required' }, 400);
    if (!body.authConfigId)  return c.json({ ok: false, error: 'authConfigId required' }, 400);
    try {
      const { initiateConnection } = await import('../composio/client');
      const { setAccountMeta }     = await import('../composio/connection-policy');
      const r = await initiateConnection({ userId: body.userId, authConfigId: body.authConfigId });

      // Eagerly stamp the dashboard-meta with the owner we already know.
      // Composio's webhook callback will fire when OAuth actually completes
      // and we'll update status+toolkit then.
      if (r.accountId) {
        setAccountMeta({
          account_id: r.accountId,
          toolkit:    body.toolkit ?? 'unknown',
          owner:      body.userId,
          shared:     !!body.share,
        });
      }
      return c.json({ ok: true, redirectUrl: r.redirectUrl, accountId: r.accountId });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // Composio fires this after the user finishes OAuth. We use it to stamp
  // owner / shared metadata and apply the tier policy. The callback payload
  // shape isn't 100% stable across SDK versions, so we defensively pull from
  // body OR query params.
  //
  // SECURITY NOTE: this endpoint is unauthenticated by design — Composio
  // calls it from the public internet. Treat the body as untrusted; never
  // trust the `owner` field from here, only the connection IDs.
  app.post('/api/composio/connect/callback', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = {};
    try { body = await c.req.json(); } catch { /* might be GET-style query payload */ }
    const accountId = String(body.connectedAccountId ?? body.connected_account_id ?? body.id ?? c.req.query('connectedAccountId') ?? '');
    if (!accountId) {
      logger.warn('composio callback received without an account id', { body });
      return c.json({ ok: false, error: 'connectedAccountId missing' }, 400);
    }
    try {
      // Live-fetch the canonical record from Composio to verify what was
      // actually connected (and to discover the real toolkit slug).
      const { listAccountsWithMeta, setAccountMeta } = await import('../composio/connection-policy');
      const accounts = await listAccountsWithMeta();
      const fresh = accounts.find(a => a.id === accountId);
      if (!fresh) {
        logger.warn('composio callback: account not visible to our API key', { accountId });
        return c.json({ ok: false, error: 'account not visible to this project key' }, 404);
      }
      // If the dashboard already eagerly-stamped meta during initiate(), this
      // is a no-op except for status sync. If not (callback came from an
      // agent-driven manage-connections flow), we'll attempt to read
      // user_id from the Composio record so we can stamp owner.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = fresh.rawComposio ?? {};
      const ownerFromComposio = String(raw.user_id ?? raw.userId ?? raw.entity_id ?? '').trim() || null;
      setAccountMeta({
        account_id: accountId,
        toolkit:    fresh.toolkit,
        owner:      fresh.owner ?? ownerFromComposio,
        // shared status is dashboard-managed; never auto-toggle from the callback.
        shared:     fresh.shared,
      });
      logger.info('composio callback: account meta updated', {
        accountId,
        toolkit: fresh.toolkit,
        owner:   fresh.owner ?? ownerFromComposio,
        status:  fresh.status,
      });
      const { clearComposioSessionCache } = await import('../composio/client');
      clearComposioSessionCache();
      return c.json({ ok: true });
    } catch (err) {
      logger.warn('composio callback handler failed', { error: (err as Error).message });
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/composio/pending', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    try {
      const { listPendingConnections } = await import('../composio/connection-policy');
      const includeResolved = c.req.query('include_resolved') === '1';
      const pending = listPendingConnections(includeResolved ? { resolved: true } : { resolved: false });
      return c.json({ ok: true, pending });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/composio/pending/:id/resolve', async (c) => {
    if (!config.composio.enabled) return c.json({ ok: false, error: 'Composio not configured' }, 400);
    let body: { resolution?: 'use_existing_shared' | 'create_new_owned' | 'rejected'; resolved_by?: string; share_existing?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    if (!body.resolution) return c.json({ ok: false, error: 'resolution required' }, 400);
    try {
      const { resolvePending, setAccountMeta, listPendingConnections, listAccountsWithMeta } = await import('../composio/connection-policy');
      const pending = listPendingConnections({ resolved: true }).find(p => p.id === c.req.param('id'));
      // Side effect: if the user picked "use_existing_shared" and supplied
      // share_existing=true, flip the meta to shared at the same time.
      if (body.share_existing && body.resolution === 'use_existing_shared' && pending?.conflict_account) {
        const all = await listAccountsWithMeta();
        const acc = all.find(a => a.id === pending.conflict_account);
        if (acc) setAccountMeta({ account_id: acc.id, toolkit: acc.toolkit, shared: true });
      }
      const ok = resolvePending({
        id:          c.req.param('id'),
        resolution:  body.resolution,
        resolved_by: body.resolved_by ?? 'user',
      });
      if (!ok) return c.json({ ok: false, error: 'pending not found or already resolved' }, 404);
      const { clearComposioSessionCache } = await import('../composio/client');
      clearComposioSessionCache();
      return c.json({ ok: true });
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

    let body: { name?: string; token?: string; default_agent?: string; application_id?: string; enabled?: boolean; auto_reply_guilds?: string[] | null; voice_enabled?: boolean; voice_channel_enabled?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }

    const fields: Parameters<typeof updateDiscordBot>[1] = {};
    if (body.name !== undefined)               fields.name = body.name.trim();
    if (body.token !== undefined)              fields.token = body.token.trim();
    if (body.application_id !== undefined)     fields.application_id = body.application_id?.trim() || null;
    if (body.enabled !== undefined)            fields.enabled = body.enabled;
    if (body.auto_reply_guilds !== undefined)  fields.auto_reply_guilds = body.auto_reply_guilds;
    if (body.voice_enabled !== undefined)         fields.voice_enabled = body.voice_enabled;
    if (body.voice_channel_enabled !== undefined) fields.voice_channel_enabled = !!body.voice_channel_enabled;
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

  app.post('/api/discord/bots/:id/restart', async (c) => {
    const { getDiscordBot } = await import('../db');
    const { restartBot } = await import('../integrations/discord-bot');
    const id = c.req.param('id');
    const bot = getDiscordBot(id);
    if (!bot) return c.json({ ok: false, error: 'bot not found' }, 404);
    if (!bot.enabled) return c.json({ ok: false, error: 'bot is disabled' }, 409);
    try {
      await restartBot(id);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
    return c.json({ ok: true });
  });

  app.get('/api/discord/bots/:id/skills', async (c) => {
    const { getDiscordBotSkills } = await import('../db');
    return c.json(getDiscordBotSkills(c.req.param('id')));
  });

  app.put('/api/discord/bots/:id/skills/:skill', async (c) => {
    const { addDiscordBotSkill } = await import('../db');
    addDiscordBotSkill(c.req.param('id'), c.req.param('skill'));
    return c.json({ ok: true });
  });

  app.delete('/api/discord/bots/:id/skills/:skill', async (c) => {
    const { removeDiscordBotSkill } = await import('../db');
    removeDiscordBotSkill(c.req.param('id'), c.req.param('skill'));
    return c.json({ ok: true });
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
    let body: { channel_id?: string; agent?: string; require_mention?: boolean; auto_reply?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    if (!body.channel_id || !body.agent) return c.json({ ok: false, error: 'channel_id and agent are required' }, 400);
    const agent = getAgentById(body.agent) ?? getAgentByName(body.agent);
    if (!agent) return c.json({ ok: false, error: `agent "${body.agent}" not found` }, 404);
    const route = upsertDiscordRoute(id, body.channel_id.trim(), agent.id, body.require_mention, body.auto_reply);
    reloadDiscordBots().catch(() => { /* fire and forget */ });
    return c.json({ ok: true, route });
  });

  app.patch('/api/discord/routes/:id', async (c) => {
    const { setDiscordRouteRequireMention, setDiscordRouteAutoReply } = await import('../db');
    const { reloadDiscordBots } = await import('../integrations/discord-bot');
    let body: { require_mention?: boolean; auto_reply?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ ok: false, error: 'invalid JSON' }, 400); }
    if (body.require_mention === undefined && body.auto_reply === undefined) {
      return c.json({ ok: false, error: 'require_mention or auto_reply is required' }, 400);
    }
    if (body.require_mention !== undefined) {
      if (typeof body.require_mention !== 'boolean') return c.json({ ok: false, error: 'require_mention must be a boolean' }, 400);
      setDiscordRouteRequireMention(c.req.param('id'), body.require_mention);
    }
    if (body.auto_reply !== undefined) {
      if (typeof body.auto_reply !== 'boolean') return c.json({ ok: false, error: 'auto_reply must be a boolean' }, 400);
      setDiscordRouteAutoReply(c.req.param('id'), body.auto_reply);
    }
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

  app.get('/api/models/spend', (c) => {
    return c.json({
      lastHour:    spendLastHourWithCost(),
      byTier:      spendByTierLastHour(),
      byModel:     spendByModelLastHour(20),
    });
  });

  app.delete('/api/memory/index/:id', async (c) => {
    const id = c.req.param('id');
    const store = await getMemoryStore();
    const exists = await store.getMemoryIndexById(id);
    if (!exists) return c.json({ error: 'Memory not found' }, 404);
    await store.deleteMemory(id);
    return c.json({ ok: true });
  });
    app.get('/api/analytics', (c) => { try { return c.json(getAnalyticsSummary()); } catch(e) { console.error('Analytics:',e); return c.json({error:String(e)},500); } });
  
  // System health analytics - errors, disconnects, restarts tracking
  app.get('/api/analytics/health', (c) => {
    try {
      return c.json(getSystemHealthStats());
    } catch (e) {
      console.error('Analytics health:', e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // Recent errors for dashboard display
  app.get('/api/analytics/errors', (c) => {
    try {
      const limit = intQuery(c.req.query('limit'), 50);
      return c.json(getRecentErrors(Math.min(limit, 200)));
    } catch (e) {
      console.error('Analytics errors:', e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // Message activity sparkline (24h hourly)
  app.get('/api/analytics/sparkline', (c) => {
    try {
      return c.json(getMessageSparkline());
    } catch (e) {
      console.error('Analytics sparkline:', e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // Top tools used
  app.get('/api/analytics/tools', (c) => {
    try {
      const limit = intQuery(c.req.query('limit'), 10);
      return c.json(getTopTools(Math.min(limit, 50)));
    } catch (e) {
      console.error('Analytics tools:', e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // Activity heatmap
  app.get('/api/analytics/heatmap', (c) => {
    try {
      return c.json(getActivityHeatmap());
    } catch (e) {
      console.error('Analytics heatmap:', e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // Usage by provider and agent
  app.get('/api/analytics/usage', (c) => {
    try {
      const raw = parseInt(c.req.query('hours') ?? '24', 10);
      const hours = Math.min(720, Math.max(1, isNaN(raw) ? 24 : raw));
      return c.json({
        byProvider:      spendByProvider(hours),
        byProviderAgent: spendByProviderAndAgent(hours),
      });
    } catch (e) {
      console.error('Analytics usage:', e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // ── Health endpoints ──────────────────────────────────────────────────────

  app.get('/api/health/summary', (c) => {
    try { return c.json(getHealthSummary()); }
    catch (e) { return c.json({ error: String(e) }, 500); }
  });

  app.get('/api/health/downtime', (c) => {
    try {
      const days = Math.min(90, parseInt(c.req.query('days') || '30', 10));
      return c.json(getDowntimeEvents(days));
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  app.get('/api/health/timeline', (c) => {
    try {
      const days = Math.min(30, parseInt(c.req.query('days') || '7', 10));
      return c.json(getUptimeTimeline(days));
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  app.get('/api/logs',      (c) => c.json(getRecentLogs()));

  app.get('/api/logs/debug', (c) => {
    const limit      = Math.min(parseInt(c.req.query('limit') ?? '500', 10) || 500, 1000);
    const source     = c.req.query('source')     ?? undefined;
    const session_id = c.req.query('session_id') ?? undefined;
    const agent_id   = c.req.query('agent_id')   ?? undefined;
    return c.json(getDebugLogs({ limit, source, session_id, agent_id }));
  });

  // ── Live log tail ─────────────────────────────────────────────────────────
  app.get('/api/logs/tail', (c) => {
    const limit    = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500);
    const srcParam = c.req.query('src');
    const contains = c.req.query('contains') || undefined;
    if (srcParam || contains) {
      const srcValues = srcParam ? srcParam.split(',').map(s => s.trim()).filter(Boolean) : [];
      return c.json(readFilteredLogLines(limit, srcValues, contains));
    }
    return c.json(readRecentLogLines(limit));
  });

  app.get('/api/logs/stream', (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });

      const onLine = async (line: ParsedLogLine) => {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'line', line }) });
        } catch { /* stream closed */ }
      };

      logEvents.on('line', onLine);

      const onDebug = async (row: DebugLogRow) => {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'debug', line: {
            t:          row.created_at,
            lvl:        'DEBUG',
            src:        row.source,
            msg:        row.message,
            session_id: row.session_id,
            agent_id:   row.agent_id,
          }}) });
        } catch { /* stream closed */ }
      };

      logEvents.on('debug', onDebug);

      const pingId = setInterval(async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); }
        catch { clearInterval(pingId); }
      }, 5000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          logEvents.off('line', onLine);
          logEvents.off('debug', onDebug);
          clearInterval(pingId);
          resolve();
        });
      });
    });
  });
  app.get('/api/hive',          (c) => c.json(getHiveEvents(intQuery(c.req.query('limit'), 100))));

  app.get('/api/hive/stream', (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });

      const onEvent = async (ev: HiveEvent) => {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'hive_event', event: ev }) });
        } catch { /* stream closed */ }
      };

      hiveEvents.on('event', onEvent);

      const pingId = setInterval(async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); }
        catch { clearInterval(pingId); }
      }, 5000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          hiveEvents.off('event', onEvent);
          clearInterval(pingId);
          resolve();
        });
      });
    });
  });
  app.get('/api/errors',        (c) => c.json(getHiveErrors(intQuery(c.req.query('limit'), 50))));
  app.get('/api/agent-messages', (c) => c.json(getAgentMessages(intQuery(c.req.query('limit'), 100))));

  // ── User-as-participant: inject a user message into the agent comms log.
  // The recipient agent runs a real turn (via alfred.chatStream) so they
  // actually receive and respond to the user. Mirrors the `message_agent`
  // tool path in src/tools/registry.ts but with from_name='User'.
  app.post('/api/agent-messages', async (c) => {
    let body: { to?: string; message?: string; sessionId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const to       = (body.to ?? '').trim();
    const message  = (body.message ?? '').trim();
    if (!to)      return c.json({ error: 'missing "to" (recipient agent name)' }, 400);
    if (!message) return c.json({ error: 'missing "message"' }, 400);

    // ── Broadcast path: to='*' | 'all' | '@all' fans out to every active agent.
    // Each recipient gets its own agent_messages row (so the existing comms log
    // and SSE pipeline keep working unchanged). Recipients run sequentially and
    // see prior replies as extraSystemContext, so they can build on each other
    // ("all agents can see and reply to it").
    const isBroadcast = to === '*' || to.toLowerCase() === 'all' || to.toLowerCase() === '@all';
    if (isBroadcast) {
      const recipients = getAllAgents().filter((a) => a.status === 'active');
      if (recipients.length === 0) {
        return c.json({ error: 'no active agents to broadcast to' }, 400);
      }

      // Group all rows under one broadcast id so the UI/log can correlate them.
      const broadcastId = randomUUID();

      const records = recipients.map((recipient) => {
        const rec = createAgentMessage(
          null,
          'User',
          recipient.id,
          recipient.name,
          message,
          body.sessionId,
        );
        logHive('user_message_sent', `dashboard: User → @all → ${recipient.name}: "${message.slice(0, 60)}"`, recipient.id, {
            toAgentId: recipient.id,
            preview: message.slice(0, 80),
            messageId: rec.id,
            broadcast: true,
            broadcastId,
            broadcastSize: recipients.length,
          });
        return { recipient, record: rec };
      });

      // Detached: run each recipient in turn, building up a transcript so later
      // agents can see and respond to earlier replies. HTTP response returns
      // immediately; UI tracks per-row status via SSE.
      (async () => {
        const { chatStream } = await import('../agent/alfred');
        const transcript: string[] = [];
        for (const { recipient, record } of records) {
          try {
            const sessId = createSession(recipient.id, `Comms: User → @all → ${recipient.name}`, 'comms');
            // Build extra context from prior replies in this broadcast so the
            // current agent can see and react to what others already said.
            const priorContext = transcript.length
              ? [
                  '## Broadcast context',
                  `The user sent the following message to ALL active agents (you are one of ${recipients.length}).`,
                  'Replies that have already come in from other agents are listed below.',
                  'Read them, avoid repeating points already made, and feel free to agree, disagree,',
                  'add new angles, or build on what others said. Address the user, not the other agents.',
                  '',
                  ...transcript,
                ].join('\n')
              : [
                  '## Broadcast context',
                  `The user sent this message to ALL active agents (you are one of ${recipients.length}).`,
                  'You are first to respond — keep it focused; other agents will follow.',
                ].join('\n');

            let response = '';
            await chatStream(
              message,
              sessId,
              (chunk) => { response += chunk; },
              recipient.system_prompt ?? '',
              recipient.id,
              undefined,
              undefined,
              priorContext,
              undefined,
            );
            saveMessage(sessId, 'assistant', response, recipient.id);
            updateAgentMessageResponse(record.id, response, 'responded');

            // Create a notification so the response appears in the Notifications tab.
            createAgentUserMessage({
              fromAgentId: recipient.id,
              fromName: recipient.name,
              kind: 'info',
              body: response,
              metadata: {
                broadcast: true,
                broadcastId,
                originalMessage: message.slice(0, 200),
                agentMessageId: record.id,
              },
              sessionId: sessId,
            });
            logHive('agent_notified_user', `dashboard: ${recipient.name} replied to broadcast: "${response.slice(0, 60)}"`, recipient.id, { messageId: record.id, sessionId: sessId, broadcast: true, broadcastId });

            logHive('agent_response', `dashboard: ${recipient.name} → User (@all): "${response.slice(0, 60)}"`, recipient.id, { messageId: record.id, sessionId: sessId, broadcast: true, broadcastId });
            transcript.push(`### @${recipient.name} replied:`, response, '');
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            updateAgentMessageResponse(record.id, errMsg, 'failed');
            logHive('llm_error', `dashboard: User→@all→${recipient.name} failed: ${errMsg}`, recipient.id, { messageId: record.id, broadcast: true, broadcastId });
            // Continue with the rest of the broadcast even if one agent fails.
          }
        }
      })();

      return c.json({
        ok: true,
        broadcast: true,
        broadcastId,
        recipients: records.map(({ recipient, record }) => ({
          agent: recipient.name,
          messageId: record.id,
        })),
      });
    }

    const recipient = getAgentByName(to);
    if (!recipient) return c.json({ error: `agent "${to}" not found` }, 404);
    if (recipient.status !== 'active') return c.json({ error: `agent "${to}" is not active` }, 400);

    // Persist the row immediately so the dashboard sees it as "pending" while
    // the agent thinks. from_agent_id is null (user is not an agent); from_name
    // is the human-readable label.
    const msgRecord = createAgentMessage(
      null,
      'User',
      recipient.id,
      recipient.name,
      message,
      body.sessionId,
    );

    logHive('user_message_sent', `dashboard: User → ${recipient.name}: "${message.slice(0, 60)}"`, recipient.id, { toAgentId: recipient.id, preview: message.slice(0, 80), messageId: msgRecord.id });

    // Run the recipient asynchronously — don't block the HTTP response on a
    // multi-second LLM turn. The frontend will see status flip from
    // "pending" → "responded"/"failed" via the SSE stream.
    (async () => {
      try {
        const { chatStream } = await import('../agent/alfred');
        const sessId = createSession(recipient.id, `Comms: User → ${recipient.name}`, 'comms');
        let response = '';
        await chatStream(
          message,
          sessId,
          (chunk) => { response += chunk; },
          recipient.system_prompt ?? '',
          recipient.id,
          undefined,
          undefined,
          undefined,
          undefined,
        );
        saveMessage(sessId, 'assistant', response, recipient.id);
        updateAgentMessageResponse(msgRecord.id, response, 'responded');

        // Create a notification so the response appears in the Notifications tab.
        createAgentUserMessage({
          fromAgentId: recipient.id,
          fromName: recipient.name,
          kind: 'info',
          body: response,
          metadata: {
            originalMessage: message.slice(0, 200),
            agentMessageId: msgRecord.id,
          },
          sessionId: sessId,
        });
        logHive('agent_notified_user', `dashboard: ${recipient.name} replied: "${response.slice(0, 60)}"`, recipient.id, { messageId: msgRecord.id, sessionId: sessId });

        logHive('agent_response', `dashboard: ${recipient.name} → User: "${response.slice(0, 60)}"`, recipient.id, { messageId: msgRecord.id, sessionId: sessId });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        updateAgentMessageResponse(msgRecord.id, errMsg, 'failed');
        logHive('llm_error', `dashboard: User→${recipient.name} failed: ${errMsg}`, recipient.id, { messageId: msgRecord.id });
      }
    })();

    return c.json({ ok: true, message: msgRecord });
  });

  // ── Comms notes (user-authored annotations) ───────────────────────────────
  // GET    /api/comms/notes        list (newest first, pinned first)
  // POST   /api/comms/notes        create  { body, visibility?, agentId?, refMessageId?, pinned? }
  // PATCH  /api/comms/notes/:id    update  { body?, visibility?, pinned? }
  // DELETE /api/comms/notes/:id    delete
  app.get('/api/comms/notes', (c) => {
    const limit = intQuery(c.req.query('limit'), 100);
    return c.json(getCommsNotes(limit));
  });

  app.post('/api/comms/notes', async (c) => {
    let body: {
      body?: string;
      visibility?: 'private' | 'shared';
      agentId?: string | null;
      sessionId?: string | null;
      refMessageId?: string | null;
      pinned?: boolean;
      author?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const text = (body.body ?? '').trim();
    if (!text) return c.json({ error: 'missing "body"' }, 400);
    const visibility = body.visibility === 'shared' ? 'shared' : 'private';

    // If agentId given, validate it exists.
    if (body.agentId) {
      const a = getAgentById(body.agentId);
      if (!a) return c.json({ error: `agent "${body.agentId}" not found` }, 404);
    }

    const note = createCommsNote({
      body:         text,
      author:       body.author ?? 'User',
      visibility,
      agentId:      body.agentId ?? null,
      sessionId:    body.sessionId ?? null,
      refMessageId: body.refMessageId ?? null,
      pinned:       !!body.pinned,
    });

    logHive('user_note_added', `dashboard: Note (${visibility}): "${text.slice(0, 60)}"`, body.agentId ?? undefined, { noteId: note.id, visibility, refMessageId: body.refMessageId ?? null });

    return c.json({ ok: true, note });
  });

  app.patch('/api/comms/notes/:id', async (c) => {
    const id = c.req.param('id');
    let patch: { body?: string; visibility?: 'private' | 'shared'; pinned?: boolean };
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const updated = updateCommsNote(id, patch);
    if (!updated) return c.json({ error: 'note not found' }, 404);
    return c.json({ ok: true, note: updated });
  });

  app.delete('/api/comms/notes/:id', (c) => {
    const id = c.req.param('id');
    const ok = deleteCommsNote(id);
    if (!ok) return c.json({ error: 'note not found' }, 404);
    logHive('user_note_deleted', `dashboard: Deleted note ${id.slice(0, 8)}`, undefined, { noteId: id });
    return c.json({ ok: true });
  });

  // ── Agent → User notifications ────────────────────────────────────────────
  // GET    /api/notifications                 list (newest first, can filter unread/undismissed)
  // POST   /api/notifications/:id/read        mark as read
  // POST   /api/notifications/:id/dismiss     mark as dismissed (hides from default view)
  app.get('/api/notifications', (c) => {
    const limit          = intQuery(c.req.query('limit'), 100);
    const unreadOnly     = c.req.query('unread') === 'true';
    const undismissedOnly = c.req.query('undismissed') !== 'false'; // default true
    const notifications = getAgentUserMessages({ limit, unreadOnly, undismissedOnly });
    const unreadCount = getUnreadAgentUserMessageCount();
    return c.json({ notifications, unreadCount });
  });

  app.post('/api/notifications/:id/read', (c) => {
    const id = c.req.param('id');
    const existing = getAgentUserMessageById(id);
    if (!existing) return c.json({ error: 'notification not found' }, 404);
    const updated = markAgentUserMessageRead(id);
    return c.json({ ok: true, notification: updated });
  });

  app.post('/api/notifications/:id/dismiss', (c) => {
    const id = c.req.param('id');
    const existing = getAgentUserMessageById(id);
    if (!existing) return c.json({ error: 'notification not found' }, 404);
    const updated = markAgentUserMessageDismissed(id);
    logHive('user_dismissed_notification', `dashboard: User dismissed notification ${id.slice(0, 8)}`, existing.from_agent_id, { notificationId: id });
    return c.json({ ok: true, notification: updated });
  });

  // ── Runs (v2.0 run grouping) ──────────────────────────────────────────────
  app.get('/api/runs', (c) => {
    const sessionId = c.req.query('session') ?? undefined;
    const limit     = intQuery(c.req.query('limit'), 100);
    return c.json(listRuns({ sessionId, limit }));
  });
  app.get('/api/runs/:id', (c) => {
    const run = getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'run not found' }, 404);
    return c.json({ run, events: getRunHiveEvents(run.id) });
  });

  app.get('/api/config', (c) => {
    type Row = { key: string; value: string; description: string | null; is_secret: number };
    const items = getDb().prepare('SELECT key, value, description, is_secret FROM config_items').all() as Row[];
    return c.json(items.map(item => ({
      ...item,
      value: item.is_secret ? '***REDACTED***' : item.value,
    })));
  });

  // ── Environment Variables (dynamic .env editing) ──────────────────────────
  
  // GET /api/env - Get all env variables (secrets masked by default)
  app.get('/api/env', (c) => {
    const reveal = c.req.query('reveal') === 'true';
    const grouped = c.req.query('grouped') === 'true';
    
    if (grouped) {
      return c.json(getEnvByCategory(reveal));
    }
    return c.json(getEnvVariables(reveal));
  });

  // GET /api/env/schema - Get .env.example schema with descriptions
  app.get('/api/env/schema', (c) => {
    return c.json(getEnvSchema());
  });

  // GET /api/env/:key - Get a single env variable's raw value (for secret reveal)
  app.get('/api/env/:key', (c) => {
    const key = c.req.param('key');
    const value = getRawEnvValue(key);
    if (value === null) {
      return c.json({ error: `Variable ${key} not found` }, 404);
    }
    return c.json({ key, value });
  });

  // PATCH /api/env - Update one or more env variables
  app.patch('/api/env', async (c) => {
    let body: { updates: Record<string, string>; backup?: boolean };
    try {
      body = await c.req.json() as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.updates || typeof body.updates !== 'object') {
      return c.json({ error: 'updates object required' }, 400);
    }

    const result = updateEnvVariables(body.updates, { backup: body.backup ?? true });
    
    if (!result.success) {
      return c.json({ error: 'Update failed', details: result.errors }, 400);
    }

    return c.json({
      success: true,
      updated: result.updated,
      added: result.added,
      backupPath: result.backupPath,
    });
  });

  // DELETE /api/env/:key - Delete a single env variable
  app.delete('/api/env/:key', (c) => {
    const key = c.req.param('key');
    const result = deleteEnvVariable(key);
    
    if (!result.success) {
      return c.json({ error: result.errors[0] ?? 'Delete failed' }, 400);
    }

    return c.json({ success: true, deleted: key, backupPath: result.backupPath });
  });

  // POST /api/env/reload - Force reload of .env (useful after external edit)
  app.post('/api/env/reload', (c) => {
    const dotenv = require('dotenv');
    const envPath = require('path').resolve(process.cwd(), '.env');
    dotenv.config({ path: envPath, override: true });
    configEvents.emit('change');
    return c.json({ success: true, message: 'Environment reloaded' });
  });

  // ── Chat (SSE — with routing + spawn events) ──────────────────────────────
  app.post('/api/chat', async (c) => {
    let body: {
      message?:     string;
      sessionId?:   string;
      agentId?:     string;
      attachments?: Array<{ url: string; mime_type?: string; name?: string }>;
      /** Binary document uploads (PDF / DOCX / EPUB / HTML). The frontend
       *  reads files as base64 and posts them here; the backend registers
       *  each in the per-session attachment registry and threads a descriptor
       *  block into the agent's system context. The agent retrieves bytes
       *  via the `get_attachment` tool, then forwards them to a parser MCP
       *  tool (e.g. mcp__docuflow__parse_pdf_base64). */
      documents?: Array<{ name: string; data: string; mime_type?: string }>;
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
      context?: string;
      /** Per-session chat-mode override. true=force plain completion,
       *  false=force full agent mode, null=clear (inherit agent default).
       *  Omit to leave the session's setting unchanged. */
      chatMode?: boolean | null;
    };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

    const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter(a => a && typeof a.url === 'string')
      : [];
    const documents = Array.isArray(body.documents)
      ? body.documents.filter(d => d && typeof d.name === 'string' && typeof d.data === 'string')
      : [];
    if (!rawMessage && attachments.length === 0 && documents.length === 0) {
      return c.json({ error: 'message, attachments, or documents required' }, 400);
    }

    // ── Built-in slash commands ─────────────────────────────────────────────
    // Intercept before resolveAgent() to avoid an unnecessary classifier call.
    // Note: /stop is handled client-side in the dashboard (aborts the fetch +
    // POSTs to /api/chat/stop directly) so this intercept never fires for /stop
    // from the dashboard. It does handle /stop from CLI and Discord which call
    // dispatchSlash() directly, not through this route.
    if (rawMessage.startsWith('/')) {
      let slashReply: string | null = null;
      const slashSessionId = body.sessionId ?? randomUUID();
      const handled = await dispatchSlash(rawMessage, {
        sessionId: slashSessionId,
        surface: 'dashboard',
        agentId: body.agentId,
        reply: async (text) => { slashReply = text; },
      });
      if (handled) {
        return streamSSE(c, async (stream) => {
          await stream.writeSSE({ data: JSON.stringify({ type: 'session', sessionId: slashSessionId }) });
          if (slashReply !== null) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: slashReply }) });
          }
          await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
        });
      }
    }

    const resolved = await resolveAgent(rawMessage || (documents.length > 0 ? '(document)' : '(image)'), body.agentId);
    const { agent } = resolved;
    let { message } = resolved;
    const sessionId    = body.sessionId ?? createSession(agent.id, undefined, 'dashboard');
    // Per-session chat-mode override (wins over the agent default in chatStream).
    if (body.chatMode !== undefined) setSessionChatMode(sessionId, body.chatMode);
    const systemPrompt = agent.system_prompt ?? 'You are a helpful AI assistant.';

    // ── Register document attachments in the per-session registry ──────────
    // PDF / DOCX / EPUB / HTML bytes were posted as base64; we stash them in
    // an in-memory registry keyed by attachment_id and tell the agent how to
    // retrieve them via the `get_attachment` tool. This keeps the raw bytes
    // OUT of the message body (which would balloon context and re-stream on
    // every turn) while still making them reachable by MCP parsers like
    // docuflow that accept base64.
    const documentDescriptors: Array<{ id: string; name: string; mime: string; size: number; isLarge: boolean; isParsed: boolean; parseError?: string; diskPath?: string }> = [];
    const documentRegistrationErrors: string[] = [];
    if (documents.length > 0) {
      const { registerAttachment } = await import('../system/attachment-registry');
      const { persistUpload, recordProcessing } = await import('../system/session-uploads');
      for (const doc of documents) {
        try {
          // Persist the raw bytes into the session workspace first, so the doc
          // gets a real disk_path (drives docuflow's large-file branch) and is
          // discoverable via list_uploads. `data` may be raw base64 or a data URI.
          const rawB64 = doc.data.startsWith('data:') && doc.data.includes(',')
            ? doc.data.slice(doc.data.indexOf(',') + 1)
            : doc.data;
          let up = null;
          try {
            up = await persistUpload({ sessionId, source: 'web', name: doc.name, mime: doc.mime_type, bytes: Buffer.from(rawB64, 'base64') });
          } catch { /* non-fatal — registration below still works */ }
          const result = registerAttachment({
            sessionId,
            name: doc.name,
            data: doc.data,
            mime: doc.mime_type,
            diskPath: up?.path ?? undefined,
          });
          if (result.ok) {
            documentDescriptors.push(result.descriptor);
            if (up) { try { recordProcessing(sessionId, up.id, { attachment_id: result.descriptor.id, parsed: false }); } catch { /* non-fatal */ } }
          } else if (!up) {
            // Registration failed AND we couldn't persist → truly unavailable.
            // When `up` exists (e.g. a non-document type the docuflow registry
            // rejects), the raw file is still reachable via get_upload, so it's
            // surfaced through the uploads context block, not as an error.
            documentRegistrationErrors.push(`${doc.name}: ${result.error}`);
          }
        } catch (err) {
          documentRegistrationErrors.push(`${doc.name}: ${(err as Error).message ?? String(err)}`);
        }
      }
      if (documentRegistrationErrors.length > 0) {
        logger.warn('chat: some document attachments rejected', {
          sessionId, errors: documentRegistrationErrors,
        });
      }
    }

    // ── Eager server-side parse ────────────────────────────────────────────
    // Parse all registered documents in parallel before opening the SSE stream.
    // The agent's first turn will see "✓ pre-parsed" in the context block and
    // can call get_attachment_parsed() to get clean markdown — no base64 in
    // the tool-return path, no tool-output-cap truncation.
    if (documentDescriptors.length > 0) {
      const { parseAttachment, getAttachment } = await import('../system/attachment-registry');
      // Promise.allSettled so a single parse failure doesn't abort the rest.
      await Promise.allSettled(documentDescriptors.map(d => parseAttachment(d.id)));
      // Rebuild descriptors from the now-mutated in-memory records to pick up
      // isParsed / parseError written by parseAttachment().
      for (let i = 0; i < documentDescriptors.length; i++) {
        const rec = getAttachment(documentDescriptors[i].id);
        if (rec) {
          documentDescriptors[i] = {
            ...documentDescriptors[i],
            isParsed:   !!rec.parsedContent,
            parseError: rec.parseError,
          };
        }
      }
      // Flag the matching session_uploads rows as parsed for list_uploads.
      try {
        const { listUploads, recordProcessing } = await import('../system/session-uploads');
        const ups = listUploads(sessionId);
        for (const d of documentDescriptors) {
          if (!d.isParsed) continue;
          const m = ups.find(u => (u.processed as { attachment_id?: string }).attachment_id === d.id);
          if (m) recordProcessing(sessionId, m.id, { parsed: true });
        }
      } catch { /* non-fatal */ }
    }

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

    if (body.context) {
      extraSystemContext = extraSystemContext
        ? `${extraSystemContext}\n\n${body.context}`
        : body.context;
    }

    // Append attachment registry context (PDF / DOCX / EPUB / HTML uploads).
    // This block tells the agent which attachment_ids exist and how to fetch
    // them via the `get_attachment` tool — without it, the agent would only
    // see a placeholder like "[file: foo.pdf]" in the user message and have
    // no way to reach the actual bytes.
    if (documentDescriptors.length > 0) {
      const { buildAttachmentContextBlock } = await import('../system/attachment-registry');
      const block = buildAttachmentContextBlock(documentDescriptors);
      extraSystemContext = extraSystemContext ? extraSystemContext + block : block;
    }
    if (documentRegistrationErrors.length > 0) {
      // Surface rejected uploads so the agent can be honest with the user
      // instead of pretending the file is available.
      const errLines = documentRegistrationErrors.map(e => `  - ${e}`).join('\n');
      const errBlock = `\n\n---\nSome documents the user tried to attach could NOT be registered and are unavailable to tools:\n${errLines}`;
      extraSystemContext = extraSystemContext ? extraSystemContext + errBlock : errBlock;
    }

    // Vision routing — decide once, before chatStream, what to do with the images:
    //   'preprocess' → describe via VISION_MODEL and inline the descriptions into
    //                  the user message (universal fallback that works for every provider).
    //   'native'     → pass attachments through to chatStream so the agent's own
    //                  multi-modal LLM sees the image directly (OpenAI/VoidAI path).
    let nativeAttachments: typeof attachments = [];
    if (attachments.length > 0) {
      // Persist images into the session workspace so they're revisitable later
      // via list_uploads / analyze_image (vision still runs on them below).
      try {
        const { persistUpload } = await import('../system/session-uploads');
        for (const att of attachments) {
          let buf: Buffer | null = null;
          if (att.url.startsWith('data:')) {
            const comma = att.url.indexOf(',');
            if (comma >= 0) buf = Buffer.from(att.url.slice(comma + 1), 'base64');
          } else {
            try { const r = await fetch(att.url); if (r.ok) buf = Buffer.from(await r.arrayBuffer()); } catch { /* non-fatal */ }
          }
          if (buf) await persistUpload({ sessionId, source: 'web', name: att.name ?? 'image', mime: att.mime_type ?? 'image/png', bytes: buf });
        }
      } catch { /* non-fatal — vision still runs below */ }
      const { resolveVisionMode, describeImages } = await import('../vision/vision-service');
      const mode = resolveVisionMode(agent);
      // Convert Discord CDN (and other external) URLs to base64 data URIs so
      // the LLM backend can process the image bytes directly without making
      // outbound fetches that may be blocked, rate-limited, or expired.
      const toDataUri = async (att: { url: string; mime_type?: string; name?: string }) => {
        if (att.url.startsWith('data:')) return att; // already a data URI
        try {
          const res = await fetch(att.url);
          if (!res.ok) return att; // fall back to original URL on fetch failure
          const buf = await res.arrayBuffer();
          const mime = att.mime_type ?? res.headers.get('content-type') ?? 'image/png';
          const b64 = Buffer.from(buf).toString('base64');
          return { ...att, url: `data:${mime};base64,${b64}` };
        } catch {
          return att; // fall back to original URL
        }
      };
      if (mode === 'preprocess') {
        try {
          // Forward the user's question into the describer so it knows what to
          // focus on (e.g. "what does it say?" → describer prioritizes text).
          const fetchedAtts = await Promise.all(attachments.map(toDataUri));
          const descriptions = await describeImages(fetchedAtts, {
            userPrompt: rawMessage,
            provider:   agent.vision_provider ?? undefined,
            agentName:  agent.name,
            mode,
          });
          const block = descriptions
            .map((d, i) => `[Image ${i + 1}${attachments[i].name ? ` "${attachments[i].name}"` : ''}: ${d}]`)
            .join('\n');
          message = (rawMessage ? `${block}\n\n${rawMessage}` : block).trim();
        } catch (err) {
          // Don't fail the chat — agent at least sees that an image came in.
          message = `[image attached but description failed: ${(err as Error).message.slice(0, 120)}]\n\n${rawMessage}`;
        }
      } else {
        // Native: download images server-side and encode as base64 data URIs so
        // the LLM backend doesn't need to fetch Discord CDN (which may be
        // inaccessible or have expired tokens).
        nativeAttachments = await Promise.all(attachments.map(toDataUri));
      }
    }

    // Unified uploads block — tells the agent about ALL persisted uploads in this
    // session (images, audio, arbitrary files) and how to open them, complementing
    // the document-specific attachment block above.
    {
      const { buildUploadsContextBlock } = await import('../system/session-uploads');
      const uBlock = buildUploadsContextBlock(sessionId);
      if (uBlock) extraSystemContext = extraSystemContext ? extraSystemContext + uBlock : uBlock;
    }

    const toolRelay = c.req.header('x-tool-relay') === 'true';

    // v3.2: pre-create the runId here so the route owns persistence (partial
    // output, detach-on-disconnect, heartbeat). orchestrate / chatStream reuse
    // this id instead of opening their own row.
    const runId = startRun({
      origin:            body.discord ? 'discord' : 'dashboard',
      sessionId,
      initiatingAgentId: agent.id,
      userMessage:       message,
      deliveryTarget:    body.discord ? {
        botId:     body.discord.bot_id,
        channelId: body.discord.channel_id,
        messageId: body.discord.message_id,
        userId:    body.discord.author_id,
        guildId:   body.discord.guild_id,
      } : undefined,
    });

    return streamSSE(c, async (stream) => {
      let clientGone = false;
      const markGone = () => {
        if (clientGone) return;
        clientGone = true;
        // v3.2: client disconnected mid-stream. Mark the run as 'detached' so
        // the resume endpoint knows to keep listening, but keep the agent
        // loop running — partial_output accumulates in the DB and the user
        // can re-attach from any tab.
        const detach = config.dashboard.detachOnDisconnect;
        if (detach) {
          try { detachRun(runId); } catch { /* best-effort */ }
          logger.info('chat: client disconnected; run detached, loop continues', { sessionId, runId });
        } else {
          // Legacy behavior preserved for ops that want to opt out via env.
          try { stopStream(sessionId); } catch { /* best-effort */ }
        }
      };

      // Register relay dispatch for this session so agents can call local tools.
      if (toolRelay) {
        setRelayDispatch(sessionId, async (toolCallId, tool, argsStr) => {
          if (!clientGone) {
            try {
              await stream.writeSSE({ data: JSON.stringify({ type: 'tool_call', toolCallId, tool, args: JSON.parse(argsStr || '{}') }) });
            } catch { /* client gone */ }
          }
          return createPending(toolCallId);
        });
      }

      // Detect disconnect via the request's native AbortSignal (fires immediately
      // when the HTTP client drops the connection). v3.2: this NO LONGER aborts
      // the agent loop — it just marks the client gone so writeChunk falls back
      // to DB-only persistence.
      c.req.raw.signal.addEventListener('abort', markGone, { once: true });

      // v3.2: structured heartbeat replaces the silent 15s `:` keepalive. The
      // heartbeat module auto-clears once the turn is marked done/paused/
      // stopped, and writes to runs.last_heartbeat_at on every tick so the
      // stale-run sweep can detect a dead process.
      //
      // Register the per-session turn-state FIRST: the heartbeat tick reads it
      // via getTurnState(), and without an entry the tick bails before
      // updateRunHeartbeat() — last_heartbeat_at stays null and the stale-run
      // sweeper false-drops every run older than AGENT_RUN_STALE_MS.
      startTurn({ sessionId, runId, agentId: agent.id });
      const heartbeatStop = startHeartbeat(sessionId, runId, (e) => {
        if (clientGone) return;
        try {
          stream.writeSSE({ data: JSON.stringify(e) });
        } catch {
          markGone();
        }
      });

      try {
        await stream.writeSSE({ data: JSON.stringify({ type: 'session', sessionId }) });
        await stream.writeSSE({ data: JSON.stringify({ type: 'agent', name: agent.name, agentId: agent.id }) });
        await stream.writeSSE({ data: JSON.stringify({ type: 'run', runId }) });
      } catch {
        // Client disconnected before we could write the initial SSE frames.
        // Close the run record so it isn't left in 'running' and swept as stale.
        try { endRun(runId, { status: 'error', error_text: 'client disconnected before stream started' }); } catch { /* best-effort */ }
        markGone(); heartbeatStop(); clearTurn(sessionId, runId); return;
      }

      await sessionQueueManager.enqueue(sessionId, async () => {
        // v3.2: even if client disconnected while we were queued, the agent
        // loop should still run — partial_output captures the work for a
        // future reconnect via /api/chat/resume.
        if (resolved.routeEvent) {
          if (!clientGone) {
            try {
              await stream.writeSSE({ data: JSON.stringify({ type: 'route', ...resolved.routeEvent }) });
            } catch { markGone(); }
          }
        }

        const onMeta = async (e: MetaEvent) => {
          // Build the client-facing payload once, then fan out: ALWAYS to the
          // agent bus (so resume connections / secondary tabs see sub-agent
          // and step activity even while the primary client is gone), and to
          // this stream's SSE only while the client is still attached.
          let payload: Record<string, unknown> | null = null;
          if (e.type === 'spawn') {
            payload = { type: 'spawn', agentName: e.event.agentName, agentId: e.event.agentId };
          } else if (e.type === 'spawn_started') {
            payload = { type: 'spawn_started', agentName: e.agentName, taskId: e.taskId };
          } else if (e.type === 'spawn_chunk') {
            payload = { type: 'spawn_chunk', agentName: e.agentName, content: e.content };
          } else if (e.type === 'spawn_done') {
            payload = { type: 'spawn_done', agentName: e.agentName, result: e.result };
          } else if (e.type === 'plan') {
            payload = { type: 'plan', steps: e.steps };
          } else if (e.type === 'step_start') {
            payload = { type: 'step_start', stepIndex: e.stepIndex, task: e.task, agentName: e.agentName };
          } else if (e.type === 'step_chunk') {
            payload = { type: 'step_chunk', stepIndex: e.stepIndex, agentName: e.agentName, content: e.content };
          } else if (e.type === 'step_done') {
            payload = { type: 'step_done', stepIndex: e.stepIndex, agentName: e.agentName };
          } else if (e.type === 'merge_start') {
            payload = { type: 'merge_start' };
          } else if (e.type === 'spawn_eval') {
            payload = { type: 'spawn_eval', task: e.task, shouldSpawn: e.shouldSpawn, benefit: e.benefit, reason: e.reason };
          } else if (e.type === 'agent_message') {
            payload = { type: 'agent_message', fromName: e.fromName, toName: e.toName, preview: e.preview };
          } else if (e.type === 'agent_task_assigned') {
            payload = { type: 'agent_task_assigned', fromName: e.fromName, toName: e.toName, title: e.title, taskId: e.taskId, executing: e.executing };
          } else if (e.type === 'agent_image') {
            // Agent-produced image (send_image_to_user tool). Live event so the
            // image appears in the bubble before the next LLM token; the markdown
            // tag returned by the tool gets persisted into messages.content for
            // the reload path.
            payload = { type: 'agent_image', fromName: e.fromName, url: e.url, alt: e.alt, caption: e.caption, mime: e.mime };
          } else if (e.type === 'agent_file') {
            // Agent-produced file (send_document tool). Live event so the file
            // card appears in the bubble immediately; Discord handles it via
            // postAgentFiles() at end-of-turn.
            payload = { type: 'agent_file', fromName: e.fromName, url: e.url, filename: e.filename, mime: e.mime, size: e.size, caption: e.caption };
          } else if (e.type === 'mcp_call_start') {
            payload = { type: 'tool_start', tool: e.tool };
          } else if (e.type === 'mcp_call_done') {
            payload = { type: 'tool_done', tool: e.tool };
          }
          if (!payload) return;
          try { agentBus.emitAgent({ type: 'meta', sessionId, runId, event: payload }); } catch { /* best-effort */ }
          if (clientGone) return;
          try {
            await stream.writeSSE({ data: JSON.stringify(payload) });
          } catch { markGone(); /* stream closed */ }
        };

        // v3.2: chunk writer. ALWAYS persists to runs.partial_output so a
        // reconnecting client (or a freshly-opened tab) can replay accumulated
        // text via /api/chat/resume. The SSE write itself is best-effort.
        let finalText = '';
        const writeChunk = async (chunk: string) => {
          const offset = finalText.length;
          finalText += chunk;
          try { appendPartialOutput(runId, chunk); } catch { /* best-effort */ }
          // Live bus emit so resume connections / secondary tabs stream tokens
          // in real time instead of freezing at their replay snapshot. The
          // offset (partial_output length before this chunk) lets a resuming
          // client drop chunks its snapshot already contained.
          try { agentBus.emitAgent({ type: 'chunk', sessionId, runId, content: chunk, offset }); } catch { /* best-effort */ }
          if (clientGone) return;
          try {
            await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: chunk }) });
          } catch {
            markGone();
          }
        };

        // v3.2: the stop-stream signal is now reserved for explicit
        // /api/chat/stop calls. Client disconnect does NOT abort the agent
        // loop — the loop continues to completion and writes to partial_output.
        const signal = registerStream(sessionId);
        try {
          try {
            if (agent.name === 'Alfred') {
              await orchestrateMultiAgent(
                message, sessionId, writeChunk, agent.id, onMeta, 'dashboard', signal, runId,
                // v3.3: thread per-turn context + native attachments so PDFs
                // / DOCX uploaded to Alfred-routed chats actually surface in
                // the agent's system prompt (attachment-registry block tells
                // it how to call get_attachment + docuflow). Without these
                // two args Alfred only sees the user's text and hallucinates
                // from the filename.
                extraSystemContext,
                nativeAttachments,
                false, // suppressUserMessage
                !clientGone ? () => { try { markRunDelivered(runId, 1); } catch { /* best-effort */ } } : undefined,
              );
            } else {
              await chatStream(
                message, sessionId, writeChunk,
                systemPrompt, agent.id, onMeta, nativeAttachments, extraSystemContext, runId, signal,
              );
              // Pre-mark delivered for any live connection. For Discord-origin runs
              // that are still streaming (clientGone=false), liveEditLoop is still
              // active; marking here prevents deliverRun from double-posting when
              // run:terminal fires below (the race: endRun fires before the discord
              // bot's reader sees `done` and calls markRunDelivered itself).
              // For dropped/timed-out Discord connections (clientGone=true), skip
              // so deliverRun handles background delivery as the backstop.
              if (!clientGone) {
                try { markRunDelivered(runId, 1); } catch { /* best-effort */ }
              }
              try { endRun(runId, { status: 'done', final_output: finalText }); } catch { /* best-effort */ }
            }
            if (!clientGone) {
              try { await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) }); } catch { /* closed */ }
            }
          } finally {
            clearStream(sessionId);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const displayMsg = translateClaudeError(err);
          // chatStream / orchestrate already endRun() with status='error' for
          // most paths; if the error path was missed, surface it here.
          try { endRun(runId, { status: 'error', error_text: msg }); } catch {}
          if (!clientGone) {
            // SSE 'error' goes to the user-facing client — keep raw msg so the
            // SDK's exact text reaches the dashboard, just like before.
            try { await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: msg }) }); } catch { /* closed */ }
          }
          logger.warn('chat: agent loop ended with error', { sessionId, runId, error: displayMsg });
        }
        // Silence the unused-var linter on the captured final text — the
        // canonical record is runs.partial_output / runs.final_output.
        void finalText;
        heartbeatStop();
        clearTurn(sessionId, runId);
        if (toolRelay) clearRelayDispatch(sessionId);
      }); // end sessionQueueManager.enqueue
    });
  });

  app.post('/api/chat/tool-result', async (c) => {
    const body = await c.req.json<{ toolCallId?: string; result?: string; sessionId?: string }>();
    const { toolCallId, result } = body;
    if (!toolCallId || result === undefined) return c.json({ ok: false, error: 'toolCallId and result required' }, 400);
    const resolved = resolvePending(toolCallId, result);
    return c.json({ ok: resolved });
  });

  // Note: Auth middleware is applied globally via app.use('/api/*', ...)
  // so this route is already protected — no need to add it again
  // v3.2: stop now also flips the turn-state signal so the agent loop's next
  // iteration sees 'stopped' and exits cleanly, AND marks any running runs
  // for the session as stopped in the DB so the resume endpoint reports the
  // correct terminal state to a re-attaching client.
  app.post('/api/chat/stop', async (c) => {
    const body = await c.req.json<{ sessionId?: string }>();
    const { sessionId } = body;
    if (!sessionId) return c.json({ ok: false, error: 'sessionId required' }, 400);
    const stopped = stopStream(sessionId);
    try { markTurnDone(sessionId, 'stopped', 'user_stop'); } catch { /* best-effort */ }
    try {
      // Flip any running / detached run for this session to 'stopped'.
      getDb().prepare(`
        UPDATE runs
           SET status = 'stopped',
               error_text = 'user requested stop',
               ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
               duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
         WHERE session_id = ?
           AND status IN ('running','detached','paused')
      `).run(sessionId);
    } catch (err) {
      logger.warn('chat/stop: run update failed', { sessionId, error: (err as Error).message });
    }
    return c.json({ ok: stopped });
  });

  // v3.2: resume / re-attach to an in-flight or recently-finished run. The
  // dashboard frontend calls this on EventSource error / page reload — it
  // replays accumulated partial_output, then either signals terminal status
  // (done/error/stopped) or subscribes to the live agentBus and forwards
  // ongoing chunks + heartbeats until the run ends.
  app.get('/api/chat/resume/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    const run = findResumableRun(sessionId);
    if (!run) return c.json({ resumable: false }, 404);

    return streamSSE(c, async (stream) => {
      let clientGone = false;
      c.req.raw.signal.addEventListener('abort', () => { clientGone = true; }, { once: true });

      // 1. Subscribe to the live bus BEFORE reading the replay snapshot so no
      //    event can fall into the gap between the DB read and the
      //    subscription. Events are buffered until the snapshot is written,
      //    then flushed in order. Chunk events carry the partial_output
      //    offset they were appended at, so anything already contained in
      //    the snapshot is dropped instead of duplicated.
      let replayLen    = 0;
      let ready        = false;
      let terminalSeen = false;
      const buffered: AgentEvent[] = [];

      const forward = (e: AgentEvent) => {
        if (clientGone || terminalSeen) return;
        let payload: unknown = e;
        if (e.type === 'chunk') {
          if (typeof e.offset === 'number' && e.offset < replayLen) return; // already in snapshot
        } else if (e.type === 'meta') {
          payload = e.event; // unwrap to the exact client-facing shape
        } else if (e.type === 'thought_end') {
          terminalSeen = true;
          payload = e.signal === 'paused'
            ? { type: 'paused', reason: e.reason ?? 'soft_cap' }
            : e.signal === 'stopped'
              ? { type: 'error', message: 'run ended (stopped)', status: 'stopped' }
              : { type: 'done' };
        } else if (e.type === 'error') {
          terminalSeen = true;
          payload = { type: 'error', message: e.message, status: 'error' };
        }
        try {
          stream.writeSSE({ data: JSON.stringify(payload) });
        } catch {
          clientGone = true;
        }
      };

      const onEvent = (e: AgentEvent) => {
        if (e.sessionId !== sessionId) return; // events for THIS session only
        if (!ready) { buffered.push(e); return; }
        forward(e);
      };
      agentBus.on('agent', onEvent);

      try {
        // 2. Replay the run's identity + accumulated text. Re-read the row
        //    inside the subscription window — the copy fetched for the 404
        //    check predates it.
        const snap = findResumableRun(sessionId) ?? run;
        replayLen = snap.partial_output?.length ?? 0;
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'session', sessionId }) });
          await stream.writeSSE({ data: JSON.stringify({ type: 'run', runId: snap.id, status: snap.status }) });
          if (snap.partial_output) {
            await stream.writeSSE({ data: JSON.stringify({ type: 'replay', content: snap.partial_output }) });
          }
        } catch {
          return; // client already gone
        }

        // 3. If the run is already terminal, emit the final state and exit.
        if (snap.status === 'done') {
          try { await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) }); } catch {}
          return;
        }
        if (snap.status === 'error' || snap.status === 'dropped' || snap.status === 'stopped') {
          try {
            await stream.writeSSE({
              data: JSON.stringify({
                type:    'error',
                message: snap.error_text ?? `run ended (${snap.status})`,
                status:  snap.status,
              }),
            });
          } catch {}
          return;
        }

        // 4. Run is still 'running', 'detached', or 'paused' — flush events
        //    buffered during the replay, then forward live until a terminal
        //    bus event (thought_end/error, emitted by endRun) arrives.
        //    NB: agentBus is process-local — clustered deployments would need
        //    a different mechanism (Redis pubsub) but that's out of scope.
        for (const e of buffered) forward(e);
        buffered.length = 0;
        ready = true;

        // 5. Poll runs.status as a BACKSTOP (the bus emit could be missed if
        //    the process restarted mid-run and a sweeper finalized the row,
        //    or under clustering); the DB is the source of truth.
        const startedWaiting = Date.now();
        const MAX_WAIT_MS = 30 * 60_000;  // 30 min absolute ceiling for one resume connection
        while (!clientGone && !terminalSeen) {
          await new Promise(r => setTimeout(r, 1500));
          if (terminalSeen) break;
          if (Date.now() - startedWaiting > MAX_WAIT_MS) break;
          const fresh = findResumableRun(sessionId);
          // If it's a NEWER run, we attached too early — bail; client should reconnect.
          if (!fresh || fresh.id !== snap.id) break;
          if (fresh.status === 'done') {
            if (!clientGone) {
              try { await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) }); } catch {}
            }
            break;
          }
          if (fresh.status === 'error' || fresh.status === 'dropped' || fresh.status === 'stopped') {
            if (!clientGone) {
              try {
                await stream.writeSSE({
                  data: JSON.stringify({ type: 'error', message: fresh.error_text ?? `run ended (${fresh.status})`, status: fresh.status }),
                });
              } catch {}
            }
            break;
          }
          if (fresh.status === 'paused') {
            if (!clientGone) {
              try { await stream.writeSSE({ data: JSON.stringify({ type: 'paused', reason: 'soft_cap' }) }); } catch {}
            }
            break;
          }
        }
      } finally {
        agentBus.off('agent', onEvent);
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

      // Spec 7: task_blocked fires when a sub-agent returned progress-only output.
      // notifyPolicy is read from the event payload — do NOT query the DB here.
      // The sub-agent-runner already gates emission via shouldDeliverTaskUpdate, so
      // any event that arrives here has already passed the policy filter.
      const onBlocked = async (payload: { taskId: string; partialOutput: string; provider: string; notifyPolicy: string }) => {
        try {
          await stream.writeSSE({ data: JSON.stringify({
            type:          'task_blocked',
            taskId:        payload.taskId,
            partialOutput: payload.partialOutput,
            provider:      payload.provider,
            notifyPolicy:  payload.notifyPolicy,
          }) });
        } catch { /* stream closed */ }
      };

      taskEvents.on('task_complete', onComplete);
      taskEvents.on('task_failed', onFailed);
      taskEvents.on('task_created', onCreated);
      taskEvents.on('task_blocked', onBlocked);

      const pingId = setInterval(async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); }
        catch { clearInterval(pingId); }
      }, 5000);

      const cleanupWatch = () => {
        clearInterval(pingId);
        taskEvents.off('task_complete', onComplete);
        taskEvents.off('task_failed', onFailed);
        taskEvents.off('task_created', onCreated);
        taskEvents.off('task_blocked', onBlocked);
      };

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => { cleanupWatch(); resolve(); });
        });
      } finally {
        cleanupWatch(); // guard against exception before onAbort fires
      }
    });
  });

  // ── Approvals (v2.2 remote approval queue) ──────────────────────────────────

  app.get('/api/approvals', (c) => {
    const status = c.req.query('status');
    const limit  = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
    return c.json(listApprovals(status || undefined, limit));
  });

  app.post('/api/approvals', async (c) => {
    let body: {
      agent_id?:   string;
      agent_name?: string;
      session_id?: string;
      tool_name:   string;
      tool_input:  object;
    };
    try { body = await c.req.json() as typeof body; }
    catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.tool_name)  return c.json({ error: 'tool_name is required' }, 400);
    if (!body.tool_input || typeof body.tool_input !== 'object') return c.json({ error: 'tool_input must be an object' }, 400);
    const record = createApproval({
      agent_id:   body.agent_id   ?? null,
      agent_name: body.agent_name ?? null,
      session_id: body.session_id ?? null,
      tool_name:  body.tool_name,
      tool_input: body.tool_input,
    });
    approvalEvents.emit('pending', record);
    return c.json(record, 201);
  });

  // NOTE: /api/approvals/stream must be registered BEFORE /api/approvals/:id
  // so Hono does not treat "stream" as a UUID parameter.
  app.get('/api/approvals/stream', (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onPending = async (approval: any) => {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'pending', approval }) });
        } catch { /* stream closed */ }
      };

      approvalEvents.on('pending', onPending);

      const pingId = setInterval(async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); }
        catch { clearInterval(pingId); }
      }, 5000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          approvalEvents.off('pending', onPending);
          clearInterval(pingId);
          resolve();
        });
      });
    });
  });

  app.get('/api/approvals/:id', (c) => {
    const record = getApproval(c.req.param('id'));
    if (!record) return c.json({ error: 'Not found' }, 404);
    return c.json(record);
  });

  app.post('/api/approvals/:id/resolve', async (c) => {
    const record = getApproval(c.req.param('id'));
    if (!record) return c.json({ error: 'Not found' }, 404);
    let body: { status: 'approved' | 'denied'; reason?: string };
    try { body = await c.req.json() as typeof body; }
    catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (body.status !== 'approved' && body.status !== 'denied') {
      return c.json({ error: 'status must be "approved" or "denied"' }, 400);
    }
    resolveApproval(c.req.param('id'), body.status, body.reason);
    const updated = getApproval(c.req.param('id'));
    if (updated) approvalEvents.emit('resolved', updated);
    return c.json({ ok: true });
  });

  // Bulk-resolve every currently-pending approval in one shot (powers the
  // dashboard "Approve all" button). Resolves the pending set as of NOW —
  // approvals created after this call remain pending.
  app.post('/api/approvals/resolve-all', async (c) => {
    let body: { status?: 'approved' | 'denied'; reason?: string } = {};
    try { body = await c.req.json() as typeof body; }
    catch { /* empty body → default to approved */ }
    const status = body.status ?? 'approved';
    if (status !== 'approved' && status !== 'denied') {
      return c.json({ error: 'status must be "approved" or "denied"' }, 400);
    }
    const pending = listApprovals('pending', 200);
    for (const a of pending) {
      resolveApproval(a.id, status, body.reason);
      const updated = getApproval(a.id);
      if (updated) approvalEvents.emit('resolved', updated);
    }
    return c.json({ ok: true, resolved: pending.length, status });
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
      }, 5000);

      const cleanupConfig = () => {
        clearInterval(pingId);
        configEvents.off('change', onChange);
      };

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => { cleanupConfig(); resolve(); });
        });
      } finally {
        cleanupConfig(); // guard against exception before onAbort fires
      }
    });
  });

  // ── State stream — push-based replacement for polling ────────────────────
  // On connect: immediately sends a full primary-data snapshot (core, agents,
  // sessions, tasks, hive, notifications). Then pushes incremental updates
  // whenever agents/tasks/hive/notifications change, plus a refreshed core+status
  // every 30 s. Clients that use this stream don't need to poll /api/* at all
  // for primary data; they fall back to the old polling cycle for secondary data
  // (analytics, memory, vault, etc.) on a 120 s interval.
  app.get('/api/state/stream', async (c) => {
    return streamSSE(c, async (stream) => {
      const write: StateWriter = async (event) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };
      _stateWriters.add(write);

      // Immediate snapshot so new tabs skip the BOOTING state entirely.
      try {
        const snapshot = await buildStateSnapshot();
        await write({ type: 'snapshot', ...snapshot });
      } catch (err) {
        await write({ type: 'error', message: (err as Error).message });
      }

      // Periodic core+status refresh (can't be event-driven — it's a score calculation).
      const coreId = setInterval(async () => {
        try {
          _coreStatusCache = null; // bust cache so we recompute
          const core   = await getCachedCoreStatus();
          const status = { status: 'online', version: process.env.npm_package_version || '1.0.0', checkedAt: new Date().toISOString(), uptime: process.uptime(), model: config.voidai.model };
          await write({ type: 'core_update', core, status });
        } catch { /* stream closed — interval cleanup below */ }
      }, 30_000);

      // Keepalive so proxies don't close the connection.
      const pingId = setInterval(async () => {
        try { await write({ type: 'ping' }); }
        catch { clearInterval(pingId); }
      }, 25_000);

      const cleanup = () => {
        clearInterval(coreId);
        clearInterval(pingId);
        _stateWriters.delete(write);
      };

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => { cleanup(); resolve(); });
        });
      } finally {
        cleanup();
      }
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
    if (provider === 'kokoro') {
      try {
        const voices = await listKokoroVoices();
        return c.json({ voices, available: config.audio.kokoro.enabled });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    }
    if (provider === 'chatterbox') {
      try {
        const voices = await listChatterboxVoices();
        return c.json({ voices, available: config.audio.chatterbox.enabled });
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
    let body: { text?: string; agentId?: string; provider?: string; voice?: string; format?: 'mp3' | 'wav' | 'opus'; sync?: boolean };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'invalid JSON' }, 400); }
    const text = (body.text ?? '').trim();
    if (!text) return c.json({ error: 'text is required' }, 400);

    // Resolve voice config: explicit body fields > agent's stored config > env defaults.
    let provider: 'voidai' | 'elevenlabs' | 'hermes' | 'kokoro' | 'chatterbox' = body.provider === 'elevenlabs' ? 'elevenlabs' : body.provider === 'hermes' ? 'hermes' : body.provider === 'kokoro' ? 'kokoro' : body.provider === 'chatterbox' ? 'chatterbox' : 'voidai';
    let voiceId = body.voice?.trim() || '';
    if (body.agentId) {
      const agent = getAgentById(body.agentId);
      if (!agent) return c.json({ error: 'agent not found' }, 404);
      const resolved = resolveAgentVoice(agent);
      if (!body.provider) provider = resolved.provider;
      if (!voiceId)        voiceId = resolved.voiceId;
    }

    // Fast-path: check audio cache synchronously before enqueuing.
    const cacheKey = buildAudioCacheKey(provider, voiceId || 'default', 'default', text);
    const cached = getCachedAudio(cacheKey);
    if (cached) {
      return new Response(new Uint8Array(cached.audio_blob), {
        status: 200,
        headers: {
          'Content-Type':   cached.mime_type,
          'Content-Length': String(cached.audio_blob.length),
          'Cache-Control':  'no-store',
          'X-Voice-Id':     cached.voice_id,
          'X-Tts-Provider': cached.provider,
          'X-Cache-Hit':    '1',
        },
      });
    }

    // If caller explicitly wants sync (default behavior preserved), do blocking synthesis.
    if (body.sync !== false) {
      try {
        const out = await synthesize({
          text,
          provider,
          voiceId: voiceId || undefined,
          format:  body.format ?? 'mp3',
          agentName: body.agentId ? getAgentById(body.agentId)?.name : undefined,
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
    }

    // Async path: enqueue one job for the whole reply. The job worker splits
    // long text into chunks internally and synthesizes them sequentially, so no
    // single synthesis call exceeds the provider timeout while ordering is kept.
    const job = enqueueJob('tts_synthesize', {
      text,
      provider: provider as TtsProvider,
      voiceId,
      format: body.format ?? 'mp3',
      agentId: body.agentId,
      replyTarget: 'dashboard',
    }, 5);
    return c.json({ queued: true, jobId: job.id, jobIds: [job.id], cacheKey });
  });

  // ── Automation (Cron Jobs + Webhooks) ─────────────────────────────────────
  // NOTE: /api/crons/stream must be registered BEFORE /api/crons/:id so Hono
  // does not treat "stream" as an ID parameter.
  app.get('/api/crons/stream', (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });

      const onStarted = async (d: unknown) => {
        try { await stream.writeSSE({ event: 'run_started', data: JSON.stringify(d) }); } catch { /* closed */ }
      };
      const onChunk = async (d: unknown) => {
        try { await stream.writeSSE({ event: 'run_chunk', data: JSON.stringify(d) }); } catch { /* closed */ }
      };
      const onDone = async (d: unknown) => {
        try { await stream.writeSSE({ event: 'run_done', data: JSON.stringify(d) }); } catch { /* closed */ }
      };
      const onError = async (d: unknown) => {
        try { await stream.writeSSE({ event: 'run_error', data: JSON.stringify(d) }); } catch { /* closed */ }
      };

      cronEvents.on('run_started', onStarted);
      cronEvents.on('run_chunk',   onChunk);
      cronEvents.on('run_done',    onDone);
      cronEvents.on('run_error',   onError);

      const pingId = setInterval(async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); }
        catch { clearInterval(pingId); }
      }, 5000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          cronEvents.off('run_started', onStarted);
          cronEvents.off('run_chunk',   onChunk);
          cronEvents.off('run_done',    onDone);
          cronEvents.off('run_error',   onError);
          clearInterval(pingId);
          resolve();
        });
      });
    });
  });

  app.get('/api/crons', (c) => {
    const typeQ    = c.req.query('type')    ?? undefined;
    const enabledQ = c.req.query('enabled') ?? undefined;
    const enabled  = enabledQ === undefined ? undefined : enabledQ !== 'false' && enabledQ !== '0';
    return c.json(listCronJobs(typeQ, enabled));
  });

  app.post('/api/crons', async (c) => {
    let body: Partial<CronJob> & { enable_inbound?: boolean | string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!body.name)     return c.json({ error: 'name required' }, 400);
    if (!body.job_type) return c.json({ error: 'job_type required' }, 400);
    if (body.schedule && !cron.validate(body.schedule)) return c.json({ error: 'invalid cron expression' }, 400);
    const inbound_slug = (body.enable_inbound === true || body.enable_inbound === 'true') ? randomUUID() : null;
    const job = createCronJob({
      name:                    body.name,
      description:             body.description ?? null,
      schedule:                body.schedule    ?? null,
      enabled:                 body.enabled !== undefined && body.enabled !== null ? (body.enabled as unknown as number) : 1,
      job_type:                body.job_type,
      config:                  typeof body.config === 'string' ? body.config : JSON.stringify(body.config ?? {}),
      inbound_slug,
      on_complete_webhook_url: body.on_complete_webhook_url ?? null,
      created_by:              body.created_by ?? 'user',
      last_run_at:             null,
      next_run_at:             null,
    });
    syncJob(job.id);
    logHive('cron_job_created', `dashboard: Cron job "${job.name}" created`, undefined, { jobId: job.id, type: job.job_type });
    return c.json(job, 201);
  });

  app.patch('/api/crons/:id', async (c) => {
    const id = c.req.param('id');
    if (!getCronJob(id)) return c.json({ error: 'not found' }, 404);
    let body: Partial<CronJob>;
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (body.schedule && !cron.validate(body.schedule)) return c.json({ error: 'invalid cron expression' }, 400);
    const updated = updateCronJob(id, body);
    syncJob(id);
    logHive('cron_job_updated', `dashboard: Cron job "${updated?.name}" updated`, undefined, { jobId: id });
    return c.json(updated);
  });

  app.delete('/api/crons/:id', (c) => {
    const id  = c.req.param('id');
    const job = getCronJob(id);
    if (!job) return c.json({ error: 'not found' }, 404);
    deleteCronJob(id);
    syncJob(id);
    logHive('cron_job_deleted', `dashboard: Cron job "${job.name}" deleted`, undefined, { jobId: id });
    return c.json({ ok: true });
  });

  app.get('/api/crons/:id/runs', (c) => {
    const id    = c.req.param('id');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
    if (!getCronJob(id)) return c.json({ error: 'not found' }, 404);
    return c.json(listCronRuns(id, limit));
  });

  app.post('/api/crons/:id/trigger', async (c) => {
    const id  = c.req.param('id');
    const job = getCronJob(id);
    if (!job) return c.json({ error: 'not found' }, 404);
    try {
      const runId = await executeJobNow(id, 'manual');
      logHive('cron_inbound_trigger', `dashboard: Cron job "${job.name}" manually triggered`, undefined, { jobId: id, runId });
      return c.json({ ok: true, runId });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // ── Neuro Room ─────────────────────────────────────────────────────────────

  app.get('/api/room/token', async (c) => {
    if (!config.livekit.enabled) return c.json({ error: 'LiveKit not configured' }, 503);
    const identity = c.req.query('identity') ?? `user-${randomUUID()}`;
    try {
      const token = await generateRoomToken(identity);
      return c.json({ token, url: config.livekit.url, roomName: LIVEKIT_ROOM_NAME });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get('/api/room/status', async (c) => {
    try {
      const sessionId    = getRoomSessionId();
      const participants = config.livekit.enabled ? await getRoomParticipants() : [];
      const msgs         = getSessionMessages(sessionId);
      return c.json({
        sessionId,
        messageCount:   msgs.length,
        livekitEnabled: config.livekit.enabled,
        livekitUrl:     config.livekit.enabled ? config.livekit.url : null,
        participants,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/room/chat', async (c) => {
    let body: { message?: string; targetAgentIds?: string[]; roomSessionId?: string };
    try { body = await c.req.json() as typeof body; } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

    const message        = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return c.json({ error: 'message required' }, 400);

    if (body.targetAgentIds && !body.targetAgentIds.every((id: unknown) => typeof id === 'string')) {
      return c.json({ error: 'targetAgentIds must be an array of strings' }, 400);
    }
    const targetAgentIds = Array.isArray(body.targetAgentIds) && body.targetAgentIds.length > 0
      ? body.targetAgentIds
      : ['all'];
    const roomSessionId  = typeof body.roomSessionId === 'string' && body.roomSessionId.trim()
      ? body.roomSessionId.trim()
      : getRoomSessionId();

    return streamSSE(c, async (stream) => {
      const pingId = setInterval(async () => {
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); }
        catch { clearInterval(pingId); }
      }, 5000);
      try {
        await sendToRoom({
          message,
          targetAgentIds,
          roomSessionId,
          onEvent: async (evt) => {
            await stream.writeSSE({ data: JSON.stringify(evt) });
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try { await stream.writeSSE({ data: JSON.stringify({ type: 'error', error: msg }) }); } catch { /* stream closed */ }
      } finally {
        clearInterval(pingId);
      }
      await stream.writeSSE({ data: '[DONE]' });
    });
  });

  // ── Canvas (Design Studio) ─────────────────────────────────────────────
  // See docs/specs/design-tab-ASAGI-brief.md. The /canvas dashboard tab and
  // (eventually) the chat surface both call into the same canvas skill.
  app.get('/api/canvas/directions', async (c) => {
    const { DIRECTIONS } = await import('../skills/canvas');
    return c.json(DIRECTIONS);
  });

  app.get('/api/canvas/projects', async (c) => {
    const { listProjects } = await import('../skills/canvas');
    // Strip heavy HTML bodies from the list; UI pulls the active project separately.
    const list = listProjects().map(p => ({
      ...p,
      artifacts: p.artifacts.map(a => ({ ...a, content: a.type === 'html' ? `[${a.content.length} bytes]` : a.content })),
    }));
    return c.json(list);
  });

  app.get('/api/canvas/projects/:id', async (c) => {
    const { getProject } = await import('../skills/canvas');
    const p = getProject(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    return c.json(p);
  });

  app.delete('/api/canvas/projects/:id', async (c) => {
    const { deleteProject } = await import('../skills/canvas');
    const ok = deleteProject(c.req.param('id'));
    return c.json({ ok });
  });

  app.post('/api/canvas/generate', async (c) => {
    const body = await c.req.json<{
      brief: string;
      surface?: string;
      audience?: string;
      tone?: string;
      scale?: string;
      direction?: string;
      projectId?: string;
    }>().catch(() => ({} as any));

    if (!body.brief || typeof body.brief !== 'string') {
      return c.json({ error: 'brief is required' }, 400);
    }

    const { generate } = await import('../skills/canvas');
    return streamSSE(c, async (stream) => {
      let clientGone = false;
      c.req.raw.signal.addEventListener('abort', () => { clientGone = true; }, { once: true });
      // Keepalive: the canvas LLM call produces a multi-minute silent gap.
      // Proxied SSE connections (Cloudflare / QUIC) idle-time-out and reset
      // mid-stream — a comment heartbeat keeps the connection alive. Clients
      // ignore ':'-prefixed lines.
      const keepalive = setInterval(() => {
        stream.write(': keepalive\n\n').catch(() => { clientGone = true; });
      }, 15000);
      try {
        for await (const evt of generate({
          brief:     body.brief,
          surface:   body.surface   as any,
          audience:  body.audience,
          tone:      body.tone,
          scale:     body.scale     as any,
          direction: body.direction,
        }, { projectId: body.projectId })) {
          if (clientGone) break;
          try { await stream.writeSSE({ data: JSON.stringify(evt) }); }
          catch { clientGone = true; break; }
        }
      } catch (err) {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'error', payload: { message: (err as Error).message } }) });
        } catch { /* client gone */ }
      } finally {
        clearInterval(keepalive);
      }
      try { await stream.writeSSE({ data: '[DONE]' }); } catch { /* client gone */ }
    });
  });

  app.post('/api/canvas/iterate', async (c) => {
    const body = await c.req.json<{ artifactId: string; instruction: string }>().catch(() => ({} as any));
    if (!body.artifactId || !body.instruction) {
      return c.json({ error: 'artifactId and instruction are required' }, 400);
    }
    const { iterate } = await import('../skills/canvas');
    return streamSSE(c, async (stream) => {
      let clientGone = false;
      c.req.raw.signal.addEventListener('abort', () => { clientGone = true; }, { once: true });
      // Keepalive — see /api/canvas/generate above. The iterate LLM call has
      // the same multi-minute silent gap that trips proxied-SSE idle timeouts.
      const keepalive = setInterval(() => {
        stream.write(': keepalive\n\n').catch(() => { clientGone = true; });
      }, 15000);
      try {
        for await (const evt of iterate(body.artifactId, body.instruction)) {
          if (clientGone) break;
          try { await stream.writeSSE({ data: JSON.stringify(evt) }); }
          catch { clientGone = true; break; }
        }
      } catch (err) {
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: 'error', payload: { message: (err as Error).message } }) });
        } catch { /* client gone */ }
      } finally {
        clearInterval(keepalive);
      }
      try { await stream.writeSSE({ data: '[DONE]' }); } catch { /* client gone */ }
    });
  });

  app.post('/api/canvas/critique', async (c) => {
    const body = await c.req.json<{ artifactId: string; multiAgent?: boolean }>().catch(() => ({} as any));
    if (!body.artifactId) return c.json({ error: 'artifactId is required' }, 400);
    try {
      const { critique } = await import('../skills/canvas');
      const r = await critique(body.artifactId, { multiAgent: !!body.multiAgent });
      return c.json(r);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/api/canvas/export', async (c) => {
    const body = await c.req.json<{ artifactId: string; format: 'html' | 'pdf' | 'pptx' | 'zip' | 'mp4' }>()
      .catch(() => ({} as any));
    if (!body.artifactId || !body.format) {
      return c.json({ error: 'artifactId and format are required' }, 400);
    }
    try {
      const { exportArtifact } = await import('../skills/canvas');
      const r = await exportArtifact(body.artifactId, body.format);
      return c.json({ url: r.url, bytes: r.bytes });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Raw artifact viewer — used by the sandboxed iframe in the /canvas tab.
  // Served WITHOUT the dashboard token cookie because the iframe sandbox has
  // no allow-same-origin (per §7 of the brief), so cookies aren't sent. We
  // therefore re-auth via the same query token used elsewhere.
  app.get('/api/canvas/artifact/:id/file', async (c) => {
    const { getArtifact } = await import('../skills/canvas');
    const a = getArtifact(c.req.param('id'));
    if (!a) return c.text('not found', 404);

    // CSP that matches the iframe sandbox guarantees (§7 security rules):
    // allow inline styles & scripts but block any network egress beyond
    // Google Fonts (which the engine prompt explicitly permits).
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Content-Security-Policy', [
      "default-src 'none'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src data: https:",
      "script-src 'unsafe-inline'",
      "connect-src 'none'",
      "frame-ancestors 'self'",
    ].join('; '));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    return c.body(a.content);
  });

  // New-tab artifact viewer — opened by the ⧉ button in the /canvas tab.
  // Returns a trusted wrapper page that embeds the artifact in a sandboxed
  // iframe via `srcdoc` (no tokened URL reaches artifact code — see the
  // 2026-05-15 canvas design spec §2). `?token=` on THIS url is safe: the
  // sandboxed iframe has no allow-same-origin, so artifact script cannot read
  // this wrapper's location.
  app.get('/api/canvas/artifact/:id/view', async (c) => {
    const { getArtifact, withCspMeta, escapeHtmlAttr, escapeHtmlText } =
      await import('../skills/canvas');
    const a = getArtifact(c.req.param('id'));
    if (!a) return c.text('not found', 404);

    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");

    // srcdoc is HTML-only; other artifact types get a graceful message.
    if (a.type !== 'html') {
      return c.body(
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<title>Canvas artifact</title></head>' +
        '<body style="margin:0;height:100vh;display:flex;align-items:center;' +
        'justify-content:center;font-family:system-ui,sans-serif;' +
        'background:#0a0e1a;color:#cbd5e1">' +
        '<div>Preview unavailable for artifact type "' +
        escapeHtmlText(a.type) + '".</div></body></html>',
      );
    }

    // order matters: inject the CSP <meta> first, THEN attr-escape for srcdoc="..."
    const srcdoc = escapeHtmlAttr(withCspMeta(a.content));
    return c.body(
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + escapeHtmlText(a.title || 'Canvas artifact') + '</title>' +
      '<style>html,body{margin:0;height:100%}' +
      'iframe{border:0;display:block;width:100vw;height:100vh}</style>' +
      '</head><body>' +
      '<iframe sandbox="allow-scripts" srcdoc="' + srcdoc + '"></iframe>' +
      '</body></html>',
    );
  });

  // ── Cookie Sync — AI Cookie Sync Chrome extension ────────────────────────
  // POST /api/cookies/sync  — receives Chrome cookies, writes storage_state.json
  // GET  /api/cookies/health — no-auth health check used by the extension's Test button
  //
  // Adding a new service: add an entry to SERVICE_PATHS below, a matching entry
  // to SERVICES in /home/cookies/background.js, and reload the extension.
  // ──────────────────────────────────────────────────────────────────────────

  const COOKIE_SERVICE_PATHS: Record<string, string> = {
    notebooklm:  '/root/.notebooklm/storage_state.json',
    gemini:      '/root/.gemini/storage_state.json',
    grok:        '/root/.grok/storage_state.json',
    chatgpt:     '/root/.chatgpt/storage_state.json',
    venice:      '/root/.venice/storage_state.json',
    perplexity:  '/root/.perplexity/storage_state.json',
  };

  function cookieSameSite(raw: string | undefined): 'Strict' | 'Lax' | 'None' {
    const m: Record<string, 'Strict' | 'Lax' | 'None'> = {
      no_restriction: 'None', unspecified: 'None', lax: 'Lax', strict: 'Strict',
    };
    return m[(raw ?? '').toLowerCase()] ?? 'None';
  }

  app.post('/api/cookies/sync', async (c) => {
    let body: { service?: string; cookies?: Array<Record<string, unknown>> };
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

    const { service, cookies } = body;
    if (!service || typeof service !== 'string') return c.json({ error: 'Missing service' }, 400);
    if (!Array.isArray(cookies) || cookies.length === 0) return c.json({ error: 'Empty cookies' }, 400);

    const filePath = COOKIE_SERVICE_PATHS[service];
    if (!filePath) return c.json({ error: `Unknown service "${service}"` }, 400);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const storageState = {
      cookies: cookies.map((c) => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain,
        path:     (c.path as string) ?? '/',
        expires:  c.session || !c.expirationDate ? -1 : Math.floor(c.expirationDate as number),
        httpOnly: (c.httpOnly as boolean) ?? false,
        secure:   (c.secure   as boolean) ?? false,
        sameSite: cookieSameSite(c.sameSite as string | undefined),
      })),
      origins: [],
    };

    fs.writeFileSync(filePath, JSON.stringify(storageState, null, 2), 'utf-8');
    logger.info(`cookie-sync: ${cookies.length} cookies → ${filePath}`);
    return c.json({ ok: true, service, count: cookies.length });
  });

  // GET /api/jobs/:id — poll a queue job's status + result
  app.get('/api/jobs/:id', (c) => {
    const id = c.req.param('id');
    const { getDb } = require('../db') as typeof import('../db');
    const row = getDb().prepare('SELECT * FROM job_queue WHERE id = ?').get(id) as { id: string; type: string; status: string; attempts: number; max_attempts: number; priority: number; run_after: string | null; created_at: string; claimed_at: string | null; completed_at: string | null; result: string | null; error: string | null } | undefined;
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({
      id: row.id,
      type: row.type,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      priority: row.priority,
      runAfter: row.run_after,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
      result: row.result ? (() => { try { return JSON.parse(row.result!); } catch { return row.result; } })() : null,
      error: row.error,
    });
  });

  // POST /api/tools/execute — internal endpoint for out-of-process tool calls
  // (Gemini Live voice relay, LiveKit agent). 10s hard timeout; always returns
  // HTTP 200 so the caller receives a valid function response even on timeout/error.
  app.post('/api/tools/execute', async (c) => {
    // This route MUST always return 200 with a `result` field — an out-of-process
    // caller (Gemini Live / LiveKit agent) relays `result` back as the tool
    // output. A malformed body must not surface as a 500 (which carries no
    // `result`), so the JSON parse is part of the always-200 contract.
    let body: { tool?: string; args?: Record<string, unknown>; agent_id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ result: 'Error: invalid JSON body' });
    }
    const { tool, args, agent_id } = body ?? {};

    if (!tool || typeof tool !== 'string') {
      return c.json({ result: 'Error: missing tool name' });
    }

    let result = 'Error: tool execution failed';
    try {
      result = await Promise.race([
        (async () => {
          const { dispatchOpenAiTool } = await import('../tools/adapters/openai');
          const ctx: import('../tools/context').ToolContext = { agentId: agent_id ?? '' };
          return dispatchOpenAiTool(tool, JSON.stringify(args ?? {}), ctx);
        })(),
        new Promise<string>(resolve =>
          setTimeout(() => resolve('Error: tool timed out after 10s'), 10_000),
        ),
      ]);
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
    }

    return c.json({ result });
  });

  // POST /api/system/restart — responds immediately then exits so the process manager restarts
  app.post('/api/system/restart', (c) => {
    logger.info('dashboard: restart requested via dashboard');
    setTimeout(() => process.exit(0), 300);
    return c.json({ ok: true });
  });
}
