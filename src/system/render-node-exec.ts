// system/render-node-exec.ts — P2: secrets-aware remote exec on the render node.
//
// PURPOSE
//   OpenMontage's Python tools run ON the render node (over SSH) and need
//   provider API keys (VoidAI / Kokoro / Abacus) to authenticate. The vetted
//   ssh-connect transport (sshRunCommand/sshUpload/sshDownload) already resolves
//   the *machine* SSH credential server-side through the broker — but it has NO
//   way to hand *provider* secrets to the remote process. `bash_run` injects
//   SHARED_* broker secrets into a LOCAL child env; this is the remote analogue.
//
// SECURITY MODEL (why an env-file, not env-in-command)
//   • Provider secrets are resolved via broker.withSecrets — scope-checked +
//     audited, same as bash_run. These are NON-restricted secrets (unlike the
//     SSH key), so no restricted-secret capability is presented.
//   • Secret VALUES must never appear in the audited SSH command string (which
//     ssh-connect scrubs+logs, capped at 500 bytes) nor in `ps` on the node.
//     So we write them to a mode-600 env file, SFTP it into a throwaway remote
//     dir, `source` it, run the command, then `shred` the file. The audited
//     command contains only the file PATH; the SFTP audit logs only the path.
//   • The env file lives in ~/.nc-exec/<uuid>/ (0700), is chmod 600, is shredded
//     immediately after the command exits, and the dir is rm-rf'd. Values touch
//     remote disk only for the lifetime of one command, on our own trusted node.
//   • Local temp env file is deleted right after upload; values live in JS only
//     inside the withSecrets callback.
//
// This is the P2 "true first domino" from the OpenMontage Phase 1 spec: until a
// remote process can authenticate to our providers, no pipeline tool can run.

import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { agentStore, broker } from '../broker';
import { sshRunCommand, sshUpload } from './ssh-connect';
import { runDetachedOnRenderNode, type DetachedRunResult } from './render-node-detached';
import { logger } from '../utils/logger';
import { Semaphore, envConcurrency } from '../utils/semaphore';

const MACHINE = () => (process.env['RENDER_NODE_MACHINE'] || 'render-node').trim();
const EXEC_ROOT = '.nc-exec'; // under $HOME on the node
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// Synchronous (channel-held) path only. Anything that must run LONGER than the
// render node's ~10m sshd exec ceiling MUST use the detached path (opts.detached)
// instead of raising this — the ceiling lives in the remote sshd, not here.
const MAX_TIMEOUT_MS = 9 * 60_000; // SSH exec ceiling is 10m; stay under it for sync calls

/** Default concurrency caps per render-node operation group. */
const DEFAULT_GROUP_LIMITS: Record<string, number> = {
  openmontage: 2, // pipeline stage runs; ffmpeg/Remotion are CPU/IO heavy
  voidai: 3,      // image-gen provider: avoid 429 user_concurrent_limit
  kokoro: 4,      // TTS provider: cheap, but cap to be safe
  default: 4,
};

const semaphoreMap = new Map<string, Semaphore>();

function getSemaphore(group: string): Semaphore {
  const existing = semaphoreMap.get(group);
  if (existing) return existing;
  const envName = `NC_EXEC_CONCURRENCY_${group.toUpperCase()}`;
  const limit = envConcurrency(envName, DEFAULT_GROUP_LIMITS[group] ?? DEFAULT_GROUP_LIMITS.default);
  const sem = new Semaphore(limit);
  semaphoreMap.set(group, sem);
  return sem;
}

export interface RemoteExecOpts {
  /** Shell command to run on the render node. */
  command: string;
  /** SHARED_* broker secret names to inject as env vars for this command. */
  secretNames?: string[];
  /** Remote working directory (cd'd into before the command). Optional. */
  cwd?: string;
  timeoutMs?: number;
  /**
   * Run DETACHED (launch-and-poll) instead of holding the SSH channel for the
   * whole command. REQUIRED for anything that legitimately runs longer than the
   * render node's ~10m sshd exec ceiling — otherwise the channel is SIGKILLed
   * mid-run. When set, timeoutMs is ignored in favour of maxWaitMs.
   */
  detached?: boolean;
  /** Detached only: overall wall-clock budget (ms). Default RENDER_NODE_MAX_WAIT_MS / 45m. */
  maxWaitMs?: number;
  // caller identity (threaded from the tool handler)
  agentId?: string | null;
  agentName: string;
  sessionId?: string | null;
  runId?: string | null;
  /**
   * Optional concurrency group. Calls sharing a group are limited by a semaphore
   * so the render node (or an upstream provider) is not swamped. Examples:
   * "openmontage" for pipeline stage runs, "voidai" for image-gen calls.
   */
  concurrencyGroup?: string;
}

