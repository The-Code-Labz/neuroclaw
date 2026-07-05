// Run a script that lives inside .claude/skills/<name>/scripts/. Executor
// for the run_skill_script tool. Mirrors the timeout / output-cap / sensitive-
// env-scrubbing behaviour from src/system/exec-tools.ts but is scoped tighter:
//   - No shell. Args are passed directly to the child process (no string interp).
//   - The script path is validated by skill-loader.ts before we get here, so
//     path-traversal attempts have already been rejected at this layer.
//   - Interpreter is chosen by file extension; falls back to direct exec when
//     a script has a shebang and is marked executable.

import { spawn } from 'child_process';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logAudit } from '../db';
import { buildSubprocessEnv } from '../broker/subprocessSecrets';
import { scrubOutput } from '../broker/scrubber';
import { resolveWorkspace, workspaceEnv } from './workspace';
import { checkFsBoundary } from './exec-tools';

const SCRUB_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'VOIDAI_API_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'DASHBOARD_TOKEN',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'COMPOSIO_API_KEY',
  'DISCORD_BOT_TOKEN',
  // Broker / supervisor tokens — skill scripts must not be able to impersonate agents
  'NC_AGENT_TOKEN',
  'NC_BROKER_HMAC_KEY',
  'VENICE_API_KEY',
  'GEMINI_API_KEY',
  'KOKORO_API_KEY',
  'BROWSERLESS_TOKEN',
];

function buildChildEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const k of SCRUB_ENV_KEYS) delete out[k];
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

interface InterpreterChoice {
  command: string;
  args:    string[];
}

function chooseInterpreter(scriptPath: string): InterpreterChoice {
  const ext = path.extname(scriptPath).toLowerCase();
  switch (ext) {
    case '.py':  return { command: 'python3', args: [scriptPath] };
    case '.js':
    case '.mjs':
    case '.cjs': return { command: 'node',    args: [scriptPath] };
    case '.ts':  return { command: 'npx',     args: ['tsx', scriptPath] };
    case '.sh':
    case '.bash':return { command: 'bash',    args: [scriptPath] };
    default:
      // Fall through to direct exec — works when the script is marked +x
      // and has a shebang (#!/usr/bin/env python3, etc.).
      return { command: scriptPath, args: [] };
  }
}

function capBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false };
  const sliced = Buffer.from(s, 'utf8').slice(0, max).toString('utf8');
  return { text: sliced + `\n…[truncated, ${max} bytes]`, truncated: true };
}

export interface RunSkillScriptOpts {
  skillName:   string;
  scriptPath:  string;          // absolute path, already validated by skill-loader
  args?:       string[];
  stdin?:      string;
  cwd?:        string;
  timeout_ms?: number;
  agentId?:    string | null;
  /** Session the call belongs to — keys the scoped workspace (default cwd). */
  sessionId?:  string | null;
  /** Broker secret names to inject as env vars for this script, scoped to the agent. */
  secrets?:    string[];
  /** Reason the secrets are needed — recorded in the broker audit log. */
  purpose?:    string;
}

export interface RunSkillScriptResult {
  ok:          boolean;
  exit_code:   number | null;
  signal:      string | null;
  stdout:      string;
  stderr:      string;
  duration_ms: number;
  truncated:   boolean;
  interpreter: string;
  /** Requested broker secrets the agent is not scoped to. Present only when non-empty. */
  secrets_denied?:  string[];
  /** Requested broker secrets absent from the broker. Present only when non-empty. */
  secrets_missing?: string[];
}

const STDIN_MAX_BYTES = 1024 * 1024;   // 1 MB cap on piped stdin

