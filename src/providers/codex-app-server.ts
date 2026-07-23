// Codex `app-server` provider (subscription auth via the local `codex` binary).
//
// Unlike codex-cli.ts (which spawns `codex exec --json` per message — text-only,
// cold-start, no in-process tools), this drives a single persistent
// `codex app-server` JSON-RPC 2.0 server over stdio. Codex agents get full
// NeuroClaw tool access via `dynamicTools` (registered on thread/start) +
// `item/tool/call` server-initiated callbacks and true token streaming via
// `item/agentMessage/delta`.
//
// Threads are PERSISTENT per (sessionId, agentId): a durable SQLite registry
// maps each pair to a Codex threadId, and every turn after the first calls
// `thread/resume` to refresh developerInstructions/model before `turn/start`.
// Only a change in the tool-name fingerprint forces a fresh `thread/start`;
// prompt/model changes ride the free per-turn resume override.
//
// Spec: .planning/specs/2026-07-09-codex-hybrid-persistent-thread.md
// Protocol shapes verified against codex 0.128.0 via `codex app-server generate-ts`.
//
// Tool building + dispatch deliberately reuse the OpenAI adapter
// (buildOpenAiTools / dispatchOpenAiTool) so the dynamicTools schemas are the
// SAME zod-4-correct JSON Schemas the OpenAI Agents backbone and HTTP-MCP server
// emit (z.toJSONSchema + stripSchemaMeta), and so meta-tools (search_tools /
// get_tool_schema / call_tool), gating, and sub-agent lockdown all work. The
// spec's hand-rolled findTool dispatcher predated the zod-4 migration and would
// have produced empty schemas — not used.

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { getDb } from '../db';
import { logger } from '../utils/logger';
import { buildAgentScopedEnv } from '../broker/subprocessSecrets';
import { createStreamScrubber } from '../broker/scrubber';
import { buildOpenAiTools, dispatchOpenAiTool } from '../tools/adapters/openai';
import { buildComposioOpenAiTools } from '../tools/adapters/composio';
import type { ToolContext } from '../tools/context';
import type { CodexCliUsage } from './codex-cli';
import type Anthropic from '@anthropic-ai/sdk';

// ── Error types ───────────────────────────────────────────────────────────
export class CodexAppServerAuthError      extends Error { constructor(m = 'codex login required (run `codex login`)') { super(m); this.name = 'CodexAppServerAuthError'; } }
export class CodexAppServerRateLimitError extends Error { constructor(m = 'codex rate limit')                          { super(m); this.name = 'CodexAppServerRateLimitError'; } }
export class CodexAppServerCrashError     extends Error { constructor(m = 'codex app-server exited unexpectedly')      { super(m); this.name = 'CodexAppServerCrashError'; } }

// ── Protocol shapes (subset, from `codex app-server generate-ts`) ───────────
interface DynamicToolSpec { namespace?: string; name: string; description: string; inputSchema: unknown; deferLoading?: boolean; }
interface DynamicToolCallParams { threadId: string; turnId: string; callId: string; namespace: string | null; tool: string; arguments: unknown; }
interface DynamicToolCallResponse { contentItems: Array<{ type: 'inputText'; text: string }>; success: boolean; }
interface AgentMessageDeltaNotification { threadId: string; turnId: string; itemId: string; delta: string; }
interface TokenUsageBreakdown { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; }
interface ThreadTokenUsageUpdatedNotification { threadId: string; turnId: string; tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null }; }

// ── JSON-RPC transport ──────────────────────────────────────────────────────
type ServerRequestHandler = (params: unknown, id: number | string) => Promise<unknown>;

class CodexAppServerProcess {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buf = '';
  private initialized = false;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, ServerRequestHandler>();      // one handler per method (Map.set semantics)
  private emitter = new EventEmitter();
  private startPromise: Promise<void> | null = null;

  constructor() { this.emitter.setMaxListeners(0); }

  isRunning(): boolean { return this.proc !== null && !this.proc.killed && this.proc.exitCode === null; }

