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
import { ensureCodexMcpRegistered, syncComposioInCodexConfig } from '../system/codex-config-writer';
import { buildAgentScopedEnv } from '../broker/subprocessSecrets';
import { createStreamScrubber, scrubOutput } from '../broker/scrubber';
import { prepareProviderGitEnv } from '../system/nc-git-env';

export class CodexCliAuthError    extends Error { constructor(m='codex login required (run `codex login`)') { super(m); this.name='CodexCliAuthError'; } }
export class CodexCliRateLimitError extends Error { constructor(m='codex rate limit')                       { super(m); this.name='CodexCliRateLimitError'; } }

// Models valid with ChatGPT subscription auth. Anything else fails at the server.
export const CODEX_CHATGPT_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'] as const;

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
  runId?:        string | null;
  /** Override sandbox for this call (default from config.codex.sandboxMode). */
  sandbox?:      'read-only' | 'workspace-write' | 'danger-full-access';
  onUsage?:      (u: CodexCliUsage) => void;
  /** External abort (runaway/stop). SIGKILLs the codex exec child. [Item I] */
  signal?:       AbortSignal;
}

// ── Concurrency gate ───────────────────────────────────────────────────────
// Subscription auth has a per-window rate limit; serialize calls by default.

let inflight = 0;
const queue: Array<() => void> = [];

// Proper semaphore handoff: a releaser passes its slot DIRECTLY to the next
// waiter without decrementing inflight. The old decrement-then-wake pattern
// let a fresh acquire() slip in between the decrement and the woken waiter's
// re-increment, over-admitting past the limit whenever concurrencyLimit > 1.
async function acquire(): Promise<void> {
  const limit = Math.max(1, config.codex.concurrencyLimit);
  if (inflight < limit) { inflight++; return; }
  // Waiter path: inflight is NOT incremented here — release() hands us the
  // releaser's still-counted slot.
  await new Promise<void>(resolve => queue.push(resolve));
}
function release(): void {
  const next = queue.shift();
  if (next) { next(); return; } // slot transfers to the waiter, count unchanged
  inflight--;
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
  error:      string | null;
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
      resolve({ ok: true, binaryPath: cmd, version: stdout.trim(), authMode, error: null });
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

  // NeuroClaw MCP: Codex reads MCP server metadata from ~/.codex/config.toml.
  // Write the block immediately before process spawn so this one-shot Codex
  // turn carries the correct agent/session/run context into tool calls.
  if (config.mcp.enabled) {
    const headers: Record<string, string> = {};
    if (opts.agentId)   headers['x-neuroclaw-agent-id'] = opts.agentId;
    if (opts.sessionId) headers['x-neuroclaw-session-id'] = opts.sessionId;
    if (opts.runId)     headers['x-neuroclaw-run-id'] = opts.runId;
    try {
      await ensureCodexMcpRegistered({
        url: `http://127.0.0.1:${config.dashboard.port}/mcp`,
        headers,
      });
    } catch (err) {
      logger.warn('Codex MCP registration failed before spawn', { agentId: opts.agentId, err: (err as Error).message });
    }
  }

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

  // Inject the agent's full scoped broker secret set into the codex subprocess
  // env, and prepare a scrubber to redact those values from streamed output.
  // When this one-shot spawn lands in the main checkout, also route git writes
  // through the coordination-lock shim with real attribution (Phase 2 WS-A).
  const sub = await buildAgentScopedEnv(opts.agentId ?? null, 'codex-cli', buildChildEnv());
  const childEnv = await prepareProviderGitEnv(sub.env, opts.agentId ?? undefined, opts.sessionId ?? undefined, opts.cwd ?? process.cwd());
  const scrubber = createStreamScrubber(sub.resolved);
  const child: ChildProcess = spawn(cmd, args, { env: childEnv });
  let timedOut = false;
  let aborted = false;
  // External abort (runaway/stop): SIGKILL the child. codex-cli's exit check
  // (below) has no signalCode branch, so we track `aborted` and throw explicitly
  // after close — otherwise a partial-output kill is recorded as success. [Item I]
  const onAbort = () => { aborted = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, config.codex.timeoutMs);

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
            const safe = scrubber.push(it.text);
            if (safe) yield safe;
          }
          // Other item types: tool_call, sandbox_exec, code_change. Surfaced
          // as visible chunks for now so the user sees what the agent did.
          else if (typeof it.title === 'string' || typeof it.text === 'string') {
            const label = it.type ? `[${it.type}] ` : '';
            const content = String(it.title ?? it.text ?? '');
            if (content) {
              const safe = scrubber.push(`\n${label}${content}\n`);
              if (safe) yield safe;
            }
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

    const tail = scrubber.flush();
    if (tail) yield tail;

    // Wait for child to actually close so we can read exit code.
    await new Promise<void>(resolve => child.on('close', () => resolve()));

    // External abort (runaway/stop) SIGKILLs the child, leaving exitCode === null
    // which the non-zero check below deliberately skips. Without this throw, an
    // aborted run that had already streamed partial output would be recorded as a
    // normal success and the run never closed as error. [Item I / ASAGI FATAL fix]
    if (aborted) {
      throw new Error('codex-cli aborted by external signal (runaway/stop)');
    }

    // Timeout SIGKILL leaves exitCode === null, which the non-zero check below
    // deliberately skips — so a timed-out run used to END SILENTLY with
    // truncated output and no signal to the user. Report back instead.
    if (timedOut) {
      const min = Math.round(config.codex.timeoutMs / 60000);
      logger.warn('codex exec hit hard timeout — yielding report-back', { model: opts.model, timeoutMs: config.codex.timeoutMs, lastEvent });
      yield `\n\n---\n🛑 **Stopping early to report back** — the codex run hit its ${min}-minute limit before finishing. ` +
            `Partial progress (if any) is shown above. Narrow the task or reply to have me continue.`;
      return;
    }

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
      const rawCombined = [stderrTrimmed, eventErr, lastEvent ? `(last event: ${lastEvent})` : ''].filter(Boolean).join(' | ');
      // Scrub broker secret values out of the error text before it is thrown
      // or logged — codex stderr/error events can echo an injected value.
      const combined = scrubOutput(rawCombined, sub.resolved).scrubbed;
      const summary = combined || `(no stderr or error event; check ~/.codex logs)`;
      logger.error('codex exec exited non-zero', { exitCode: child.exitCode, error: combined.slice(0, 1000), lastEvent, model: opts.model });
      if (/auth|login|credentials|expired/i.test(combined)) throw new CodexCliAuthError(summary.slice(0, 400));
      if (/rate.?limit|429|quota/i.test(combined))           throw new CodexCliRateLimitError(summary.slice(0, 400));
      throw new Error(`codex exec failed (${child.exitCode}): ${summary.slice(0, 800)}`);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchCodexModels(): Promise<string[]> {
  return new Promise(resolve => {
    const cmd = config.codex.cliCommand;
    const child = spawn(cmd, ['debug', 'models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', () => {
      try {
        const json = JSON.parse(out) as { models?: Array<{ slug?: string }> };
        resolve((json.models ?? []).map(m => m.slug ?? '').filter(Boolean));
      } catch {
        resolve([]);
      }
    });
    child.on('error', () => resolve([]));
  });
}

export function logCodexCliInfo(): void {
  logger.info('Codex backend: codex-cli', {
    cliCommand:       config.codex.cliCommand,
    timeoutMs:        config.codex.timeoutMs,
    concurrencyLimit: config.codex.concurrencyLimit,
    sandboxMode:      config.codex.sandboxMode,
  });
}
