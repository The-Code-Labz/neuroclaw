import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logAudit } from '../db';

// Exec tools — gated per-agent via agents.exec_enabled. Default-allow shell
// with a hard-deny denylist for catastrophic commands. All calls are audited.

// ── Sensitive env keys that must never leak to a child process ───────────────

const SCRUB_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'VOIDAI_API_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'DASHBOARD_TOKEN',
  'OPENAI_API_KEY',
];

function buildChildEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const k of SCRUB_ENV_KEYS) delete out[k];
  return out;
}

// ── Filesystem boundary ──────────────────────────────────────────────────────

function checkFsBoundary(targetPath: string): void {
  const root = config.exec.root;
  if (!root) return;  // empty = no boundary
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const resolvedTarget = (() => {
    try { return fs.realpathSync(path.resolve(targetPath)); }
    catch { return path.resolve(targetPath); }
  })();
  if (!resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error(`exec: path '${targetPath}' is outside EXEC_ROOT (${root})`);
  }
}

// ── Hard-deny check for shell commands ───────────────────────────────────────

function isDeniedCommand(command: string): string | null {
  const lower = command.toLowerCase();
  for (const pat of config.exec.bashDeny) {
    if (lower.includes(pat.toLowerCase())) return pat;
  }
  return null;
}

// ── Output capping ───────────────────────────────────────────────────────────

function capBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false };
  const sliced = Buffer.from(s, 'utf8').slice(0, max).toString('utf8');
  return { text: sliced + `\n…[truncated, ${max} bytes]`, truncated: true };
}

// ── Tool: bash_run ───────────────────────────────────────────────────────────

export interface BashRunOpts {
  command:     string;
  cwd?:        string;
  timeout_ms?: number;
  agentId?:    string;
}

export interface BashRunResult {
  ok:          boolean;
  exit_code:   number | null;
  signal:      string | null;
  stdout:      string;
  stderr:      string;
  duration_ms: number;
  truncated:   boolean;
  command:     string;
  cwd:         string;
}

export async function bashRun(opts: BashRunOpts): Promise<BashRunResult> {
  const command = opts.command;
  const cwd = path.resolve(opts.cwd?.trim() || config.exec.defaultCwd);
  const timeoutMs = Math.min(opts.timeout_ms ?? config.exec.timeoutMs, config.exec.timeoutMs * 2);
  const start = Date.now();

  const denied = isDeniedCommand(command);
  if (denied) {
    logger.warn('exec.bash_run: denied', { agentId: opts.agentId, pattern: denied });
    logAudit('exec_denied', 'exec', undefined, { tool: 'bash_run', pattern: denied, command: command.slice(0, 200), agentId: opts.agentId });
    return {
      ok: false, exit_code: null, signal: null,
      stdout: '', stderr: `Refused: command matched hard-deny pattern '${denied}'.`,
      duration_ms: 0, truncated: false, command, cwd,
    };
  }
  checkFsBoundary(cwd);

  return new Promise<BashRunResult>(resolve => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: buildChildEnv(),
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    const limit = config.exec.outputMaxBytes;

    const append = (which: 'out' | 'err', data: string): void => {
      if (which === 'out') stdout += data; else stderr += data;
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > limit) {
        truncated = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    };
    child.stdout.on('data', d => append('out', d.toString('utf8')));
    child.stderr.on('data', d => append('err', d.toString('utf8')));

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      logAudit('exec_run', 'exec', undefined, { tool: 'bash_run', command: command.slice(0, 200), error: err.message, duration_ms, agentId: opts.agentId });
      resolve({
        ok: false, exit_code: null, signal: null,
        stdout, stderr: stderr + '\n' + err.message,
        duration_ms, truncated, command, cwd,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      const cappedOut = capBytes(stdout, Math.floor(limit / 2));
      const cappedErr = capBytes(stderr, Math.floor(limit / 2));
      const result: BashRunResult = {
        ok:          code === 0,
        exit_code:   code,
        signal:      signal ?? null,
        stdout:      cappedOut.text,
        stderr:      cappedErr.text,
        duration_ms,
        truncated:   truncated || cappedOut.truncated || cappedErr.truncated,
        command,
        cwd,
      };
      logAudit('exec_run', 'exec', undefined, {
        tool: 'bash_run', command: command.slice(0, 200), cwd, exit_code: code, signal,
        duration_ms, truncated: result.truncated, agentId: opts.agentId,
      });
      resolve(result);
    });
  });
}

// ── Tool: fs_read ────────────────────────────────────────────────────────────

export interface FsReadResult {
  ok:        boolean;
  path:      string;
  content?:  string;
  bytes?:    number;
  truncated?: boolean;
  error?:    string;
}