  // Idempotent + concurrency-safe cold start. Returns immediately when the
  // process is already up AND the initialize handshake has completed. While a
  // cold start is in flight, every concurrent caller awaits the SAME promise, so
  // a second caller can never send thread/start before the handshake finishes
  // (and no second process is ever spawned over the first).
  start(env: Record<string, string | undefined>): Promise<void> {
    if (this.isRunning() && this.initialized) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start(env).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async _start(env: Record<string, string | undefined>): Promise<void> {
    // Tear down any half-alive process left by a prior init that failed AFTER
    // spawn (e.g. the initialize request rejected without an exit event), so we
    // never orphan a running child by overwriting this.proc below.
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
    const cmd = config.codex.cliCommand;
    const proc = spawn(cmd, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.buf = '';
    this.initialized = false;

    proc.stdout!.setEncoding('utf-8');
    proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr!.setEncoding('utf-8');
    proc.stderr!.on('data', (d: string) => { const s = d.trim(); if (s) logger.debug('codex app-server stderr', { line: s.slice(0, 400) }); });

    proc.on('exit', (code, signal) => this.onExit(code, signal));
    proc.on('error', (err) => { logger.error('codex app-server spawn error', { err: err.message }); this.onExit(null, null); });

    // Required handshake before any thread/start. `experimentalApi: true` is
    // mandatory to use `dynamicTools` on thread/start (the server rejects it
    // otherwise: "thread/start.dynamicTools requires experimentalApi capability").
    await this.request('initialize', {
      clientInfo: { name: 'neuroclaw', title: 'NeuroClaw', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.initialized = true;
    logger.info('codex app-server: started + initialized', { cmd });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const proc = this.proc;
    if (!proc || !proc.stdin) throw new CodexAppServerCrashError('codex app-server not running');
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try { proc.stdin!.write(JSON.stringify(payload) + '\n'); }
      catch (e) { this.pending.delete(id); reject(e as Error); }
    });
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void { this.handlers.set(method, handler); }
  on(event: string, listener: (...args: unknown[]) => void): void   { this.emitter.on(event, listener); }
  once(event: string, listener: (...args: unknown[]) => void): void { this.emitter.once(event, listener); }
  off(event: string, listener: (...args: unknown[]) => void): void  { this.emitter.off(event, listener); }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any;
    try { msg = JSON.parse(line); } catch { logger.warn('codex app-server: non-JSON line', { line: line.slice(0, 200) }); return; }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(this.toError(msg.error));
      else p.resolve(msg.result);
      return;
    }

    // Server-initiated request (has id + method): dispatch to a handler, write the response.
    if (msg.id !== undefined && msg.method) {
      const handler = this.handlers.get(msg.method);
      if (!handler) {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `No handler for ${msg.method}` } });
        return;
      }
      handler(msg.params, msg.id)
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result }))
        .catch((err: Error) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } }));
      return;
    }

    // Notification (method, no id) — emit namespaced by threadId where present.
    if (msg.method) {
      const tid = msg.params?.threadId;
      const suffix = tid ? `:${tid}` : '';
      this.emitter.emit(`${msg.method}${suffix}`, msg.params);
    }
  }

  private write(msg: object): void {
    try { this.proc?.stdin?.write(JSON.stringify(msg) + '\n'); }
    catch (e) { logger.warn('codex app-server: write failed', { err: (e as Error).message }); }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toError(err: any): Error {
    const m = typeof err?.message === 'string' ? err.message : JSON.stringify(err);
    if (/unauthor|login|401/i.test(m)) return new CodexAppServerAuthError(m);
    if (/rate.?limit|quota|429/i.test(m)) return new CodexAppServerRateLimitError(m);
    return new Error(m);
  }

  private onExit(code: number | null, signal: string | null): void {
    logger.warn('codex app-server: exited', { code, signal });
    const err = new CodexAppServerCrashError(`codex app-server exited (code=${code}, signal=${signal})`);
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.emitter.emit('process_exit', err);
    this.proc = null;
    this.initialized = false;
    // Threads + the dispatch handler die with the process — reset shared state.
    threadCtx.clear();
    _toolDispatchRegistered = false;
  }

  async stop(): Promise<void> {
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
  }
}

