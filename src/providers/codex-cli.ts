// Codex CLI provider (subscription auth via the local `codex` binary).
//
// Mirrors src/providers/claude-cli.ts in shape: spawns the binary, parses its
// streamed output, yields text chunks. Codex emits JSONL events on stdout
// when run with `--json`:
//
//   {"type":"thread.started","thread_id":"…"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
//   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
//
// We yield each `item.completed.item.text` as a chunk (Codex doesn't
// stream char-by-char in this mode — it emits whole messages — but the chat
// UI handles whole-message yields fine).

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getAgentById } from '../db';
import { getComposioMcp, parseAgentToolkits } from '../composio/client';
import { syncComposioInCodexConfig } from '../system/codex-config-writer';

export class CodexCliAuthError    extends Error { constructor(m='codex login required (run `codex login`)') { super(m); this.name='CodexCliAuthError'; } }
export class CodexCliRateLimitError extends Error { constructor(m='codex rate limit')                       { super(m); this.name='CodexCliRateLimitError'; } }

export interface CodexCliUsage {
  input_tokens?:   number;
  output_tokens?:  number;
  cached_input_tokens?:    number;
  reasoning_output_tokens?: number;
}

export interface CodexCliOptions {
  prompt:        string;
  systemPrompt?: string;
  cwd?:          string;
  model?:        string;
  agentId?:      string | null;
  sessionId?:    string | null;
  /** Override sandbox for this call (default from config.codex.sandboxMode). */
  sandbox?:      'read-only' | 'workspace-write' | 'danger-full-access';
  onUsage?:      (u: CodexCliUsage) => void;
}

// ── Concurrency gate ───────────────────────────────────────────────────────
// Subscription auth has a per-window rate limit; serialize calls by default.

let inflight = 0;
const queue: Array<() => void> = [];

async function acquire(): Promise<void> {
  const limit = Math.max(1, config.codex.concurrencyLimit);
  if (inflight < limit) { inflight++; return; }
  await new Promise<void>(resolve => queue.push(resolve));
  inflight++;
}
function release(): void {
  inflight--;
  const next = queue.shift();
  if (next) next();
}

export function getCodexCliQueueLength(): number { return queue.length; }

// ── Binary resolution ──────────────────────────────────────────────────────

