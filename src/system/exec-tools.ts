import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logAudit } from '../db';
import { buildSubprocessEnv } from '../broker/subprocessSecrets';
import { scrubOutput } from '../broker/scrubber';
import { spawnCollect } from './spawn-collect';
import { resolveWorkspace, workspaceRoot, workspaceEnv } from './workspace';

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

function buildChildEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const k of SCRUB_ENV_KEYS) delete out[k];
  // Never leak the supervisor token into child shells.
  delete out.NC_AGENT_TOKEN;
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

// ── Workspace-scoped default paths ───────────────────────────────────────────

/** Default working directory for exec tools: the agent's scoped workspace when
 *  workspace scoping is enabled, else the legacy `EXEC_DEFAULT_CWD`. */
function defaultExecCwd(agentId?: string | null, sessionId?: string | null): string {
  if (config.workspace.enabled) return resolveWorkspace(sessionId ?? null, agentId ?? null);
  return config.exec.defaultCwd;
}

/** Resolve a tool-supplied path. Absolute paths pass through (still gated by
 *  checkFsBoundary); relative paths resolve against the agent's workspace so
 *  default writes land there instead of the repo root. */
function resolveAgentPath(p: string, agentId?: string | null, sessionId?: string | null): string {
  if (path.isAbsolute(p)) return path.resolve(p);
  if (config.workspace.enabled) return path.resolve(resolveWorkspace(sessionId ?? null, agentId ?? null), p);
  return path.resolve(p);
}

// ── Filesystem boundary ──────────────────────────────────────────────────────

function realresolve(p: string): string {
  try { return fs.realpathSync(path.resolve(p)); }
  catch { return path.resolve(p); }
}

export function checkFsBoundary(targetPath: string): void {
  const roots = config.exec.roots;
  if (!roots.length) return;  // empty = no boundary
  // The workspace root and os.tmpdir() are always permitted so workspace writes
  // and scratch never trip the boundary, regardless of EXEC_ROOT.
  const allow = [...roots, workspaceRoot(), os.tmpdir()].map(realresolve);
  const resolvedTarget = realresolve(targetPath);
  for (const r of allow) {
    if (resolvedTarget === r || resolvedTarget.startsWith(r + path.sep)) return;
  }
  throw new Error(`exec: path '${targetPath}' is outside EXEC_ROOT (${roots.join(', ')})`);
}

// ── Hard-deny check for shell commands ───────────────────────────────────────

function isDeniedCommand(command: string): string | null {
  const lower = command.toLowerCase();
  for (const pat of config.exec.bashDeny) {
    const lowerPat = pat.toLowerCase();
    // Patterns ending in '/' need a word-boundary check — otherwise 'rm -rf /'
    // incorrectly matches 'rm -rf /tmp/workdir' via substring inclusion.
    if (lowerPat.endsWith('/')) {
      const escaped = lowerPat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(escaped + '(\\s|$)').test(lower)) return pat;
    } else if (lower.includes(lowerPat)) {
      return pat;
    }
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
  /** Session the call belongs to — keys the scoped workspace (default cwd). */
  sessionId?:  string;
  /** Broker secret names to inject as env vars for this command, scoped to the agent. */
  secrets?:    string[];
  /**
   * Reason the secrets are needed — recorded in the broker audit log.
   * A blank or whitespace-only value is normalised to `'bash_run'`.
   */
  purpose?:    string;
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
  /** Requested broker secrets the agent is not scoped to. Present only when non-empty. */
  secrets_denied?:  string[];
  /** Requested broker secrets absent from the broker. Present only when non-empty. */
  secrets_missing?: string[];
}