// ── Module state ──────────────────────────────────────────────────────────
let _instance: CodexAppServerProcess | null = null;
// Per-turn tool-call routing: each thread maps to the ToolContext of the
// agent/session that started it, so item/tool/call dispatches with the CORRECT
// per-turn context even though the app-server process is shared across all Codex
// agents. (Without this, a single shared dispatch handler would attribute every
// agent's tool calls to whichever agent started the process first.)
const threadCtx = new Map<string, ToolContext>();   // threadId → ToolContext
let _toolDispatchRegistered = false;

function getProcess(): CodexAppServerProcess {
  if (!_instance) _instance = new CodexAppServerProcess();
  return _instance;
}

// ── Persistent thread registry ───────────────────────────────────────────────
// Non-ephemeral Codex threads survive a `codex app-server` child-process restart
// on disk under ~/.codex/sessions/, but we need a durable map from our
// (sessionId, agentId) pair back to the threadId. The registry is backed by the
// `codex_threads` SQLite table (created in db.ts) with an in-memory hot cache.
//
// Lifecycle:
//   * tool fingerprint unchanged  -> thread/resume + turn/start (native memory)
//   * tool fingerprint changed    -> thread/archive old, thread/start fresh
//
// The tool-name fingerprint is the ONLY rebuild trigger. developerInstructions
// and model are refreshed unconditionally every turn via thread/resume.

interface CodexThreadRegistryEntry {
  sessionId: string;
  agentId: string;
  threadId: string;
  toolFingerprint: string;
  lastUsedAt: string;
}

const CODEX_THREAD_REGISTRY = new Map<string, CodexThreadRegistryEntry>();
let _registryLoaded = false;

function registryKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId ?? ''}`;
}

function loadThreadRegistry(): void {
  if (_registryLoaded) return;
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT session_id AS sessionId, agent_id AS agentId, thread_id AS threadId, tool_fingerprint AS toolFingerprint, last_used_at AS lastUsedAt FROM codex_threads'
    ).all() as CodexThreadRegistryEntry[];
    for (const row of rows) {
      CODEX_THREAD_REGISTRY.set(registryKey(row.sessionId, row.agentId), row);
    }
    _registryLoaded = true;
    logger.debug('codex app-server: loaded thread registry', { count: rows.length });
  } catch (err) {
    logger.error('codex app-server: failed to load thread registry', { error: (err as Error).message });
  }
}

function lookupThread(sessionId: string, agentId: string): CodexThreadRegistryEntry | null {
  loadThreadRegistry();
  return CODEX_THREAD_REGISTRY.get(registryKey(sessionId, agentId)) ?? null;
}

function upsertThread(entry: CodexThreadRegistryEntry): void {
  CODEX_THREAD_REGISTRY.set(registryKey(entry.sessionId, entry.agentId), entry);
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO codex_threads (session_id, agent_id, thread_id, tool_fingerprint, last_used_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, agent_id) DO UPDATE SET
         thread_id = excluded.thread_id,
         tool_fingerprint = excluded.tool_fingerprint,
         last_used_at = excluded.last_used_at`
    ).run(entry.sessionId, entry.agentId, entry.threadId, entry.toolFingerprint, entry.lastUsedAt);
  } catch (err) {
    logger.error('codex app-server: failed to persist thread registry', { error: (err as Error).message });
  }
}

function deleteThread(sessionId: string, agentId: string): void {
  CODEX_THREAD_REGISTRY.delete(registryKey(sessionId, agentId));
  try {
    const db = getDb();
    db.prepare('DELETE FROM codex_threads WHERE session_id = ? AND agent_id = ?').run(sessionId, agentId);
  } catch (err) {
    logger.error('codex app-server: failed to delete thread registry', { error: (err as Error).message });
  }
}

