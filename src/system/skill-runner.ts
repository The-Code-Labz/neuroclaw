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
}

const STDIN_MAX_BYTES = 1024 * 1024;   // 1 MB cap on piped stdin

export async function runSkillScript(opts: RunSkillScriptOpts): Promise<RunSkillScriptResult> {
  const start = Date.now();
  const { command, args: interpArgs } = chooseInterpreter(opts.scriptPath);
  const args = [...interpArgs, ...(opts.args ?? [])];
  const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : path.dirname(opts.scriptPath);
  const timeoutMs = Math.min(opts.timeout_ms ?? config.exec.timeoutMs, config.exec.timeoutMs * 2);
  const limit = config.exec.outputMaxBytes;

  if (opts.stdin && Buffer.byteLength(opts.stdin, 'utf-8') > STDIN_MAX_BYTES) {
    return {
      ok: false, exit_code: null, signal: null,
      stdout: '', stderr: `stdin exceeds ${STDIN_MAX_BYTES} bytes`,
      duration_ms: 0, truncated: false, interpreter: command,
    };
  }

  return new Promise<RunSkillScriptResult>(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: buildChildEnv({ NEUROCLAW_SKILL: opts.skillName }),
      // No shell — args go straight through. Prevents argument-injection
      // even if a downstream caller eventually passes user-controlled args.
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    const append = (which: 'out' | 'err', data: string): void => {
      if (which === 'out') stdout += data; else stderr += data;
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > limit) {
        truncated = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    };
    child.stdout.on('data', d => append('out', d.toString('utf8')));
    child.stderr.on('data', d => append('err', d.toString('utf8')));

    if (opts.stdin) {
      try { child.stdin.write(opts.stdin); } catch { /* pipe may be closed */ }
    }
    try { child.stdin.end(); } catch { /* fine */ }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      logAudit('skill_script_run', 'skill', undefined, {
        skill: opts.skillName, script: path.basename(opts.scriptPath),
        agentId: opts.agentId, error: err.message, duration_ms,
      });
      resolve({
        ok: false, exit_code: null, signal: null,
        stdout, stderr: stderr + '\n' + err.message,
        duration_ms, truncated, interpreter: command,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      const cappedOut = capBytes(stdout, Math.floor(limit / 2));
      const cappedErr = capBytes(stderr, Math.floor(limit / 2));
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
      });
    });
  });
}
