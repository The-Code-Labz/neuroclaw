import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { createNeuroclawMcpServer } from '../mcp/neuroclaw-mcp-server';
import { getComposioMcp, parseAgentToolkits } from '../composio/client';
import { config as appConfig } from '../config';
import { getAgentById } from '../db';

function resolveCliBinary(): string | undefined {
  const cmd = config.claude.cliCommand;
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;

  const which = spawnSync('which', [cmd], { encoding: 'utf-8' });
  const found = which.stdout?.trim();
  if (found) return found;

  // Fall back to known install locations — useful when the parent process
  // was started without ~/.local/bin in PATH.
  const home = process.env.HOME ?? '';
  const candidates = [
    home && path.join(home, '.local/bin', cmd),
    home && path.join(home, '.claude/local', cmd),
    `/usr/local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export interface ClaudeCliUsage {
  input_tokens?:  number;
  output_tokens?: number;
  total_cost_usd?: number;
}

export interface ClaudeCliOptions {
  prompt:        string;
  systemPrompt?: string;
  cwd?:          string;
  sessionId?:    string;
  model?:        string;
  maxTurns?:     number;
  /**
   * When true, the bundled Claude binary's built-in tools (Bash/Read/Write/Edit/
   * Grep/Glob) are enabled for this call. Defaults to false (text-only).
   */
  execEnabled?:  boolean;
  /**
   * The agent's id, threaded through to the in-process NeuroClaw MCP server
   * so its tool handlers know which agent is calling them.
   */
  agentId?:      string | null;
  /**
   * Called once when the stream's terminal `result` message is observed.
   * Carries real usage and cost from the Agent SDK.
   */
  onUsage?:      (usage: ClaudeCliUsage) => void;
}

export class ClaudeCliRateLimitError extends Error {
  constructor(message = 'Claude CLI returned 429 (rate limit)') {
    super(message);
    this.name = 'ClaudeCliRateLimitError';
  }
}

export class ClaudeCliAuthError extends Error {
  constructor(message = 'Claude CLI authentication failed') {
    super(message);
    this.name = 'ClaudeCliAuthError';
  }
}

// ── Concurrency gate ──────────────────────────────────────────────────────────
// Subscription auth has tight rate limits, so we serialize CLI calls. Default 1.

let inflight = 0;
const queue: Array<() => void> = [];

async function acquire(): Promise<void> {
  const limit = Math.max(1, config.claude.concurrencyLimit);
  if (inflight < limit) {
    inflight++;
    return;
  }
  await new Promise<void>(resolve => queue.push(resolve));
  inflight++;
}

function release(): void {
  inflight--;
  const next = queue.shift();
  if (next) next();
}

export function getClaudeCliQueueLength(): number {
  return queue.length;
}

// ── Env scrubbing ─────────────────────────────────────────────────────────────

function buildChildEnv(): Record<string, string | undefined> {
  // Strip ANTHROPIC_API_KEY so the bundled CLI uses subscription OAuth.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Stream a single Claude completion through the local Claude CLI / Agent SDK.
 * Yields text chunks. Tool execution is owned by the caller, so we disable
 * built-in tools and pass a custom system prompt.
 */
export async function* streamClaudeCliChat(
  opts: ClaudeCliOptions,
): AsyncGenerator<string, void, void> {
  await acquire();
  try {
    yield* runQuery(opts);
  } finally {
    release();
  }
}

async function* runQuery(opts: ClaudeCliOptions): AsyncGenerator<string, void, void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.claude.timeoutMs);

  try {
    const cliPath = resolveCliBinary();
    const tools: string[] = opts.execEnabled
      ? ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob']
      : [];
    // In-process NeuroClaw MCP server so Claude-CLI agents can call our
    // memory / vault / agent-comms / spawn tools natively. MCP_ENABLED gates
    // this — if MCP is off, the server is omitted and the agent is text-only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpServers: Record<string, any> = {};
    if (config.mcp.enabled) {
      mcpServers.neuroclaw = createNeuroclawMcpServer({ agentId: opts.agentId ?? null, sessionId: opts.sessionId ?? null });
    }
    // Composio: per-agent identity + optional toolkit allowlist. Both the
    // global API key AND the agent's composio_enabled flag must be set.
    if (appConfig.composio.enabled && opts.agentId) {
      const agent = getAgentById(opts.agentId);
      if (agent?.composio_enabled && agent.composio_user_id) {
        try {
          const endpoint = await getComposioMcp(agent.composio_user_id, parseAgentToolkits(agent.composio_toolkits));
          mcpServers.composio = { type: 'http', url: endpoint.url, headers: endpoint.headers };
        } catch (err) {
          logger.warn('Composio session mint failed (claude-cli path)', { agentId: opts.agentId, err: (err as Error).message });
        }
      }
    }
    // User-managed MCP server registry — every enabled, ready row is mounted
    // directly as an `http` mcpServer so Claude can call its tools natively
    // (it'll surface them as mcp__<server>__<tool> automatically). The same
    // tools also appear synthesized in our unified registry, so the OpenAI
    // and HTTP-MCP runtimes can call them via NeuroClaw's tool dispatch.
    if (config.mcp.enabled) {
      try {
        const { getEnabledServersWithTools } = await import('../mcp/mcp-registry');
        const { parseMcpHeaders } = await import('../db');
        for (const { row } of getEnabledServersWithTools()) {
          if (mcpServers[row.name]) continue;   // don't shadow neuroclaw/composio
          const headers = parseMcpHeaders(row.headers);
          mcpServers[row.name] = {
            type:    'http',
            url:     row.url,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          };
        }
      } catch (err) {
        logger.warn('MCP registry load failed (claude-cli path)', { err: (err as Error).message });
      }
    }
    const hasMcpServers = Object.keys(mcpServers).length > 0;
    // Pre-approve our own MCP tools so they don't trigger the user-permission
    // prompt. Bash/Read/Write/etc still go through the standard permission flow.
    const allowedTools = hasMcpServers
      ? [
          'mcp__neuroclaw__search_memory',
          'mcp__neuroclaw__search_vault',
          'mcp__neuroclaw__write_vault_note',
          'mcp__neuroclaw__save_session_summary',
          'mcp__neuroclaw__compact_context',
          'mcp__neuroclaw__message_agent',
          'mcp__neuroclaw__assign_task_to_agent',
          'mcp__neuroclaw__list_agents',
          'mcp__neuroclaw__spawn_agent',
          'mcp__neuroclaw__list_temp_agents',
          'mcp__neuroclaw__log_handoff',
          'mcp__neuroclaw__create_checkpoint',
          'mcp__neuroclaw__get_context_pack',
          // User-registered MCP servers (dashboard) — auto-approve every tool
          // they expose so the chat doesn't stall on a permission prompt.
          ...Object.keys(mcpServers)
            .filter(k => k !== 'neuroclaw' && k !== 'composio')
            .map(k => `mcp__${k}__*`),
        ]
      : undefined;
    const iter = query({
      prompt: opts.prompt,
      options: {
        cwd:                       opts.cwd ?? process.cwd(),
        systemPrompt:              opts.systemPrompt,
        model:                     opts.model,
        maxTurns:                  opts.maxTurns ?? config.claude.maxTurns,
        tools,
        includePartialMessages:    true,
        env:                       buildChildEnv(),
        abortController:           abort,
        settingSources:            [],
        ...(hasMcpServers ? { mcpServers } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
      },
    });

    for await (const msg of iter as AsyncIterable<SDKMessage>) {
      const chunk = extractTextChunk(msg);
      if (chunk) yield chunk;

      // Terminal result message — extract real usage + cost.
      if (msg.type === 'result' && opts.onUsage) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = msg;
        opts.onUsage({
          input_tokens:   m.usage?.input_tokens,
          output_tokens:  m.usage?.output_tokens,
          total_cost_usd: m.total_cost_usd,
        });
      }

      const err = detectError(msg);
      if (err) throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

function extractTextChunk(msg: SDKMessage): string | null {
  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      return ev.delta.text;
    }
  }
  return null;
}

function detectError(msg: SDKMessage): Error | null {
  if (msg.type === 'assistant' && msg.error) {
    if (msg.error === 'rate_limit')           return new ClaudeCliRateLimitError();
    if (msg.error === 'authentication_failed') return new ClaudeCliAuthError();
    return new Error(`Claude CLI error: ${msg.error}`);
  }
  if (msg.type === 'result' && msg.subtype && msg.subtype !== 'success') {
    return new Error(`Claude CLI ended with subtype=${msg.subtype}`);
  }
  return null;
}

// ── Subprocess fallback ───────────────────────────────────────────────────────
// Used by the diagnostics command and as a sanity probe.

export interface CliProbeResult {
  ok:         boolean;
  binaryPath: string | null;
  version:    string | null;
  error?:     string;
}

export async function probeClaudeCli(): Promise<CliProbeResult> {
  return new Promise(resolve => {
    const cmd = resolveCliBinary() ?? config.claude.cliCommand;
    const child = spawn(cmd, ['--version'], { env: buildChildEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      resolve({ ok: false, binaryPath: null, version: null, error: err.message });
    });
    child.on('close', code => {
      if (code === 0) {
        resolve({ ok: true, binaryPath: cmd, version: stdout.trim() });
      } else {
        resolve({ ok: false, binaryPath: cmd, version: null, error: stderr.trim() || `exit ${code}` });
      }
    });
  });
}

export function logClaudeCliInfo(): void {
  logger.info('Claude backend: claude-cli', {
    cliCommand:       config.claude.cliCommand,
    maxTurns:         config.claude.maxTurns,
    timeoutMs:        config.claude.timeoutMs,
    concurrencyLimit: config.claude.concurrencyLimit,
  });
}