function computeToolFingerprint(tools: DynamicToolSpec[]): string {
  const names = tools.map((t) => t.name).sort();
  return createHash('sha256').update(JSON.stringify(names)).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

// Per-thread turn lock: only one turn may run on a given persistent thread at a
// time. Codex threads are stateful; concurrent turns on the same threadId would
// interleave and corrupt history.
class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return this.releaseFn();
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(this.releaseFn()));
    });
  }
  private releaseFn(): () => void {
    return () => {
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next();
      } else {
        this.locked = false;
      }
    };
  }
}

const threadMutexes = new Map<string, Mutex>();

function getThreadMutex(threadId: string): Mutex {
  if (!threadMutexes.has(threadId)) threadMutexes.set(threadId, new Mutex());
  return threadMutexes.get(threadId)!;
}

interface AnthropicTextBlock { type: 'text'; text: string; }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown; }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | unknown; }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | { type: string };

// Convert Anthropic-shaped history (used by the Claude CLI path and stored in
// our DB) into Responses-API items that can be injected into a fresh Codex
// thread. This preserves tool calls/results instead of stripping them like the
// old text flatten.
function anthropicHistoryToCodexItems(history: Anthropic.Messages.MessageParam[]): unknown[] {
  const items: unknown[] = [];
  for (const msg of history) {
    if (msg.role === 'user') {
      const content: unknown[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) content.push({ type: 'input_text', text: msg.content });
      } else {
        for (const block of msg.content as AnthropicContentBlock[]) {
          if (block.type === 'text' && (block as AnthropicTextBlock).text?.trim()) {
            content.push({ type: 'input_text', text: (block as AnthropicTextBlock).text });
          } else if (block.type === 'tool_result') {
            const tb = block as AnthropicToolResultBlock;
            const resultText = typeof tb.content === 'string' ? tb.content : JSON.stringify(tb.content ?? '');
            content.push({ type: 'input_text', text: `[tool_result ${tb.tool_use_id}]: ${resultText}` });
          }
        }
      }
      if (content.length > 0) items.push({ type: 'message', role: 'user', content });
    } else if (msg.role === 'assistant') {
      const content: unknown[] = [];
      const toolCalls: unknown[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) content.push({ type: 'output_text', text: msg.content });
      } else {
        for (const block of msg.content as AnthropicContentBlock[]) {
          if (block.type === 'text' && (block as AnthropicTextBlock).text?.trim()) {
            content.push({ type: 'output_text', text: (block as AnthropicTextBlock).text });
          } else if (block.type === 'tool_use') {
            const tb = block as AnthropicToolUseBlock;
            toolCalls.push({
              type: 'function_call',
              call_id: tb.id,
              name: tb.name,
              arguments: JSON.stringify(tb.input ?? {}),
            });
          }
        }
      }
      if (content.length > 0) items.push({ type: 'message', role: 'assistant', content });
      for (const tc of toolCalls) items.push(tc);
    }
  }
  return items;
}

async function startOrResumeThread(
  proc: CodexAppServerProcess,
  ctx: ToolContext,
  systemPrompt: string | undefined,
  model: string | undefined,
  cwd: string,
  dynamicTools: DynamicToolSpec[],
): Promise<{ threadId: string; isFresh: boolean }> {
  const sessionId = ctx.sessionId ?? '';
  const agentId = ctx.agentId ?? '';
  const fingerprint = computeToolFingerprint(dynamicTools);
  const existing = lookupThread(sessionId, agentId);

  if (existing && existing.toolFingerprint === fingerprint) {
    await proc.request('thread/resume', {
      threadId: existing.threadId,
      developerInstructions: systemPrompt,
      model,
    });
    upsertThread({ ...existing, lastUsedAt: nowIso() });
    logger.debug('codex app-server: resumed persistent thread', { threadId: existing.threadId, sessionId, agentId });
    return { threadId: existing.threadId, isFresh: false };
  }

  if (existing) {
    logger.info('codex app-server: tool roster changed, archiving old thread', {
      sessionId, agentId, oldThreadId: existing.threadId,
    });
    proc.request('thread/archive', { threadId: existing.threadId }).catch(() => {});
    deleteThread(sessionId, agentId);
  }

  const startParams: Record<string, unknown> = {
    cwd,
    developerInstructions: systemPrompt,
    dynamicTools,
    approvalPolicy: 'never',
    ephemeral: false,
    sandbox: config.codex.sandboxMode,
  };
  if (model) startParams.model = model;
  const res = await proc.request<{ thread: { id: string } }>('thread/start', startParams);
  const threadId = res.thread.id;
  upsertThread({ sessionId, agentId, threadId, toolFingerprint: fingerprint, lastUsedAt: nowIso() });
  logger.info('codex app-server: started persistent thread', { threadId, sessionId, agentId });
  return { threadId, isFresh: true };
}

