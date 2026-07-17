// Antigravity CLI provider — drives the `agy` binary via subprocess.
// Replaces the previous OAuth/HTTP approach which relied on the OpenCode
// antigravity plugin and violated Google's ToS.
//
// Auth is handled entirely by the `agy` binary (Google OAuth via browser on
// first launch). This harness just spawns it, passes the prompt via --print,
// and streams stdout as plain text.

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { buildAgentScopedEnv } from '../broker/subprocessSecrets';
import { createStreamScrubber, scrubOutput } from '../broker/scrubber';

// ── Error types ──────────────────────────────────────────────────────────────

export class AntigravityAuthError extends Error {
  constructor(m = 'agy authentication required — run `agy` once to log in via Google OAuth') {
    super(m); this.name = 'AntigravityAuthError';
  }
}

export class AntigravityRateLimitError extends Error {
  constructor(m = 'Antigravity rate limit or quota exceeded') {
    super(m); this.name = 'AntigravityRateLimitError';
  }
}

// ── Binary resolution ────────────────────────────────────────────────────────

export function resolveCliBinary(): string | undefined {
  const cmd = config.antigravity.cliCommand;
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

// ── Settings / model ─────────────────────────────────────────────────────────

function resolveSettingsPath(): string {
  const override = config.antigravity.settingsDir;
  const base = override || path.join(process.env.HOME ?? '', '.gemini', 'antigravity-cli');
  return path.join(base, 'settings.json');
}

// Authoritative model list — verified against agy's "Switch Model" menu (2026-05-28).
// The live fetch is disabled (non-deterministic LLM response); this list is the
// ground truth. Update here when agy adds or removes models.
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'antigravity/gemini-3-5-flash-medium':   'Gemini 3.5 Flash (Medium)',
  'antigravity/gemini-3-5-flash-high':     'Gemini 3.5 Flash (High)',
  'antigravity/gemini-3-5-flash-low':      'Gemini 3.5 Flash (Low)',
  'antigravity/gemini-3-1-pro-low':        'Gemini 3.1 Pro (Low)',
  'antigravity/gemini-3-1-pro-high':       'Gemini 3.1 Pro (High)',
  'antigravity/claude-sonnet-4-6-thinking':'Claude Sonnet 4.6 (Thinking)',
  'antigravity/claude-opus-4-6-thinking':  'Claude Opus 4.6 (Thinking)',
  'antigravity/gpt-oss-120b-medium':       'GPT-OSS 120B (Medium)',
};

