// system/render-node-detached.ts — detached launch-and-poll exec on the render node.
//
// WHY THIS EXISTS
//   The render node's sshd enforces a hard per-exec ceiling (~10 minutes). Any
//   tool that holds a single SSH channel open for the full duration of a long
//   render (Puppeteer capture + NVENC encode, or a multi-stage OpenMontage run)
//   gets SIGKILLed the moment that ceiling trips. On the wire that SIGKILL tears
//   the CDP/stdout pipe mid-capture, which upstream code MISREADS as a
//   "Puppeteer/Chromium connection drop" — a phantom bug that can never be fixed
//   by chasing Chromium, because the real cause is the exec ceiling.
//
//   Raising our own timeout constant does NOTHING: the ceiling lives in the
//   remote sshd, not in us. The only correct fix is to stop holding the channel.
//
// HOW IT WORKS
//   1. LAUNCH  — a short SSH call writes a self-contained wrapper script into a
//      throwaway job dir, then starts it under `setsid` with ALL fds redirected
//      to files (stdout.log / stderr.log) and returns IMMEDIATELY. Because the
//      process is in its own session with no channel fds, sshd closes the
//      channel right away and never trips the ceiling.
//   2. POLL    — short-lived SSH calls (seconds each, always under the ceiling)
//      check for an exit-code marker file the wrapper writes on completion, or
//      liveness of the recorded PID. The render can now run for as long as the
//      wall-clock BUDGET allows, independent of the per-exec ceiling.
//   3. COLLECT — once the rc marker appears (or the process dies), one final SSH
//      call tails the durable stdout/stderr files and reads the exit code, then
//      removes the job dir. Output survives even if the pipe would have torn,
//      because it was written to disk, not streamed over the channel.
//   4. TIMEOUT — if the budget elapses while still running, the wrapper's process
//      GROUP is TERM/KILLed (setsid makes the wrapper a group leader, so children
//      — node, chromium, ffmpeg — die with it), logs are collected, dir removed.
//
// SECURITY
//   Same operator-scoped ssh-connect transport as render-forge / render-node-exec.
//   Optional provider secrets are written to a mode-600 `env` file, SFTP'd into
//   the job dir (audit logs the PATH only, never values), sourced by the wrapper,
//   and shredded by the wrapper the instant the command exits — so secret values
//   touch remote disk only for the lifetime of one run, on our own trusted node.

import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { sshRunCommand, sshUpload } from './ssh-connect';
import { logger } from '../utils/logger';

const DETACHED_ROOT = '.nc-detached'; // under $HOME on the node

/** Overall wall-clock budget for a detached run (default 45m, override via env). */
function defaultMaxWaitMs(): number {
  const v = Number(process.env['RENDER_NODE_MAX_WAIT_MS']);
  return Number.isFinite(v) && v > 0 ? v : 45 * 60_000;
}
/** How often to poll the node for completion (default 5s, override via env). */
function defaultPollMs(): number {
  const v = Number(process.env['RENDER_NODE_POLL_MS']);
  return Number.isFinite(v) && v >= 1_000 ? v : 5_000;
}

const LAUNCH_TIMEOUT_MS = 45_000;  // short: mkdir + upload + fire-and-return
const POLL_TIMEOUT_MS = 30_000;    // short: a single liveness probe
const COLLECT_TIMEOUT_MS = 60_000; // short: tail logs + rm
const DEFAULT_TAIL_BYTES = 200_000;