export interface RemoteExecResult {
  ok: boolean;
  machine: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  /** Secret NAMES injected (never values) — for audit/telemetry. */
  injectedSecrets?: string[];
}

/** bash single-quote a value so it is safe inside `export NAME='...'`. */
function sq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function ssh(command: string, opts: RemoteExecOpts, timeoutMs: number) {
  return sshRunCommand({
    machineRef: MACHINE(), command,
    agentId: opts.agentId ?? null, agentName: opts.agentName,
    sessionId: opts.sessionId ?? 'render-node-exec', runId: opts.runId ?? null,
    operator: true, timeoutMs,
  });
}

/**
 * Run a command on the render node with optional provider-secret injection.
 * When secretNames is empty this is a thin, credential-free ssh passthrough.
 * If opts.concurrencyGroup is set, the call participates in a per-group semaphore
 * to avoid swamping the node or upstream providers.
 */
export async function execRemoteWithSecrets(opts: RemoteExecOpts): Promise<RemoteExecResult> {
  const group = opts.concurrencyGroup;
  if (!group) return execRemoteWithSecretsUnlimited(opts);

  const sem = getSemaphore(group);
  const permit = await sem.acquire();
  try {
    return await execRemoteWithSecretsUnlimited(opts);
  } finally {
    permit.release();
  }
}

