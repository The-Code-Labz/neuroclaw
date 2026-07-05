// src/system/spawn-collect.ts
//
// Process-group-safe command runner shared by bash_run (exec-tools) and the
// broker /exec route. Fixes the hang where a backgrounded grandchild inherits
// the stdout/stderr pipe: the old code waited on 'close' (pipe EOF) and killed
// only the direct child PID, so such a child kept the pipe open forever and the
// Promise never settled. Here we spawn detached, resolve on 'exit', kill the
// whole group on timeout/cleanup, and guarantee settlement via a hard fallback.

import { spawn } from 'child_process';

export interface SpawnCollectOpts {
  command:        string;
  cwd?:           string;
  env:            NodeJS.ProcessEnv;
  timeoutMs:      number;
  outputCapBytes: number;
  shellArgs?:     string[];
  killGraceMs?:   number;
  drainMs?:       number;
}

export interface SpawnCollectResult {
  code:       number | null;
  signal:     string | null;
  stdout:     string;
  stderr:     string;
  truncated:  boolean;
  timedOut:   boolean;
  spawnError: string | null;
  durationMs: number;
}

export function spawnCollect(opts: SpawnCollectOpts): Promise<SpawnCollectResult> {
  const shellArgs   = opts.shellArgs   ?? ['-lc'];
  const killGraceMs = opts.killGraceMs ?? 2000;
  const drainMs     = opts.drainMs     ?? 50;
  const start = Date.now();

  return new Promise<SpawnCollectResult>((resolve) => {
    const child = spawn('bash', [...shellArgs, opts.command], {
      cwd:      opts.cwd,
      env:      opts.env,
      detached: true,                       // child is its own process-group leader
      stdio:    ['ignore', 'pipe', 'pipe'],
    });
    child.unref();

    let stdout = '';
    let stderr = '';
    let truncated  = false;
    let timedOut   = false;
    let spawnError: string | null = null;
    let settled    = false;

    // Signal the whole process group (negative PID) so backgrounded grandchildren
    // die too and release the inherited stdout/stderr pipe. Linux/macOS only —
    // Windows has no POSIX process groups. ESRCH (group already gone) is expected
    // on a clean exit and is swallowed.
    const killGroup = (sig: NodeJS.Signals): void => {
      try { if (child.pid) process.kill(-child.pid, sig); }
      catch { /* ESRCH — group already gone, expected */ }
    };

    const append = (which: 'out' | 'err', data: string): void => {
      if (truncated) return;
      if (which === 'out') stdout += data; else stderr += data;
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > opts.outputCapBytes) {
        truncated = true;
        killGroup('SIGTERM');
      }
    };
    child.stdout?.on('data', (d) => append('out', d.toString('utf8')));
    child.stderr?.on('data', (d) => append('err', d.toString('utf8')));

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      killGroup('SIGKILL');                 // reap any lingering background grandchildren
      resolve({
        code:       child.exitCode,
        signal:     child.signalCode ?? null,
        stdout, stderr, truncated, timedOut, spawnError,
        durationMs: Date.now() - start,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');                 // foreground dies → 'exit' fires → drain → settle
    }, opts.timeoutMs);

    const hardTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killGroup('SIGKILL');
      settle();                             // defensive: settle even if 'exit' never fires
    }, opts.timeoutMs + killGraceMs);

    child.on('exit', () => { setTimeout(settle, drainMs); });
    child.on('error', (err) => { spawnError = err.message; setTimeout(settle, drainMs); });
  });
}