export async function fsRead(opts: { path: string; agentId?: string }): Promise<FsReadResult> {
  const target = path.resolve(opts.path);
  try {
    checkFsBoundary(target);
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) return { ok: false, path: target, error: 'is a directory; use fs_list' };
    const buf = await fsp.readFile(target);
    const capped = capBytes(buf.toString('utf8'), config.exec.outputMaxBytes);
    logAudit('exec_run', 'exec', undefined, { tool: 'fs_read', path: target, bytes: stat.size, agentId: opts.agentId });
    return { ok: true, path: target, content: capped.text, bytes: stat.size, truncated: capped.truncated };
  } catch (err) {
    return { ok: false, path: target, error: (err as Error).message };
  }
}

// ── Tool: fs_write ───────────────────────────────────────────────────────────

export interface FsWriteOpts {
  path:    string;
  content: string;
  mode?:   'create' | 'overwrite' | 'append';
  agentId?: string;
}

export interface FsWriteResult {
  ok:    boolean;
  path:  string;
  bytes?: number;
  error?: string;
}

export async function fsWrite(opts: FsWriteOpts): Promise<FsWriteResult> {
  const target = path.resolve(opts.path);
  const mode = opts.mode ?? 'overwrite';
  try {
    checkFsBoundary(target);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (mode === 'create' && fs.existsSync(target)) {
      return { ok: false, path: target, error: 'file exists; use mode=overwrite or append' };
    }
    if (mode === 'append') {
      await fsp.appendFile(target, opts.content);
    } else {
      await fsp.writeFile(target, opts.content);
    }
    const stat = await fsp.stat(target);
    logAudit('exec_run', 'exec', undefined, { tool: 'fs_write', path: target, mode, bytes: stat.size, agentId: opts.agentId });
    return { ok: true, path: target, bytes: stat.size };
  } catch (err) {
    return { ok: false, path: target, error: (err as Error).message };
  }
}

// ── Tool: fs_list ────────────────────────────────────────────────────────────

export interface FsListEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

export async function fsList(opts: { path: string; agentId?: string }): Promise<{ ok: boolean; path: string; entries?: FsListEntry[]; error?: string }> {
  const target = path.resolve(opts.path);
  try {
    checkFsBoundary(target);
    const items = await fsp.readdir(target, { withFileTypes: true });
    const entries: FsListEntry[] = [];
    for (const it of items) {
      const full = path.join(target, it.name);
      let size: number | undefined;
      try { size = (await fsp.stat(full)).size; } catch { /* ignore */ }
      entries.push({
        name: it.name,
        type: it.isFile() ? 'file' : it.isDirectory() ? 'dir' : it.isSymbolicLink() ? 'symlink' : 'other',
        size,
      });
    }
    logAudit('exec_run', 'exec', undefined, { tool: 'fs_list', path: target, count: entries.length, agentId: opts.agentId });
    return { ok: true, path: target, entries };
  } catch (err) {
    return { ok: false, path: target, error: (err as Error).message };
  }
}

// ── Tool: fs_search (ripgrep-backed, falls back to grep) ─────────────────────

export interface FsSearchOpts {
  pattern:      string;
  path?:        string;
  max_results?: number;
  agentId?:     string;
}

export async function fsSearch(opts: FsSearchOpts): Promise<{ ok: boolean; matches: { file: string; line: number; text: string }[]; error?: string }> {
  const search = path.resolve(opts.path ?? config.exec.defaultCwd);
  checkFsBoundary(search);
  const max = opts.max_results ?? 200;
  // Prefer rg, fall back to grep -rn
  return new Promise(resolve => {
    let stdout = '';
    let usedTool = 'rg';
    let resolved = false;
    let fellBack = false;

    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      const matches = stdout.split('\n').filter(Boolean).slice(0, max).map(line => {
        const m = line.match(/^([^:]+):(\d+):(.*)$/);
        if (!m) return { file: '', line: 0, text: line };
        return { file: m[1], line: parseInt(m[2], 10), text: m[3] };
      });
      logAudit('exec_run', 'exec', undefined, { tool: 'fs_search', pattern: opts.pattern, path: search, count: matches.length, used: usedTool, agentId: opts.agentId });
      resolve({ ok: true, matches });
    };

    const runGrep = (): void => {
      fellBack = true;
      usedTool = 'grep';
      stdout = '';
      const grep = spawn('grep', ['-rn', opts.pattern, search], { env: buildChildEnv() });
      grep.stdout.on('data', d => { stdout += d.toString('utf8'); });
      grep.on('close', () => finish());
      grep.on('error', err => {
        if (!resolved) { resolved = true; resolve({ ok: false, matches: [], error: err.message }); }
      });
    };

    const rg = spawn('rg', ['--line-number', '--no-heading', '--max-count', '50', '--', opts.pattern, search], {
      env: buildChildEnv(),
    });
    rg.stdout.on('data', d => { stdout += d.toString('utf8'); });
    rg.on('error', () => { if (!fellBack) runGrep(); });
    rg.on('close', () => { if (!fellBack) finish(); });
  });
}