export async function runSkillScript(opts: RunSkillScriptOpts): Promise<RunSkillScriptResult> {
  const start = Date.now();
  const { command, args: interpArgs } = chooseInterpreter(opts.scriptPath);
  const args = [...interpArgs, ...(opts.args ?? [])];
  // Default cwd: the agent's scoped workspace (so script outputs land there,
  // not in the repo or the skill's own dir). Reverts to the script dir when
  // workspace scoping is off. An explicit opts.cwd always wins — but an
  // agent-supplied cwd is attacker-controlled, so it must clear the same
  // EXEC_ROOT boundary that bash_run / the fs_* tools enforce (the trusted
  // workspace / script-dir defaults are exempt). Without this, a skill script
  // could run with its working dir set to any host path (e.g. /root, /etc).
  const explicitCwd = opts.cwd && opts.cwd.trim() ? opts.cwd : null;
  if (explicitCwd) {
    try {
      checkFsBoundary(explicitCwd);
    } catch (err) {
      return {
        ok: false, exit_code: null, signal: null,
        stdout: '', stderr: (err as Error).message,
        duration_ms: 0, truncated: false, interpreter: command,
      };
    }
  }
  const cwd = explicitCwd
    ? explicitCwd
    : config.workspace.enabled
      ? resolveWorkspace(opts.sessionId ?? null, opts.agentId ?? null)
      : path.dirname(opts.scriptPath);
  const timeoutMs = Math.min(opts.timeout_ms ?? config.exec.timeoutMs, config.exec.timeoutMs * 2);
  const limit = config.exec.outputMaxBytes;

  if (opts.stdin && Buffer.byteLength(opts.stdin, 'utf-8') > STDIN_MAX_BYTES) {
    return {
      ok: false, exit_code: null, signal: null,
      stdout: '', stderr: `stdin exceeds ${STDIN_MAX_BYTES} bytes`,
      duration_ms: 0, truncated: false, interpreter: command,
    };
  }

  // Resolve any declared broker secrets, scoped to the calling agent, and
  // merge them onto the scrubbed base env. `sub.resolved` is the name→value
  // map used to scrub those values back out of the script's output.
  const sub = await buildSubprocessEnv(
    opts.agentId ?? null,
    opts.secrets,
    opts.purpose?.trim() || `skill:${opts.skillName}`,
    buildChildEnv({ NEUROCLAW_SKILL: opts.skillName, ...workspaceEnv(cwd) }),
  );
  const secretsMeta: Pick<RunSkillScriptResult, 'secrets_denied' | 'secrets_missing'> = {};
  if (sub.denied.length)  secretsMeta.secrets_denied  = sub.denied;
  if (sub.missing.length) secretsMeta.secrets_missing = sub.missing;

  return new Promise<RunSkillScriptResult>(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: sub.env,
      // No shell — args go straight through. Prevents argument-injection
      // even if a downstream caller eventually passes user-controlled args.
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    // Guard against duplicate logAudit + resolve calls when both 'error' and
    // 'close' fire on the same spawn failure (Node emits both on ENOENT etc.).
    let settled = false;

    const append = (which: 'out' | 'err', data: string): void => {
      if (which === 'out') stdout += data; else stderr += data;
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > limit) {
        truncated = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    };
    child.stdout.on('data', d => append('out', d.toString('utf8')));
    child.stderr.on('data', d => append('err', d.toString('utf8')));
    child.stdout.on('error', (e: Error) => append('err', `stdout_err: ${e.message}\n`));
    child.stderr.on('error', (e: Error) => append('err', `stderr_err: ${e.message}\n`));
    child.stdin.on('error', () => { /* absorb EPIPE if process exits before consuming stdin */ });

    if (opts.stdin) {
      try { child.stdin.write(opts.stdin); } catch { /* pipe may be closed */ }
    }
    try { child.stdin.end(); } catch { /* fine */ }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      logAudit('skill_script_run', 'skill', undefined, {
        skill: opts.skillName, script: path.basename(opts.scriptPath),
        agentId: opts.agentId, error: err.message, duration_ms,
      });
      resolve({
        ok: false, exit_code: null, signal: null,
        stdout: scrubOutput(stdout, sub.resolved).scrubbed,
        stderr: scrubOutput(stderr + '\n' + err.message, sub.resolved).scrubbed,
        duration_ms, truncated, interpreter: command,
        ...secretsMeta,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      const cappedOut = capBytes(scrubOutput(stdout, sub.resolved).scrubbed, Math.floor(limit / 2));
      const cappedErr = capBytes(scrubOutput(stderr, sub.resolved).scrubbed, Math.floor(limit / 2));
      logAudit('skill_script_run', 'skill', undefined, {
        skill: opts.skillName, script: path.basename(opts.scriptPath),
        interpreter: command, exit_code: code, signal, duration_ms,
        truncated: truncated || cappedOut.truncated || cappedErr.truncated, agentId: opts.agentId,
      });
      logger.info('skill-runner: ran', {
        skill: opts.skillName, script: path.basename(opts.scriptPath),
        exit_code: code, duration_ms,
      });
      resolve({
        ok:          code === 0,
        exit_code:   code,
        signal:      signal ?? null,
        stdout:      cappedOut.text,
        stderr:      cappedErr.text,
        duration_ms,
        truncated:   truncated || cappedOut.truncated || cappedErr.truncated,
        interpreter: command,
        ...secretsMeta,
      });
    });
  });
}