async function injectHistoryItems(proc: CodexAppServerProcess, threadId: string, history: Anthropic.Messages.MessageParam[]): Promise<void> {
  const items = anthropicHistoryToCodexItems(history);
  if (items.length === 0) return;
  try {
    await proc.request('thread/inject_items', { threadId, items });
    logger.debug('codex app-server: injected history items', { threadId, count: items.length });
  } catch (err) {
    logger.warn('codex app-server: failed to inject history items', { threadId, error: (err as Error).message });
  }
}

let evictionTimer: NodeJS.Timeout | null = null;
const CODEX_THREAD_IDLE_TTL_HOURS = 24;

/** Evict idle persistent threads: archive the Codex thread and delete the row. */
export function evictIdleCodexThreads(): { archived: number; errors: number } {
  const cutoff = new Date(Date.now() - CODEX_THREAD_IDLE_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const db = getDb();
  let archived = 0;
  let errors = 0;
  try {
    const rows = db.prepare(
      'SELECT session_id, agent_id, thread_id FROM codex_threads WHERE last_used_at < ?'
    ).all(cutoff) as Array<{ session_id: string; agent_id: string; thread_id: string }>;
    for (const row of rows) {
      try {
        getProcess().request('thread/archive', { threadId: row.thread_id }).catch(() => {});
        deleteThread(row.session_id, row.agent_id);
        archived++;
      } catch {
        errors++;
      }
    }
    if (archived > 0) {
      logger.info('codex app-server: evicted idle threads', { archived, errors });
    }
  } catch (err) {
    logger.error('codex app-server: eviction sweep failed', { error: (err as Error).message });
    errors++;
  }
  return { archived, errors };
}

function startEvictionScheduler(): void {
  if (evictionTimer) return;
  evictionTimer = setInterval(() => evictIdleCodexThreads(), 60 * 60 * 1000);
}

// Strip OPENAI_API_KEY so Codex uses ~/.codex/auth.json subscription tokens.
// SECURITY POSTURE (intentional): the process is shared across all Codex agents, so
// by design we do NOT inject any agent's broker secrets into its environment — a
// long-lived shared process must never hold one agent's decrypted secrets where
// another agent's sandboxed shell could read them. Codex's own native shell thus
// runs without broker secrets (and is read-only by default). Secret-injected shell
// work goes through the NeuroClaw `bash_run` tool, dispatched via item/tool/call
// with the correct PER-AGENT ToolContext (threadCtx) and per-call broker injection
// — the same model the CLI providers use.
//
// WS-A SCOPE-OUT: this singleton persistent process is NOT covered by the Phase 2
// per-call git attribution guarantee. Its env is fixed at cold start, so stamping
// NC_AGENT/NC_SESSION per turn would misattribute every subsequent call to the
// first agent that started the process. Git ops initiated by codex-app-server's
// native shell are therefore shim-active only if the global PATH happens to include
// the shim (it does not by default), and attribution is best-effort/stale. The
// supported write path is the already-attributed `bash_run` MCP tool. Do NOT add
// per-call env injection here without a process-per-agent redesign.
function buildChildEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  return env;
}