export interface DetachedRunOpts {
  machineRef: string;
  /** The command to run on the node. Embedded verbatim into an uploaded script,
   *  so NO shell-quoting of this string is required by the caller. */
  command: string;
  /** Optional working directory (cd'd into before the command). */
  cwd?: string;
  /** Optional already-resolved provider secrets to inject (name → value). Values
   *  are written to a mode-600 env file, sourced remotely, and shredded on exit. */
  envVars?: Record<string, string>;
  /** Overall wall-clock budget in ms. Defaults to RENDER_NODE_MAX_WAIT_MS or 45m. */
  maxWaitMs?: number;
  /** Poll cadence in ms. Defaults to RENDER_NODE_POLL_MS or 5s. */
  pollIntervalMs?: number;
  /** Tail cap for stdout/stderr readback (bytes). Default 200k. */
  tailBytes?: number;
  /** Human label for logs. */
  label?: string;
  // caller identity (threaded from the tool handler)
  agentId?: string | null;
  agentName: string;
  sessionId?: string | null;
  runId?: string | null;
}

export interface DetachedRunResult {
  ok: boolean;
  machine: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  /** True when the wall-clock budget elapsed and the process was killed. */
  timedOut?: boolean;
  durationMs: number;
  injectedSecrets?: string[];
}

