// Opencode CLI provider (local binary auth via `opencode` CLI).
//
// Mirrors src/providers/codex-cli.ts in shape: spawns the binary, parses its
// streamed output, yields text chunks. Opencode emits JSONL events on stdout
// when run with `--stream-json`.

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getAgentById } from '../db';
import { getComposioMcp, parseAgentToolkits } from '../composio/client';
import { ensureOpencodeMcpRegistered, syncComposioInOpencodeConfig } from '../system/opencode-config-writer';
import { buildAgentScopedEnv } from '../broker/subprocessSecrets';
import { createStreamScrubber, scrubOutput } from '../broker/scrubber';

export class OpencodeCliAuthError    extends Error { constructor(m='opencode login required') { super(m); this.name='OpencodeCliAuthError'; } }
export class OpencodeCliRateLimitError extends Error { constructor(m='opencode rate limit') { super(m); this.name='OpencodeCliRateLimitError'; } }

export interface OpencodeCliUsage {
  input_tokens?:   number;
  output_tokens?:  number;
}

export interface OpencodeCliOptions {
  prompt:        string;
  systemPrompt?: string;
  cwd?:          string;
  model?:        string;
  agentId?:      string | null;
  sessionId?:    string | null;
  runId?:        string | null;
  onUsage?:      (u: OpencodeCliUsage) => void;
  /** External abort (runaway/stop). SIGKILLs the opencode child. [Item I] */
  signal?:       AbortSignal;
}

// ── Concurrency gate ───────────────────────────────────────────────────────

let inflight = 0;
const queue: Array<() => void> = [];