function resolveCliBinary(): string | undefined {
  const cmd = config.codex.cliCommand;
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;
  const which = spawnSync('which', [cmd], { encoding: 'utf-8' });
  const found = which.stdout?.trim();
  if (found) return found;
  const home = process.env.HOME ?? '';
  const candidates = [
    home && path.join(home, '.local/bin', cmd),
    `/usr/local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
  ].filter(Boolean) as string[];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return undefined;
}

// ── Env scrubbing ──────────────────────────────────────────────────────────
// Strip OPENAI_API_KEY so the child process is forced to use ChatGPT
// subscription auth from ~/.codex/auth.json.

function buildChildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.OPENAI_API_KEY;
  return env;
}

// ── Probe ──────────────────────────────────────────────────────────────────

export interface CodexProbeResult {
  ok:         boolean;
  binaryPath: string | null;
  version:    string | null;
  authMode:   string | null;     // 'chatgpt' | 'apikey' | null
  error?:     string;
}

export async function probeCodexCli(): Promise<CodexProbeResult> {
  return new Promise(resolve => {
    const cmd = resolveCliBinary();
    if (!cmd) return resolve({ ok: false, binaryPath: null, version: null, authMode: null, error: 'codex binary not found' });
    const child = spawn(cmd, ['--version'], { env: buildChildEnv() });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => resolve({ ok: false, binaryPath: cmd, version: null, authMode: null, error: err.message }));
    child.on('close', code => {
      if (code !== 0) return resolve({ ok: false, binaryPath: cmd, version: null, authMode: null, error: stderr.trim() || `exit ${code}` });
      let authMode: string | null = null;
      try {
        const home = process.env.HOME ?? '';
        const authFile = path.join(home, '.codex', 'auth.json');
        if (fs.existsSync(authFile)) {
          const parsed = JSON.parse(fs.readFileSync(authFile, 'utf-8')) as { auth_mode?: string };
          authMode = parsed.auth_mode ?? null;
        }
      } catch { /* ignore */ }
      resolve({ ok: true, binaryPath: cmd, version: stdout.trim(), authMode });
    });
  });
}

// ── Stream chat ────────────────────────────────────────────────────────────

export async function* streamCodexCliChat(opts: CodexCliOptions): AsyncGenerator<string, void, void> {
  await acquire();
  try {
    yield* runQuery(opts);
  } finally {
    release();
  }
}

async function* runQuery(opts: CodexCliOptions): AsyncGenerator<string, void, void> {
  const cmd = resolveCliBinary();
  if (!cmd) { yield `[codex binary not found at '${config.codex.cliCommand}']`; return; }

  // Composio: if this agent has it enabled, mint (or reuse) a session and
  // sync the [mcp_servers.composio] block to ~/.codex/config.toml. Codex
  // concurrencyLimit=1 means we never race a running codex against this write.
  if (config.composio.enabled && opts.agentId) {
    const agent = getAgentById(opts.agentId);
    if (agent?.composio_enabled && agent.composio_user_id) {
      try {
        const endpoint = await getComposioMcp(agent.composio_user_id, parseAgentToolkits(agent.composio_toolkits));
        syncComposioInCodexConfig({ url: endpoint.url, headers: endpoint.headers });
      } catch (err) {
        logger.warn('Composio session mint failed (codex-cli path)', { agentId: opts.agentId, err: (err as Error).message });
        syncComposioInCodexConfig(null);
      }
    } else {
      // Agent not opted in — strip any stale composio block from a prior agent's call.
      syncComposioInCodexConfig(null);
    }
  }

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', opts.sandbox ?? config.codex.sandboxMode,
  ];
  if (opts.model) args.push('-m', opts.model);
  if (opts.cwd)   args.push('-C', opts.cwd);

  // Codex doesn't have a --system flag; prepend systemPrompt to the user
  // prompt when provided. Codex still uses its internal harness on top.
  const fullPrompt = opts.systemPrompt
    ? `[SYSTEM]\n${opts.systemPrompt}\n[/SYSTEM]\n\n${opts.prompt}`
    : opts.prompt;

  // Pass via stdin so we don't blow the command-line length limit.
  args.push('-');

  const child: ChildProcess = spawn(cmd, args, { env: buildChildEnv() });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, config.codex.timeoutMs);

  // Write the prompt and close stdin.
  child.stdin?.write(fullPrompt);
  child.stdin?.end();

  let buf = '';
  const stdout = child.stdout!;
  const stderr = child.stderr!;
  let stderrAccum = '';
  // Codex sometimes reports errors as JSON events on stdout (e.g. {"type":"error", ...})
  // rather than via stderr. Capture them so we can surface a useful message.
  let stdoutErrorEvent: { type?: string; message?: string; error?: string; reason?: string } | null = null;
  let lastEvent: string | null = null;
  stderr.on('data', d => { stderrAccum += d.toString('utf8'); });

  try {
    for await (const chunkBuf of stdout) {
      buf += chunkBuf.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let evt: any;
        try { evt = JSON.parse(line); } catch {
          // Non-JSON lines on stdout — keep them as a fallback diagnostic.
          stderrAccum += '[stdout-nonjson] ' + line + '\n';
          continue;
        }
        if (evt?.type) lastEvent = evt.type;

        if (evt.type === 'item.completed' && evt.item) {
          const it = evt.item;
          if (it.type === 'agent_message' && typeof it.text === 'string' && it.text) {
            yield it.text;
          }
          // Other item types: tool_call, sandbox_exec, code_change. Surfaced
          // as visible chunks for now so the user sees what the agent did.
          else if (typeof it.title === 'string' || typeof it.text === 'string') {
            const label = it.type ? `[${it.type}] ` : '';
            const content = String(it.title ?? it.text ?? '');
            if (content) yield `\n${label}${content}\n`;
          }
        } else if (evt.type === 'turn.completed' && evt.usage && opts.onUsage) {
          opts.onUsage({
            input_tokens:            evt.usage.input_tokens,
            output_tokens:           evt.usage.output_tokens,
            cached_input_tokens:     evt.usage.cached_input_tokens,
            reasoning_output_tokens: evt.usage.reasoning_output_tokens,
          });
        } else if (evt.type === 'error' || evt.type === 'turn.failed' || evt.type === 'thread.error') {
          stdoutErrorEvent = evt;
        }
      }
    }

    // Wait for child to actually close so we can read exit code.
    await new Promise<void>(resolve => child.on('close', () => resolve()));
    if (child.exitCode !== 0 && child.exitCode !== null) {
      const stderrTrimmed = stderrAccum.trim();
      // The error payload is nested several layers deep:
      // turn.failed → { error: { message: '{"type":"error","error":{"message": "..."}}' } }
      // Walk down to find the most specific human-readable string.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const extractMessage = (e: any): string => {
        if (!e) return '';
        if (typeof e === 'string') {
          // The CLI sometimes wraps an OpenAI API error response as a JSON string.
          try {
            const parsed = JSON.parse(e);
            return extractMessage(parsed);
          } catch { return e; }
        }
        if (typeof e !== 'object') return String(e);
        if (e.message)  return extractMessage(e.message) || extractMessage(e.error);
        if (e.error)    return extractMessage(e.error);
        if (e.reason)   return extractMessage(e.reason);
        return JSON.stringify(e).slice(0, 400);
      };
      const eventErr = stdoutErrorEvent ? extractMessage(stdoutErrorEvent) : '';
      const combined = [stderrTrimmed, eventErr, lastEvent ? `(last event: ${lastEvent})` : ''].filter(Boolean).join(' | ');
      const summary = combined || `(no stderr or error event; check ~/.codex logs)`;
      logger.error('codex exec exited non-zero', { exitCode: child.exitCode, stderr: stderrTrimmed.slice(0, 1000), stdoutErrorEvent, lastEvent, model: opts.model });
      if (/auth|login|credentials|expired/i.test(combined)) throw new CodexCliAuthError(summary.slice(0, 400));
      if (/rate.?limit|429|quota/i.test(combined))           throw new CodexCliRateLimitError(summary.slice(0, 400));
      throw new Error(`codex exec failed (${child.exitCode}): ${summary.slice(0, 800)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function logCodexCliInfo(): void {
  logger.info('Codex backend: codex-cli', {
    cliCommand:       config.codex.cliCommand,
    timeoutMs:        config.codex.timeoutMs,
    concurrencyLimit: config.codex.concurrencyLimit,
    sandboxMode:      config.codex.sandboxMode,
  });
}