/** bash single-quote a value so it is safe inside `export NAME='...'`. */
function sq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runDetachedOnRenderNode(opts: DetachedRunOpts): Promise<DetachedRunResult> {
  const machine = opts.machineRef;
  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? defaultMaxWaitMs();
  const pollMs = opts.pollIntervalMs ?? defaultPollMs();
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const secretNames = Object.keys(opts.envVars ?? {});
  const jobId = randomUUID();

  const ssh = (command: string, timeoutMs: number) =>
    sshRunCommand({
      machineRef: machine, command,
      agentId: opts.agentId ?? null, agentName: opts.agentName,
      sessionId: opts.sessionId ?? 'render-node-detached', runId: opts.runId ?? null,
      operator: true, timeoutMs,
    });

  const fail = (error: string, extra?: Partial<DetachedRunResult>): DetachedRunResult => ({
    ok: false, machine, exitCode: null, stdout: '', stderr: '', error,
    durationMs: Date.now() - started, injectedSecrets: secretNames.length ? secretNames : undefined,
    ...extra,
  });

  // ── preflight: resolve absolute $HOME + make a private throwaway job dir ─────
  const pre = await ssh(
    `mkdir -p "$HOME/${DETACHED_ROOT}/${jobId}" && ` +
    `chmod 700 "$HOME/${DETACHED_ROOT}" "$HOME/${DETACHED_ROOT}/${jobId}" && echo "HOME=$HOME"`,
    LAUNCH_TIMEOUT_MS,
  );
  if (!pre.ok) return fail(`preflight failed: ${pre.error || pre.stderr || 'ssh connection'}`);
  const home = /HOME=(\S+)/.exec(pre.stdout)?.[1];
  if (!home) return fail('could not resolve remote $HOME');

  const absJob = `${home}/${DETACHED_ROOT}/${jobId}`;
  const cdPrefix = opts.cwd ? `cd ${sq(opts.cwd)} && ` : '';

  // ── optional: upload the mode-600 env file with resolved secrets ────────────
  if (secretNames.length) {
    const localEnv = path.join(tmpdir(), `ncdet-${jobId}.env`);
    const body = secretNames.map((n) => `export ${n}=${sq(opts.envVars![n] ?? '')}`).join('\n') + '\n';
    try {
      await fsp.writeFile(localEnv, body, { mode: 0o600 });
      const up = await sshUpload({
        machineRef: machine, localPath: localEnv, remotePath: `${absJob}/env`,
        agentId: opts.agentId ?? null, agentName: opts.agentName,
        sessionId: opts.sessionId ?? 'render-node-detached', runId: opts.runId ?? null, operator: true,
      });
      await fsp.rm(localEnv, { force: true }).catch(() => undefined);
      if (!up.ok) {
        await ssh(`rm -rf ${sq(absJob)}`, COLLECT_TIMEOUT_MS).catch(() => undefined);
        return fail(`env upload failed: ${up.error}`);
      }
    } catch (err) {
      await fsp.rm(localEnv, { force: true }).catch(() => undefined);
      await ssh(`rm -rf ${sq(absJob)}`, COLLECT_TIMEOUT_MS).catch(() => undefined);
      return fail((err as Error).message);
    }
  }

  // ── build the self-contained wrapper script and upload it ───────────────────
  // The command is embedded verbatim (script, not a shell arg) so no caller-side
  // quoting is needed. The wrapper records its own PID (== PGID under setsid),
  // runs the command with durable stdout/stderr, writes the exit code atomically,
  // then shreds the env file. Everything the poller needs lives on disk.
  const envSource = secretNames.length
    ? `if [ -f "$D/env" ]; then set -a; . "$D/env"; set +a; fi\n`
    : '';
  const envShred = secretNames.length
    ? `shred -u "$D/env" 2>/dev/null || rm -f "$D/env"\n`
    : '';
  const wrapper =
    `#!/bin/sh\n` +
    `D=${sq(absJob)}\n` +
    `echo "$$" > "$D/pid"\n` +
    envSource +
    `( ${cdPrefix}${opts.command} ) > "$D/stdout.log" 2> "$D/stderr.log"\n` +
    `rc=$?\n` +
    `printf '%s' "$rc" > "$D/rc.tmp" && mv "$D/rc.tmp" "$D/rc"\n` +
    envShred;

  const localRun = path.join(tmpdir(), `ncdet-run-${jobId}.sh`);
  try {
    await fsp.writeFile(localRun, wrapper, { mode: 0o700 });
    const up = await sshUpload({
      machineRef: machine, localPath: localRun, remotePath: `${absJob}/run.sh`,
      agentId: opts.agentId ?? null, agentName: opts.agentName,
      sessionId: opts.sessionId ?? 'render-node-detached', runId: opts.runId ?? null, operator: true,
    });
    await fsp.rm(localRun, { force: true }).catch(() => undefined);
    if (!up.ok) {
      await ssh(`rm -rf ${sq(absJob)}`, COLLECT_TIMEOUT_MS).catch(() => undefined);
      return fail(`wrapper upload failed: ${up.error}`);
    }
  } catch (err) {
    await fsp.rm(localRun, { force: true }).catch(() => undefined);
    await ssh(`rm -rf ${sq(absJob)}`, COLLECT_TIMEOUT_MS).catch(() => undefined);
    return fail((err as Error).message);
  }

  // ── LAUNCH: fire under setsid with all fds detached, return immediately ─────
  // setsid → new session, so the process (and its child tree) survives the SSH
  // channel closing and is killable as a process group. Redirecting all three
  // fds to /dev/null lets sshd close the channel at once (no ceiling exposure).
  const launch = await ssh(
    `setsid sh ${sq(`${absJob}/run.sh`)} </dev/null >/dev/null 2>&1 & echo NC_LAUNCHED`,
    LAUNCH_TIMEOUT_MS,
  );
  if (!launch.ok || !/NC_LAUNCHED/.test(launch.stdout)) {
    await ssh(`rm -rf ${sq(absJob)}`, COLLECT_TIMEOUT_MS).catch(() => undefined);
    return fail(`launch failed: ${launch.error || launch.stderr || 'could not start detached process'}`);
  }

  logger.info('render-node-detached: launched', {
    machine, label: opts.label ?? opts.command.slice(0, 60), jobId, maxWaitMs, pollMs,
    secrets: secretNames.length,
  });

  // ── POLL: short SSH liveness probes until the rc marker appears ─────────────
  const pollCmd =
    `D=${sq(absJob)}; ` +
    `if [ -f "$D/rc" ]; then echo NCST=DONE; ` +
    `elif [ ! -f "$D/pid" ]; then echo NCST=START; ` +
    `elif kill -0 "$(cat "$D/pid" 2>/dev/null)" 2>/dev/null; then echo NCST=RUN; ` +
    `else echo NCST=DEAD; fi`;

  let finalState: 'DONE' | 'DEAD' | 'TIMEOUT' = 'TIMEOUT';
  let sshFailStreak = 0;
  while (Date.now() - started < maxWaitMs) {
    await sleep(pollMs);
    const p = await ssh(pollCmd, POLL_TIMEOUT_MS);
    if (!p.ok) {
      // A transient poll failure is not fatal — the render is still running on
      // the node. Tolerate a short streak, then give up (node likely unreachable).
      if (++sshFailStreak >= 5) return fail(`lost contact with node during poll: ${p.error || p.stderr}`);
      continue;
    }
    sshFailStreak = 0;
    if (/NCST=DONE/.test(p.stdout)) { finalState = 'DONE'; break; }
    if (/NCST=DEAD/.test(p.stdout)) { finalState = 'DEAD'; break; }
    // START (pid not written yet) or RUN → keep waiting.
  }

  // ── TIMEOUT: kill the whole process group before collecting ─────────────────
  if (finalState === 'TIMEOUT') {
    await ssh(
      `D=${sq(absJob)}; P=$(cat "$D/pid" 2>/dev/null); ` +
      `if [ -n "$P" ]; then kill -TERM "-$P" 2>/dev/null; sleep 2; kill -KILL "-$P" 2>/dev/null; fi`,
      COLLECT_TIMEOUT_MS,
    ).catch(() => undefined);
  }

  // ── COLLECT: tail durable logs + read exit code, then remove the job dir ─────
  const collect = await ssh(
    `D=${sq(absJob)}; ` +
    `printf 'NCRC<<\\n'; [ -f "$D/rc" ] && cat "$D/rc"; ` +
    `printf '\\nNCOUT<<\\n'; [ -f "$D/stdout.log" ] && tail -c ${tailBytes} "$D/stdout.log"; ` +
    `printf '\\nNCERR<<\\n'; [ -f "$D/stderr.log" ] && tail -c ${tailBytes} "$D/stderr.log"; ` +
    `printf '\\nNCEND<<\\n'; rm -rf "$D"`,
    COLLECT_TIMEOUT_MS,
  );

  const durationMs = Date.now() - started;
  const injectedSecrets = secretNames.length ? secretNames : undefined;

  if (!collect.ok) {
    return { ok: false, machine, exitCode: null, stdout: '', stderr: '',
      error: `collect failed: ${collect.error || collect.stderr}`, durationMs, injectedSecrets,
      timedOut: finalState === 'TIMEOUT' };
  }

  const out = collect.stdout;
  const between = (a: string, b: string): string => {
    const i = out.indexOf(a); if (i < 0) return '';
    const j = out.indexOf(b, i + a.length);
    return out.slice(i + a.length, j < 0 ? undefined : j);
  };
  const rcRaw = between('NCRC<<\n', '\nNCOUT<<').trim();
  const stdout = between('NCOUT<<\n', '\nNCERR<<');
  const stderr = between('NCERR<<\n', '\nNCEND<<');
  const exitCode = /^-?\d+$/.test(rcRaw) ? parseInt(rcRaw, 10) : null;

  if (finalState === 'TIMEOUT') {
    return { ok: false, machine, exitCode, stdout, stderr, timedOut: true, durationMs, injectedSecrets,
      error: `render exceeded wall-clock budget of ${Math.round(maxWaitMs / 1000)}s and was killed` };
  }
  if (finalState === 'DEAD') {
    return { ok: false, machine, exitCode, stdout, stderr, durationMs, injectedSecrets,
      error: exitCode === null ? 'process exited without writing a status code (crashed or was killed)' : `command failed (exit ${exitCode})` };
  }
  // DONE
  const ok = exitCode === 0;
  logger.info('render-node-detached: complete', { machine, label: opts.label ?? undefined, exitCode, durationMs });
  return { ok, machine, exitCode, stdout, stderr, durationMs, injectedSecrets,
    error: ok ? undefined : (stderr.slice(-800) || `command failed (exit ${exitCode})`) };
}