// Proper semaphore handoff: a releaser passes its slot DIRECTLY to the next
// waiter without decrementing inflight. The old decrement-then-wake pattern let
// a fresh acquire() slip in between the decrement and the woken waiter's
// re-increment, over-admitting past the limit whenever concurrencyLimit > 1.
async function acquire(): Promise<void> {
  const limit = Math.max(1, config.opencode.concurrencyLimit);
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

export function getOpencodeCliQueueLength(): number { return queue.length; }

// ── Binary resolution ──────────────────────────────────────────────────────

function resolveCliBinary(): string | undefined {
  const cmd = config.opencode.cliCommand;
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

// ── Probe ──────────────────────────────────────────────────────────────────

export interface OpencodeProbeResult {
  ok:         boolean;
  binaryPath: string | null;
  version:    string | null;
  error:      string | null;
}

export async function probeOpencodeCli(): Promise<OpencodeProbeResult> {
  return new Promise(resolve => {
    const cmd = resolveCliBinary();
    if (!cmd) return resolve({ ok: false, binaryPath: null, version: null, error: 'opencode binary not found' });
    const child = spawn(cmd, ['--version']);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => resolve({ ok: false, binaryPath: cmd, version: null, error: err.message }));
    child.on('close', code => {
      if (code !== 0) return resolve({ ok: false, binaryPath: cmd, version: null, error: stderr.trim() || `exit ${code}` });
      resolve({ ok: true, binaryPath: cmd, version: stdout.trim(), error: null });
    });
  });
}

// ── Stream chat ──────────────────────────────────────────────────────────────

export async function* streamOpencodeCliChat(opts: OpencodeCliOptions): AsyncGenerator<string, void, void> {
  await acquire();
  try {
    yield* runQuery(opts);
  } finally {
    release();
  }
}

async function* runQuery(opts: OpencodeCliOptions): AsyncGenerator<string, void, void> {
  const cmd = resolveCliBinary();
  if (!cmd) { yield `[opencode binary not found at '${config.opencode.cliCommand}']`; return; }

  // NeuroClaw MCP registration
  if (config.mcp.enabled) {
    const headers: Record<string, string> = {};
    if (opts.agentId)   headers['x-neuroclaw-agent-id'] = opts.agentId;
    if (opts.sessionId) headers['x-neuroclaw-session-id'] = opts.sessionId;
    if (opts.runId)     headers['x-neuroclaw-run-id'] = opts.runId;
    try {
      await ensureOpencodeMcpRegistered({
        url: `http://127.0.0.1:${config.dashboard.port}/mcp`,
        headers,
      });
    } catch (err) {
      logger.warn('Opencode MCP registration failed before spawn', { agentId: opts.agentId, err: (err as Error).message });
    }
  }

  if (config.composio.enabled && opts.agentId) {
    const agent = getAgentById(opts.agentId);
    if (agent?.composio_enabled && agent.composio_user_id) {
      try {
        const endpoint = await getComposioMcp(agent.composio_user_id, parseAgentToolkits(agent.composio_toolkits));
        syncComposioInOpencodeConfig({ url: endpoint.url, headers: endpoint.headers });
      } catch (err) {
        logger.warn('Composio session mint failed (opencode-cli path)', { agentId: opts.agentId, err: (err as Error).message });
        syncComposioInOpencodeConfig(null);
      }
    } else {
      syncComposioInOpencodeConfig(null);
    }
  }

  const args = [
    'run',
    '--format', 'json',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.cwd)   args.push('--dir', opts.cwd);

  const fullPrompt = opts.systemPrompt
    ? `[SYSTEM]\n${opts.systemPrompt}\n[/SYSTEM]\n\n${opts.prompt}`
    : opts.prompt;

  // Pass via stdin
  args.push('-');

  const sub = await buildAgentScopedEnv(opts.agentId ?? null, 'opencode-cli', process.env);
  const scrubber = createStreamScrubber(sub.resolved);
  const child: ChildProcess = spawn(cmd, args, { env: sub.env });
  // External abort (runaway/stop): SIGKILL the child. The exit check below already
  // has a `signalCode !== null` branch, so a killed child throws (closes as error)
  // rather than returning truncated output as success. [Item I]
  const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, config.opencode.timeoutMs);

  child.stdin?.write(fullPrompt);
  child.stdin?.end();

  let buf = '';
  const stdout = child.stdout!;
  const stderr = child.stderr!;
  let stderrAccum = '';
  let stdoutErrorEvent: { type?: string; message?: string; error?: string } | null = null;
  let lastEvent: string | null = null;
  const STDERR_MAX = 50_000; // cap to prevent runaway memory on hung processes
  stderr.on('data', d => {
    stderrAccum += d.toString('utf8');
    if (stderrAccum.length > STDERR_MAX) stderrAccum = stderrAccum.slice(-STDERR_MAX);
  });

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
          stderrAccum += '[stdout-nonjson] ' + line + '\n';
          continue;
        }
        if (evt?.type) lastEvent = evt.type;

        // opencode --format json emits:
        //   { type:'text',        part: { text: '...' } }           — text chunk
        //   { type:'step_finish', part: { tokens: { input, output } } } — usage
        //   { type:'error',       ... }                              — error
        if (evt.type === 'text' && typeof evt.part?.text === 'string' && evt.part.text) {
          const safe = scrubber.push(evt.part.text);
          if (safe) yield safe;
        } else if (evt.type === 'step_finish' && evt.part?.tokens && opts.onUsage) {
          opts.onUsage({
            input_tokens:  evt.part.tokens.input,
            output_tokens: evt.part.tokens.output,
          });
        } else if (evt.type === 'error') {
          stdoutErrorEvent = evt;
        }
      }
    }

    const tail = scrubber.flush();
    if (tail) yield tail;

    await new Promise<void>(resolve => child.on('close', () => resolve()));
    // child.exitCode is null when the process was killed by a signal (e.g. SIGKILL
    // from the timeout timer); check signalCode too so we don't silently return
    // truncated output instead of surfacing the timeout as an error.
    if ((child.exitCode !== 0 && child.exitCode !== null) || child.signalCode !== null) {
      const rawCombined = [stderrAccum.trim(), stdoutErrorEvent ? extractMessage(stdoutErrorEvent) : '', lastEvent ? `(last event: ${lastEvent})` : '']
        .filter(Boolean)
        .join(' | ');
      const combined = scrubOutput(rawCombined, sub.resolved).scrubbed;
      const signal = child.signalCode ? ` (signal: ${child.signalCode})` : '';
      const summary = combined || `(no stderr or error event${signal}; check ~/.opencode logs)`;
      logger.error('opencode run exited non-zero', { exitCode: child.exitCode, signal: child.signalCode, error: combined.slice(0, 1000), lastEvent, model: opts.model });
      if (/auth|login|credentials|expired/i.test(combined)) throw new OpencodeCliAuthError(summary.slice(0, 400));
      if (/rate.?limit|429|quota/i.test(combined))           throw new OpencodeCliRateLimitError(summary.slice(0, 400));
      throw new Error(`opencode run failed (${child.exitCode}${signal}): ${summary.slice(0, 800)}`);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function extractMessage(evt: unknown): string {
  if (!evt) return '';
  if (typeof evt === 'string') return evt;
  if (typeof evt !== 'object') return String(evt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = evt as any;
  // opencode --format json error shape: { type:'error', error:{ name, data:{ message } } }
  if (e.error?.data?.message) return String(e.error.data.message);
  if (e.error?.message)       return String(e.error.message);
  if (e.message)              return String(e.message);
  return JSON.stringify(e).slice(0, 400);
}

export async function fetchOpencodeModels(): Promise<string[]> {
  return new Promise(resolve => {
    const cmd = resolveCliBinary();
    if (!cmd) return resolve([]);
    const child = spawn(cmd, ['models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', () => {
      const models = out.split('\n').map(l => l.trim()).filter(Boolean);
      resolve(models);
    });
    child.on('error', () => resolve([]));
  });
}

export function logOpencodeCliInfo(): void {
  logger.info('Opencode backend: opencode-cli', {
    cliCommand:       config.opencode.cliCommand,
    timeoutMs:        config.opencode.timeoutMs,
    concurrencyLimit: config.opencode.concurrencyLimit,
  });
}