// Converts an agy display name to a slug-style internal model ID.
export function slugifyAntigravityModel(displayName: string): string {
  return 'antigravity/' + displayName
    .toLowerCase()
    .replace(/[():,]/g, '')
    .trim()
    .replace(/[\s.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function toDisplayName(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

function writeModelToSettings(modelId: string): void {
  const displayName = MODEL_DISPLAY_NAMES[modelId];
  if (!displayName) {
    // Unknown model ID — skip write to avoid corrupting settings.json with a raw slug.
    logger.warn('antigravity: unknown model ID, skipping settings.json write', { modelId });
    return;
  }
  const p = resolveSettingsPath();
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* start fresh */ }
  settings.model = displayName;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

// ── Concurrency gate ─────────────────────────────────────────────────────────
// All agents share one model written once at startup (initAntigravityModel).
// The gate still throttles parallel agy processes to ANTIGRAVITY_CONCURRENCY_LIMIT
// but no longer needs to be 1 to prevent settings.json write races.

const _queue: Array<() => void> = [];
let _active = 0;
function acquire(): Promise<void> {
  const limit = config.antigravity.concurrencyLimit;
  // 0 = unlimited — skip the gate entirely, let agy quota be the natural limit.
  if (limit <= 0) return Promise.resolve();
  return new Promise(resolve => {
    if (_active < limit) { _active++; resolve(); return; }
    _queue.push(() => { _active++; resolve(); });
  });
}
function release(): void {
  _active--;
  const next = _queue.shift();
  if (next) next();
}
export function getAntigravityQueueLength(): number { return _queue.length; }

// ── One-time startup model init ───────────────────────────────────────────────
// Call once when the server boots. Writes the configured model to settings.json
// so every subsequent agy spawn picks it up without per-call writes or races.
export function initAntigravityModel(): void {
  const model = config.antigravity.model;
  if (!model) return;
  try {
    writeModelToSettings(model);
    logger.info('antigravity: model written to settings.json', { model });
  } catch (err) {
    logger.warn('antigravity: failed to write model to settings.json at startup', { err: (err as Error).message });
  }
}


// ── Types ─────────────────────────────────────────────────────────────────────

export interface AntigravityUsage {
  input_tokens?:  number;
  output_tokens?: number;
}

export interface AntigravityOptions {
  prompt:        string;
  systemPrompt?: string;
  model?:        string;
  agentId?:      string | null;
  sessionId?:    string | null;
  onUsage?:      (u: AntigravityUsage) => void;
  /** External abort (runaway/stop). SIGKILLs the agy --print child. [Item I4a] */
  signal?:       AbortSignal;
}

// ── Stream ────────────────────────────────────────────────────────────────────

const THINKING_MODELS = new Set([
  'antigravity/claude-sonnet-4-6-thinking',
  'antigravity/claude-opus-4-6-thinking',
]);

export async function* streamAntigravityChat(opts: AntigravityOptions): AsyncGenerator<string, void, void> {
  const resolvedModel = opts.model ?? config.antigravity.model;
  if (THINKING_MODELS.has(resolvedModel)) {
    throw new Error(
      `antigravity thinking model '${resolvedModel}' is not supported in --print mode — assign a non-thinking model to this agent`
    );
  }

  await acquire();

  // Always write the model to settings.json while holding the gate — agy has no
  // --model flag so settings.json is the only way to select a model. Writing
  // unconditionally prevents stale-config bugs when the env var changes at runtime
  // without a restart (hot-reload updates config but not settings.json).
  const globalModel    = config.antigravity.model;
  const requestedModel = opts.model ?? globalModel;
  writeModelToSettings(requestedModel);

  const sub = await buildAgentScopedEnv(opts.agentId ?? null, 'antigravity', process.env as Record<string, string>);
  const scrubber = createStreamScrubber(sub.resolved);
  try {
    const cmd = resolveCliBinary();
    if (!cmd) {
      yield '[antigravity (agy) binary not found — install it or set ANTIGRAVITY_CLI_COMMAND]';
      return;
    }

    const model = requestedModel;

    const fullPrompt = opts.systemPrompt
      ? `[SYSTEM]\n${opts.systemPrompt}\n[/SYSTEM]\n\n${opts.prompt}`
      : opts.prompt;

    const child: ChildProcess = spawn(cmd, ['--print', fullPrompt], {
      env:   sub.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(
      () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } },
      config.antigravity.timeoutMs,
    );
    // External abort (runaway/stop): SIGKILL the child. The exit check below already
    // has a `signalCode !== null` branch, so a killed child throws (closes as error)
    // rather than returning truncated output as success. [Item I4a]
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    let stderrAccum = '';
    const STDERR_MAX = 50_000;
    child.stderr!.on('data', (d: Buffer) => {
      stderrAccum += d.toString('utf8');
      if (stderrAccum.length > STDERR_MAX) stderrAccum = stderrAccum.slice(-STDERR_MAX);
    });

    let yieldedBytes = 0;
    try {
      for await (const chunk of child.stdout!) {
        const text = (chunk as Buffer).toString('utf8');
        yieldedBytes += text.length;
        const safe = scrubber.push(text);
        if (safe) yield safe;
      }
      const tail = scrubber.flush();
      if (tail) { yieldedBytes += tail.length; yield tail; }

      await new Promise<void>(resolve => child.on('close', () => resolve()));
      if ((child.exitCode !== 0 && child.exitCode !== null) || child.signalCode !== null) {
        const rawErr = stderrAccum.trim();
        const scrubbed = rawErr ? scrubOutput(rawErr, sub.resolved).scrubbed : '';
        const signal = child.signalCode ? ` (signal: ${child.signalCode})` : '';
        const summary = scrubbed || `(no stderr${signal})`;
        logger.error('agy exited non-zero', { exitCode: child.exitCode, signal: child.signalCode, error: scrubbed.slice(0, 1000) });
        if (/auth|login|credentials|expired|unauthenticated|unauthorized/i.test(summary)) throw new AntigravityAuthError(summary.slice(0, 400));
        if (/rate.?limit|429|quota/i.test(summary)) throw new AntigravityRateLimitError(summary.slice(0, 400));
        throw new Error(`agy exited ${child.exitCode}${signal}: ${summary.slice(0, 800)}`);
      }
      // agy exited 0 but wrote nothing to stdout — this is not a silent success;
      // it means the model produced no response (e.g. a thinking model that only
      // wrote its reasoning chain to stderr, or agy doesn't support --print for
      // this model). Surface as an explicit error so the SSE route can send a
      // proper `error` event instead of a silent empty stream.
      if (yieldedBytes === 0) {
        const stderrHint = stderrAccum.trim();
        const scrubbed   = stderrHint ? scrubOutput(stderrHint, sub.resolved).scrubbed : '';
        const hint       = scrubbed ? `: ${scrubbed.slice(0, 400)}` : ' (check that this model supports --print mode)';
        logger.warn('agy exited 0 with no stdout output', {
          model:  opts.model ?? config.antigravity.model,
          stderr: scrubbed.slice(0, 500),
        });
        throw new Error(`agy produced no response${hint}`);
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    if (requestedModel !== globalModel) writeModelToSettings(globalModel);
    release();
  }
}

// ── Probe ──────────────────────────────────────────────────────────────────────

export interface AntigravityProbeResult { ok: boolean; model: string | null; error: string | null }

export async function probeAntigravity(): Promise<AntigravityProbeResult> {
  const model = config.antigravity.model;
  return new Promise(resolve => {
    const cmd = resolveCliBinary();
    if (!cmd) return resolve({ ok: false, model, error: 'agy binary not found — install Antigravity CLI' });
    const child = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: Error) => resolve({ ok: false, model, error: err.message }));
    child.on('close', (code: number | null) => {
      if (code !== 0) return resolve({ ok: false, model, error: stderr.trim() || `exit ${code}` });
      resolve({ ok: true, model: stdout.trim() || model, error: null });
    });
  });
}

// ── Model list ────────────────────────────────────────────────────────────────

// Internal model IDs used in the NeuroClaw catalog and agent model picker.
// Maps to agy display names via MODEL_DISPLAY_NAMES above.
// Fallback list used only when `agy --print /models` is unavailable.
export const ANTIGRAVITY_MODELS = Object.keys(MODEL_DISPLAY_NAMES);

// ── Live queries via CLI slash commands ───────────────────────────────────────

// `agy --print /models` sends "/models" as a chat message to an LLM — the
// response is conversational and non-deterministic; we can never reliably parse
// real model IDs from it. Always return [] so refreshAntigravity() falls back to
// the compile-time MODEL_DISPLAY_NAMES list, which is the authoritative source.
export async function fetchAntigravityModels(): Promise<string[]> {
  return [];
}

export interface AntigravityUsageRow {
  provider:     string;
  callCount:    number;
  inputTokens:  number;
  outputTokens: number;
  totalTokens:  number;
  estCost:      string;
}

export async function fetchAntigravityUsage(timeoutMs = 8_000): Promise<AntigravityUsageRow[]> {
  return new Promise(resolve => {
    const cmd = resolveCliBinary();
    if (!cmd) return resolve([]);
    const child = spawn(cmd, ['--print', '/usage'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve([]);
    }, timeoutMs);

    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', () => {
      clearTimeout(timer);
      const rows: AntigravityUsageRow[] = [];
      for (const line of out.split('\n')) {
        // Match markdown table rows with 6 cells
        const cells = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length !== 6) continue;
        const [provider, callCount, inputTokens, outputTokens, totalTokens, estCost] = cells;
        if (!provider || /^-+$/.test(provider) || provider.toLowerCase() === 'provider') continue;
        const parseNum = (s: string) => parseInt(s.replace(/[^0-9]/g, ''), 10) || 0;
        rows.push({
          provider:     provider.replace(/\*\*/g, '').trim(),
          callCount:    parseNum(callCount),
          inputTokens:  parseNum(inputTokens),
          outputTokens: parseNum(outputTokens),
          totalTokens:  parseNum(totalTokens),
          estCost:      estCost.trim(),
        });
      }
      resolve(rows);
    });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
  });
}

export function logAntigravityCliInfo(): void {
  logger.info('Antigravity backend: agy CLI', {
    cliCommand:       config.antigravity.cliCommand,
    model:            config.antigravity.model,
    timeoutMs:        config.antigravity.timeoutMs,
    concurrencyLimit: config.antigravity.concurrencyLimit,
  });
}