export async function bashRun(opts: BashRunOpts): Promise<BashRunResult> {
  const command = opts.command;
  const cwd = path.resolve(opts.cwd?.trim() || defaultExecCwd(opts.agentId, opts.sessionId));
  const timeoutMs = Math.min(opts.timeout_ms ?? config.exec.timeoutMs, config.exec.timeoutMs * 2);

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

  // Resolve any declared broker secrets, scoped to the calling agent, and
  // merge them onto the scrubbed base env. `sub.resolved` is the name→value
  // map used to scrub those values back out of the child's output.
  const sub = await buildSubprocessEnv(
    opts.agentId ?? null,
    opts.secrets,
    opts.purpose?.trim() || 'bash_run',
    buildChildEnv(workspaceEnv(cwd)),
  );
  const secretsMeta: Pick<BashRunResult, 'secrets_denied' | 'secrets_missing'> = {};
  if (sub.denied.length)  secretsMeta.secrets_denied  = sub.denied;
  if (sub.missing.length) secretsMeta.secrets_missing = sub.missing;

  const limit = config.exec.outputMaxBytes;
  // Process-group-safe runner: spawns detached, resolves on 'exit' (not 'close'),
  // and kills the whole group on timeout/cleanup — so a backgrounded grandchild
  // holding the stdout pipe can no longer hang the call forever.
  const res = await spawnCollect({
    command,
    cwd,
    env:            sub.env,
    timeoutMs,
    outputCapBytes: limit,
    shellArgs:      ['-lc'],
  });
  const duration_ms = res.durationMs;

  if (res.spawnError) {
    logAudit('exec_run', 'exec', undefined, { tool: 'bash_run', command: command.slice(0, 200), error: res.spawnError, duration_ms, agentId: opts.agentId });
    return {
      ok: false, exit_code: null, signal: null,
      stdout: scrubOutput(res.stdout, sub.resolved).scrubbed,
      stderr: scrubOutput(res.stderr + '\n' + res.spawnError, sub.resolved).scrubbed,
      duration_ms, truncated: res.truncated, command, cwd,
      ...secretsMeta,
    };
  }

  // Scrub secret values BEFORE capping so a value split by truncation cannot
  // survive the redaction pass.
  const cappedOut = capBytes(scrubOutput(res.stdout, sub.resolved).scrubbed, Math.floor(limit / 2));
  const timedNote = res.timedOut
    ? `\n[exec: command exceeded ${timeoutMs}ms and its process group was killed. If it started a background process, that holds the shell open — run long services under a supervisor, not via '&' in bash_run.]`
    : '';
  const cappedErr = capBytes(scrubOutput(res.stderr, sub.resolved).scrubbed + timedNote, Math.floor(limit / 2));

  const result: BashRunResult = {
    ok:          res.code === 0 && !res.timedOut,
    exit_code:   res.code,
    signal:      res.signal,
    stdout:      cappedOut.text,
    stderr:      cappedErr.text,
    duration_ms,
    truncated:   res.truncated || cappedOut.truncated || cappedErr.truncated,
    command,
    cwd,
    ...secretsMeta,
  };
  logAudit('exec_run', 'exec', undefined, {
    tool: 'bash_run', command: command.slice(0, 200), cwd, exit_code: res.code, signal: res.signal,
    duration_ms, truncated: result.truncated, timed_out: res.timedOut, agentId: opts.agentId,
  });
  return result;
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

export async function fsRead(opts: { path: string; agentId?: string; sessionId?: string }): Promise<FsReadResult> {
  const target = resolveAgentPath(opts.path, opts.agentId, opts.sessionId);
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
  sessionId?: string;
}

export interface FsWriteResult {
  ok:    boolean;
  path:  string;
  bytes?: number;
  error?: string;
}

export async function fsWrite(opts: FsWriteOpts): Promise<FsWriteResult> {
  const target = resolveAgentPath(opts.path, opts.agentId, opts.sessionId);
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

export async function fsList(opts: { path: string; agentId?: string; sessionId?: string }): Promise<{ ok: boolean; path: string; entries?: FsListEntry[]; error?: string }> {
  const target = resolveAgentPath(opts.path, opts.agentId, opts.sessionId);
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
  sessionId?:   string;
}

export async function fsSearch(opts: FsSearchOpts): Promise<{ ok: boolean; matches: { file: string; line: number; text: string }[]; error?: string }> {
  const search = opts.path
    ? resolveAgentPath(opts.path, opts.agentId, opts.sessionId)
    : path.resolve(defaultExecCwd(opts.agentId, opts.sessionId));
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

// ── Tool: fs_edit (single-occurrence find/replace, mirrors nclaw-cli's editFile) ─

export interface FsEditOpts {
  path:       string;
  oldString:  string;
  newString:  string;
  agentId?:   string;
  sessionId?: string;
}

export interface FsEditResult {
  ok:    boolean;
  path:  string;
  diff?: { path: string; before: string; after: string; mode: 'overwrite' };
  error?: string;
}

export async function fsEdit(opts: FsEditOpts): Promise<FsEditResult> {
  const target = resolveAgentPath(opts.path, opts.agentId, opts.sessionId);
  try {
    checkFsBoundary(target);
    const before = await fsp.readFile(target, 'utf8');
    const occurrences = before.split(opts.oldString).length - 1;
    if (occurrences === 0) return { ok: false, path: target, error: 'oldString not found in file' };
    if (occurrences > 1) return { ok: false, path: target, error: `oldString is ambiguous; found ${occurrences} matches` };
    const after = before.replace(opts.oldString, opts.newString);
    await fsp.writeFile(target, after, 'utf8');
    logAudit('exec_run', 'exec', undefined, { tool: 'fs_edit', path: target, agentId: opts.agentId });
    return { ok: true, path: target, diff: { path: target, before, after, mode: 'overwrite' } };
  } catch (err) {
    return { ok: false, path: target, error: (err as Error).message };
  }
}

// ── Tool: glob (dependency-free glob → RegExp matcher over a recursive walk) ─

export interface GlobOpts {
  pattern:    string;
  path?:      string;
  agentId?:   string;
  sessionId?: string;
}

export interface GlobResult {
  ok:        boolean;
  files:     string[];
  truncated?: boolean;
  error?:    string;
}

const GLOB_WALK_IGNORE = new Set(['node_modules', '.git', 'dist', 'build']);
const GLOB_WALK_CAP    = 5000;
const GLOB_RESULT_CAP  = 200;

/** Convert a small subset of glob syntax (`**`, `*`, `?`) to a RegExp anchored
 *  against a `/`-joined relative path. Intentionally dependency-free — avoids
 *  pulling in fast-glob/minimatch just for this one tool. */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

async function walkFiles(dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let entries: import('fs').Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (GLOB_WALK_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, out, limit);
    else if (e.isFile()) out.push(full);
  }
}

export async function globFiles(opts: GlobOpts): Promise<GlobResult> {
  const base = opts.path
    ? resolveAgentPath(opts.path, opts.agentId, opts.sessionId)
    : path.resolve(defaultExecCwd(opts.agentId, opts.sessionId));
  try {
    checkFsBoundary(base);
    const all: string[] = [];
    await walkFiles(base, all, GLOB_WALK_CAP);
    const matcher = globToRegExp(opts.pattern);
    const matched = all
      .map(f => path.relative(base, f))
      .filter(rel => matcher.test(rel))
      .sort();
    logAudit('exec_run', 'exec', undefined, { tool: 'glob', pattern: opts.pattern, path: base, count: matched.length, agentId: opts.agentId });
    return {
      ok: true,
      files: matched.slice(0, GLOB_RESULT_CAP),
      ...(matched.length > GLOB_RESULT_CAP ? { truncated: true } : {}),
    };
  } catch (err) {
    return { ok: false, files: [], error: (err as Error).message };
  }
}