// ── Dynamic tools ───────────────────────────────────────────────────────────
async function buildDynamicTools(ctx: ToolContext): Promise<DynamicToolSpec[]> {
  // Reuse the canonical OpenAI tool list: core tools + the 3 meta-tools, with
  // zod-4-correct JSON Schemas. (Spec Section 3's zodToJsonSchema(.schema) path
  // is dead under zod 4 — buildOpenAiTools is the live, correct source.)
  const base = buildOpenAiTools(ctx);
  // Composio meta-tools (COMPOSIO_SEARCH_TOOLS, COMPOSIO_MULTI_EXECUTE_TOOL, …)
  // when the agent is opted in; [] otherwise. Without this, codex agents were
  // the only plane silently missing Composio (backbone/claude-cli both wire it).
  // COMPOSIO_* dispatch already works: registerToolDispatch → dispatchOpenAiTool
  // routes COMPOSIO_* to dispatchComposioTool (openai.ts).
  const composio = await buildComposioOpenAiTools(ctx);
  return [...base, ...composio].map((t) => ({
    name:        t.function.name,
    description: t.function.description ?? '',
    inputSchema: t.function.parameters ?? { type: 'object', properties: {} },
  }));
}

// ── Tool dispatcher (registered once per process lifetime) ──────────────────
// The handler is ctx-AGNOSTIC: it resolves the originating agent/session per call
// from threadCtx[params.threadId], so a shared process serves every Codex agent
// with the correct context.
function registerToolDispatch(proc: CodexAppServerProcess): void {
  if (_toolDispatchRegistered) return;
  _toolDispatchRegistered = true;

  proc.onServerRequest('item/tool/call', async (raw: unknown): Promise<DynamicToolCallResponse> => {
    const params = raw as DynamicToolCallParams;
    // Route to the agent/session that started this thread (set before turn/start).
    // Empty fallback only if the thread is unknown (shouldn't happen).
    const ctx = threadCtx.get(params.threadId) ?? {};
    logger.debug('codex app-server: item/tool/call', { tool: params.tool, threadId: params.threadId, agentId: ctx.agentId });
    try {
      // dispatchOpenAiTool handles meta-tools, registry lookup, gating, and the
      // sub-agent lockdown — and returns a JSON string result.
      const argsStr = JSON.stringify(params.arguments ?? {});
      const result = await dispatchOpenAiTool(params.tool, argsStr, ctx);
      return { success: true, contentItems: [{ type: 'inputText', text: result }] };
    } catch (err) {
      return { success: false, contentItems: [{ type: 'inputText', text: (err as Error).message }] };
    }
  });

  // Token refresh: read ~/.codex/auth.json and map to ChatgptAuthTokensRefreshResponse.
  proc.onServerRequest('account/chatgptAuthTokens/refresh', async () => {
    const authFile = path.join(process.env.HOME ?? '', '.codex', 'auth.json');
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    const tokens = (auth.tokens ?? {}) as { accessToken?: string; chatgptAccountId?: string; chatgptPlanType?: string | null };
    return {
      accessToken:      tokens.accessToken      ?? '',
      chatgptAccountId: tokens.chatgptAccountId ?? '',
      chatgptPlanType:  tokens.chatgptPlanType  ?? null,
    };
  });

  // Approval prompts: auto-approve (we set approvalPolicy:'never', but handle residuals).
  for (const method of [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'applyPatchApproval',
    'execCommandApproval',
  ]) {
    proc.onServerRequest(method, async () => ({ approved: true }));
  }

  proc.onServerRequest('mcpServer/elicitation/request', async (raw: unknown) => {
    const p = raw as { serverName?: string };
    return p?.serverName === 'neuroclaw'
      ? { action: 'accept', content: null, _meta: null }
      : { action: 'decline', content: null, _meta: null };
  });
}