async function execRemoteWithSecretsUnlimited(opts: RemoteExecOpts): Promise<RemoteExecResult> {
  const machine = MACHINE();
  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const secretNames = (opts.secretNames ?? []).filter(Boolean);
  const cdPrefix = opts.cwd ? `cd ${sq(opts.cwd)} && ` : '';

  // ── detached path: launch-and-poll, NOT bound by the sshd exec ceiling ──────
  if (opts.detached) {
    const runDetached = (envVars?: Record<string, string>): Promise<DetachedRunResult> =>
      runDetachedOnRenderNode({
        machineRef: machine, command: opts.command, cwd: opts.cwd, envVars,
        maxWaitMs: opts.maxWaitMs, label: opts.command.slice(0, 60),
        agentId: opts.agentId ?? null, agentName: opts.agentName,
        sessionId: opts.sessionId ?? null, runId: opts.runId ?? null,
      });

    let res: DetachedRunResult;
    if (secretNames.length === 0) {
      res = await runDetached();
    } else {
      // Resolve provider secrets, then hand VALUES to the detached runner, which
      // writes them to a mode-600 env file the wrapper sources and shreds on exit.
      res = await agentStore.run(
        { agentName: opts.agentName, sessionId: opts.sessionId ?? 'render-node-exec' },
        () => broker.withSecrets(secretNames, async (env) => {
          const envVars: Record<string, string> = {};
          for (const n of secretNames) envVars[n] = env[n] ?? '';
          return runDetached(envVars);
        }),
      );
    }
    return {
      ok: res.ok, machine, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr,
      error: res.error, injectedSecrets: secretNames.length ? secretNames : [],
    };
  }

  // ── no secrets: plain passthrough ──────────────────────────────────────────
  if (secretNames.length === 0) {
    const r = await ssh(`${cdPrefix}${opts.command}`, opts, timeoutMs);
    return {
      ok: r.ok, machine, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
      error: r.ok ? undefined : (r.error || r.stderr || 'command failed'), injectedSecrets: [],
    };
  }

  // ── secrets path: resolve → env-file → source → run → shred ─────────────────
  const jobId = randomUUID();
  const localEnv = path.join(tmpdir(), `ncexec-${jobId}.env`);

  return agentStore.run({ agentName: opts.agentName, sessionId: opts.sessionId ?? 'render-node-exec' }, async () =>
    broker.withSecrets(secretNames, async (env): Promise<RemoteExecResult> => {
      // preflight: resolve $HOME + make a private throwaway dir
      const pre = await ssh(
        `mkdir -p "$HOME/${EXEC_ROOT}/${jobId}" && chmod 700 "$HOME/${EXEC_ROOT}" "$HOME/${EXEC_ROOT}/${jobId}" && echo "HOME=$HOME"`,
        opts, 40_000,
      );
      if (!pre.ok) {
        return { ok: false, machine, exitCode: pre.exitCode, stdout: '', stderr: pre.stderr,
          error: `preflight failed: ${pre.error || pre.stderr || 'ssh connection'}`, injectedSecrets: secretNames };
      }
      const home = /HOME=(\S+)/.exec(pre.stdout)?.[1];
      if (!home) return { ok: false, machine, exitCode: null, stdout: '', stderr: '', error: 'could not resolve remote $HOME', injectedSecrets: secretNames };

      const remoteDir = `${home}/${EXEC_ROOT}/${jobId}`;
      const remoteEnv = `${remoteDir}/env`;

      // build the env file locally (0600), then upload + delete the local copy
      const body = secretNames.map((n) => `export ${n}=${sq(env[n] ?? '')}`).join('\n') + '\n';
      try {
        await fsp.writeFile(localEnv, body, { mode: 0o600 });
        const up = await sshUpload({
          machineRef: machine, localPath: localEnv, remotePath: remoteEnv,
          agentId: opts.agentId ?? null, agentName: opts.agentName,
          sessionId: opts.sessionId ?? 'render-node-exec', runId: opts.runId ?? null, operator: true,
        });
        await fsp.rm(localEnv, { force: true }).catch(() => undefined);
        if (!up.ok) {
          await ssh(`rm -rf ${sq(remoteDir)}`, opts, 20_000).catch(() => undefined);
          return { ok: false, machine, exitCode: null, stdout: '', stderr: '', error: `env upload failed: ${up.error}`, injectedSecrets: secretNames };
        }

        // run: lock down perms, source secrets, run the command, capture rc,
        // shred the env file no matter what, then exit with the command's rc.
        // The audited command carries only the PATH — never a secret value.
        const wrapped =
          `chmod 600 ${sq(remoteEnv)}; ` +
          `set -a; . ${sq(remoteEnv)}; set +a; ` +
          `( ${cdPrefix}${opts.command} ); rc=$?; ` +
          `shred -u ${sq(remoteEnv)} 2>/dev/null || rm -f ${sq(remoteEnv)}; ` +
          `rm -rf ${sq(remoteDir)}; exit $rc`;
        const r = await ssh(wrapped, opts, timeoutMs);
        logger.info('render-node-exec: remote command complete', {
          machine, ok: r.ok, exitCode: r.exitCode, secrets: secretNames.length,
        });
        return {
          ok: r.ok, machine, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
          error: r.ok ? undefined : (r.error || r.stderr || 'command failed'), injectedSecrets: secretNames,
        };
      } catch (err) {
        await fsp.rm(localEnv, { force: true }).catch(() => undefined);
        await ssh(`rm -rf ${sq(remoteDir)}`, opts, 20_000).catch(() => undefined);
        return { ok: false, machine, exitCode: null, stdout: '', stderr: '', error: (err as Error).message, injectedSecrets: secretNames };
      }
    }),
  );
}

/** Convenience: does the render node answer at all? (fail-soft reachability probe.) */
export async function renderNodePing(agentName = 'operator'): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await sshRunCommand({
      machineRef: MACHINE(), command: 'echo nc-render-ok; uname -s; command -v python3 ffmpeg node >/dev/null 2>&1 && echo TOOLCHAIN_OK || echo TOOLCHAIN_PARTIAL',
      agentName, sessionId: 'render-node-ping', operator: true, timeoutMs: 20_000,
    });
    return { ok: r.ok, detail: r.ok ? r.stdout.trim() : (r.error || r.stderr || 'unreachable') };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