// ── Per-turn subscription (attach listeners BEFORE turn/start — no delta race) ─
function createTurnSubscription(proc: CodexAppServerProcess, threadId: string) {
  const queue: string[] = [];
  let done = false;
  let pendingError: Error | undefined;
  let wake: (() => void) | null = null;
  let latestUsage: TokenUsageBreakdown | undefined;
  let sawCompletion = false;
  const ping = () => { wake?.(); wake = null; };

  // Bound the turn. Without this, a wedged codex (deltas then silence, or one
  // that never sends turn/completed) keeps `drain` blocked on its wake promise
  // forever — the SSE stream never closes, the session queue jams, and the run
  // heartbeats "thinking" indefinitely. Mirror codex-cli's hard cap
  // (config.codex.timeoutMs). On expiry we fail the turn; the persistent thread
  // survives and the next turn will resume it.
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  const failTimeout = () => {
    if (done) return;
    const mins = Math.round(config.codex.timeoutMs / 60000);
    pendingError = new Error(`codex app-server turn exceeded hard timeout (${mins}m)`);
    done = true;
    ping();
  };

  const onDelta = (raw: unknown) => { const p = raw as AgentMessageDeltaNotification; if (p?.delta) { queue.push(p.delta); ping(); } };
  const onUsageNote = (raw: unknown) => { const p = raw as ThreadTokenUsageUpdatedNotification; if (p?.tokenUsage?.last) latestUsage = p.tokenUsage.last; };
  const onCompleted = () => { sawCompletion = true; done = true; ping(); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onError = (raw: unknown) => { const p = raw as any; pendingError = new Error(p?.error?.message ?? 'codex turn error'); done = true; ping(); };
  const onProcExit = (err: unknown) => { pendingError = err as Error; done = true; ping(); };

  // ── Item I3: external abort (runaway/stop) → turn/interrupt ────────────────
  // The app-server is a persistent JSON-RPC process, so there is no child to
  // SIGKILL — instead cancel THIS turn via the turn/interrupt RPC. That needs
  // {threadId, turnId}, but turnId is otherwise discarded (turnPromise is awaited
  // only for error surfacing). Capture it from the turn/started notification and
  // buffer an interrupt that raced ahead of it. After interrupt we rely on the
  // follow-up turn/completed (status "interrupted") to unblock drain(); hardTimer
  // is the backstop if the server never emits it.
  let turnId: string | null = null;
  let interruptRequested = false;
  let interruptSent = false;
  const sendInterrupt = () => {
    if (interruptSent || !turnId) return;
    interruptSent = true;
    proc.request('turn/interrupt', { threadId, turnId })
      .catch((e: Error) => logger.warn('codex app-server: turn/interrupt failed', { threadId, err: e.message }));
  };
  const onStarted = (raw: unknown) => {
    // Tolerant extraction: accept the documented turn.id plus turnId/id fallbacks
    // so a minor param-shape drift across codex versions can't silently break capture.
    const p = raw as { turn?: { id?: string }; turnId?: string; id?: string };
    turnId = p?.turn?.id ?? p?.turnId ?? p?.id ?? null;
    if (turnId && interruptRequested) sendInterrupt();
  };
  const requestInterrupt = () => { interruptRequested = true; if (turnId) sendInterrupt(); };

  proc.on(`item/agentMessage/delta:${threadId}`, onDelta);
  proc.on(`thread/tokenUsage/updated:${threadId}`, onUsageNote);
  proc.once(`turn/started:${threadId}`, onStarted);
  proc.once(`turn/completed:${threadId}`, onCompleted);
  proc.once(`error:${threadId}`, onError);
  proc.once('process_exit', onProcExit);
  hardTimer = setTimeout(failTimeout, config.codex.timeoutMs);

  const dispose = () => {
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    proc.off(`item/agentMessage/delta:${threadId}`, onDelta);
    proc.off(`thread/tokenUsage/updated:${threadId}`, onUsageNote);
    proc.off(`turn/started:${threadId}`, onStarted);
    proc.off(`turn/completed:${threadId}`, onCompleted);
    proc.off(`error:${threadId}`, onError);
    proc.off('process_exit', onProcExit);
  };

  async function* drain(
    scrubber: ReturnType<typeof createStreamScrubber>,
    onUsage?: (u: CodexCliUsage) => void,
  ): AsyncGenerator<string, void, void> {
    try {
      while (!done || queue.length > 0) {
        while (queue.length > 0) { const safe = scrubber.push(queue.shift()!); if (safe) yield safe; }
        if (!done) await new Promise<void>((res) => { wake = res; });
      }
      const tail = scrubber.flush();
      if (tail) yield tail;
      if (pendingError) throw pendingError;
      if (latestUsage && onUsage) {
        onUsage({
          input_tokens:            latestUsage.inputTokens,
          output_tokens:           latestUsage.outputTokens,
          cached_input_tokens:     latestUsage.cachedInputTokens,
          reasoning_output_tokens: latestUsage.reasoningOutputTokens,
        });
      }
    } finally {
      dispose();
    }
  }

  return { drain, fail: (e: Error) => { pendingError = e; done = true; ping(); }, requestInterrupt, get sawCompletion() { return sawCompletion; }, dispose };
}

// ── Public API ───────────────────────────────────────────────────────────────
export interface CodexAppServerOptions {
  prompt:        string;
  systemPrompt?: string;
  model?:        string;
  agentId?:      string | null;
  sessionId?:    string | null;
  cwd?:          string;
  onUsage?:      (u: CodexCliUsage) => void;
  /**
   * Prior conversation history (Anthropic-shaped). When supplied, a fresh
   * persistent thread is seeded with structured Responses-API items via
   * `thread/inject_items` so tool calls/results are preserved. Resumed threads
   * already hold their native history and ignore this field.
   */
  history?:      Anthropic.Messages.MessageParam[];
  /** External abort (runaway/stop) — wired to the turn/interrupt RPC to cancel
   *  the in-flight turn on this persistent thread. [Item I3] */
  signal?:       AbortSignal;
}

export async function* streamCodexAppServerChat(
  opts: CodexAppServerOptions,
): AsyncGenerator<string, void, void> {
  const ctx: ToolContext = { agentId: opts.agentId ?? null, sessionId: opts.sessionId ?? null };
  const sub = await buildAgentScopedEnv(opts.agentId ?? null, 'codex-app-server', buildChildEnv());
  const scrubber = createStreamScrubber(sub.resolved);
  const cwd = opts.cwd ?? process.cwd();

  const proc = getProcess();
  // Always await — start() is idempotent and a no-op on a warm process, but on
  // a cold/in-flight start it makes concurrent turns share one handshake so none
  // sends thread/start before initialize completes.
  await proc.start(buildChildEnv());
  startEvictionScheduler();

  registerToolDispatch(proc);   // no-op after first call (guarded); ctx-agnostic

  const dynamicTools = await buildDynamicTools(ctx);
  const { threadId, isFresh } = await startOrResumeThread(
    proc, ctx, opts.systemPrompt, opts.model, cwd, dynamicTools,
  );
  // Route this thread's tool calls to THIS turn's agent/session.
  threadCtx.set(threadId, ctx);

  // Seed a fresh thread with structured history so prior turns (including tool
  // context) are visible to the model. Resumed threads already hold native history.
  if (isFresh && opts.history && opts.history.length > 0) {
    await injectHistoryItems(proc, threadId, opts.history);
  }

  // Serialize turns on the same persistent thread.
  const release = await getThreadMutex(threadId).acquire();
  try {
    // Attach listeners BEFORE starting the turn so no agentMessage/delta is missed.
    const turnSub = createTurnSubscription(proc, threadId);

    // Item I3: external abort (runaway/stop) cancels THIS turn via turn/interrupt.
    // Already-aborted → request now (buffered until turn/started supplies the id).
    let onAbort: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) turnSub.requestInterrupt();
      else { onAbort = () => turnSub.requestInterrupt(); opts.signal.addEventListener('abort', onAbort, { once: true }); }
    }

    const turnPromise = proc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: opts.prompt }],
    }).catch((e: Error) => { turnSub.fail(e); });

    try {
      yield* turnSub.drain(scrubber, opts.onUsage);
      await turnPromise;
    } finally {
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      threadCtx.delete(threadId);
    }
  } finally {
    release();
  }
}

// Best-effort shutdown for process exit / tests.
export async function stopCodexAppServer(): Promise<void> {
  if (_instance) { await _instance.stop(); _instance = null; }
}
