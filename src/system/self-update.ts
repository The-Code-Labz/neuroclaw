// GitHub self-update engine.
//
// Safe, one-action "pull from GitHub → rebuild frontend → restart" with rollback.
// Ships DORMANT behind config.update.enabled (UPDATE_ENABLED, default false).
//
// Security posture (ASAGI-reviewed, spec 2026-07-15-github-self-update §9):
//   C1  PAT via `http.extraHeader`, NEVER in a URL → nothing leaks to .git/FETCH_HEAD,
//       error messages, or streamed output. Output is still defensively scrubbed.
//   C2  fetch with an explicit tracking-ref refspec so ASSESS/APPLY compare against
//       the freshly-fetched commit, not a stale refs/remotes ref.
//   C3  dirty-check is TRACKED-ONLY (untracked _shared/ etc. are permanent-by-design).
//   C4  stash (if used) is always restored / surfaced — never stranded.
//   C5  boot-canary marker (read by the CJS pre-check + server.ts) — see marker helpers.
//   C6  code-rollback never reverts schema; migrations must stay backward-compatible.
//   C7  /update requires a nonce issued by /check (route layer).
//   C8  remote/branch are trust-pinned from env; request bodies cannot redirect them.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { agentStore, broker } from '../broker';
import { config } from '../config';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

// --- paths ---------------------------------------------------------------

const REPO_ROOT = process.cwd();
const NC_GIT_PATH = path.join(REPO_ROOT, 'scripts', 'nc-git.sh');

/** Marker file read by BOTH the tsx server (in-process canary) and the CJS
 *  ExecStartPre pre-check (out-of-module-graph canary). Repo root = systemd
 *  WorkingDirectory, so an absolute join is stable across both readers. */
export const UPDATE_MARKER_PATH = path.join(REPO_ROOT, '.update-marker.json');

export type UpdatePhase =
  | 'idle' | 'restarting' | 'verifying' | 'ok';

export interface UpdateMarker {
  phase: UpdatePhase;
  fromSha: string;
  toSha: string;
  rollbackTag: string;
  attempts: number;
  ts: string;
  buildRan?: boolean;
}

// --- git plumbing --------------------------------------------------------

interface GitResult { code: number; stdout: string; stderr: string; }

/** Replace every occurrence of the token value with a placeholder. Belt-and-
 *  suspenders: with PAT-via-header there is normally nothing to scrub, but a
 *  future code path (or a git that echoes headers on -v) must never leak it. */
function scrub(s: string, token?: string): string {
  if (!s) return s;
  let out = s;
  if (token) out = out.split(token).join('***GITHUB_PAT***');
  return out;
}

const NC_GIT_MUTATIONS = new Set(['fetch', 'checkout', 'merge', 'reset', 'tag', 'stash']);

/** Run git. Mutating ops (fetch/checkout/merge/reset/tag/stash) go through the
 *  serialized nc-git wrapper so all writes to the shared main checkout hold the
 *  checkout lock and carry a valid token. Read-only ops (rev-parse/diff/log/
 *  rev-list) run with plain `git -C REPO_ROOT` to avoid lock/audit noise. */
async function git(args: string[], token?: string): Promise<GitResult> {
  const isMutation = NC_GIT_MUTATIONS.has(args[0] ?? '');
  const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (isMutation) {
    const preArgs: string[] = [];
    if (token) {
      // credential.helper= disables any configured helper; extraHeader carries auth.
      preArgs.push('-c', 'credential.helper=');
      preArgs.push('-c', `http.extraHeader=Authorization: Bearer ${token}`);
    }
    try {
      const { stdout, stderr } = await execFileAsync('bash', [NC_GIT_PATH, ...preArgs, ...args], {
        cwd: REPO_ROOT,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...baseEnv, NC_GIT_SELF_UPDATE: '1' },
      });
      return { code: 0, stdout: scrub(stdout, token), stderr: scrub(stderr, token) };
    } catch (e: any) {
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: scrub(e.stdout ?? '', token),
        stderr: scrub(e.stderr ?? e.message ?? '', token),
      };
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', REPO_ROOT, ...args], {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
      env: baseEnv,
    });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

/** Resolve the OPTIONAL GitHub PAT and run `fn` with it.
 *
 *  A public repo needs NO auth — anonymous fetch works — so a missing or
 *  unresolvable PAT is NOT fatal. If the broker has no SHARED_GITHUB_PAT (the
 *  normal case for a public/distributable deployment, which surfaces as
 *  `secret_not_found:SHARED_GITHUB_PAT`) or there is no agent context, we fall
 *  through to an ANONYMOUS git op (token=undefined). `git()` only attaches the
 *  auth header when a token is present, so `git fetch origin` then relies on the
 *  remote URL alone (public HTTPS → anonymous). Private-repo deployments that DO
 *  have SHARED_GITHUB_PAT in their broker still pick it up and authenticate.
 *  HTTP routes have no ambient agent context, so a system-scoped one is set for
 *  the resolve. */
async function withToken<T>(fn: (token?: string) => Promise<T>): Promise<T> {
  let token: string | undefined;
  try {
    token = await agentStore.run(
      { agentName: 'system', sessionId: 'self-update' },
      () => broker.withSecrets(['SHARED_GITHUB_PAT'], async (env) => env['SHARED_GITHUB_PAT'] || undefined),
    );
  } catch (e: any) {
    // No PAT / no agent context → proceed anonymously (public-repo fetch is unauthenticated).
    logger.info('self-update: no GitHub PAT available — using anonymous fetch (public repo)', {
      reason: String(e?.message ?? e).slice(0, 120),
    });
    token = undefined;
  }
  return fn(token);
}

async function currentSha(): Promise<string> {
  const r = await git(['rev-parse', 'HEAD']);
  return r.stdout.trim();
}

/** TRACKED-ONLY dirty check (C3). Untracked files (e.g. _shared/) do not count. */
async function isTrackedDirty(): Promise<boolean> {
  const unstaged = await git(['diff', '--quiet']);
  const staged = await git(['diff', '--cached', '--quiet']);
  return unstaged.code !== 0 || staged.code !== 0;
}

// --- check ---------------------------------------------------------------

export interface UpdateCheck {
  ok: boolean;
  enabled: boolean;
  current: string;
  remote: string;
  branch: string;
  behind: number;
  ahead: number;
  dirty: boolean;
  upToDate: boolean;
  commits: { sha: string; subject: string }[];
  error?: string;
}

/** Fetch (C1 header-auth, C2 tracking-ref refspec) and report the gap without
 *  mutating the working tree. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const { remote, branch } = config.update;
  const base: UpdateCheck = {
    ok: false, enabled: config.update.enabled, current: '', remote, branch,
    behind: 0, ahead: 0, dirty: false, upToDate: false, commits: [],
  };
  try {
    base.current = await currentSha();
    base.dirty = await isTrackedDirty();

    const fetch = await withToken((token) =>
      git(['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], token));
    if (fetch.code !== 0) {
      return { ...base, error: `fetch failed: ${fetch.stderr.slice(0, 300)}` };
    }

    const tracking = `refs/remotes/${remote}/${branch}`;
    const behindR = await git(['rev-list', '--count', `HEAD..${tracking}`]);
    const aheadR = await git(['rev-list', '--count', `${tracking}..HEAD`]);
    base.behind = parseInt(behindR.stdout.trim() || '0', 10);
    base.ahead = parseInt(aheadR.stdout.trim() || '0', 10);
    base.upToDate = base.behind === 0;

    if (base.behind > 0) {
      const log = await git(['log', '--no-merges', '--pretty=%h%s', `HEAD..${tracking}`]);
      base.commits = log.stdout.split('\n').filter(Boolean).slice(0, 50).map((l) => {
        const [sha, ...rest] = l.split('');
        return { sha, subject: rest.join('') };
      });
    }
    base.ok = true;
    return base;
  } catch (e: any) {
    return { ...base, error: String(e?.message ?? e).slice(0, 300) };
  }
}

// --- update state machine -----------------------------------------------

export type ProgressFn = (phase: string, message: string, data?: any) => void;

export interface UpdateResult {
  ok: boolean;
  status: 'up_to_date' | 'ready_to_restart' | 'refused' | 'rolled_back' | 'error';
  fromSha: string;
  toSha: string;
  rollbackTag?: string;
  stashRef?: string;
  message: string;
}

const FRONTEND_RE = /^src\/dashboard\/(v2|v4)\/.*\.(jsx|tsx|css|html)$/;
const V4_RE = /^src\/dashboard\/v4\//;

export async function runSelfUpdate(
  opts: { stash?: boolean },
  onProgress: ProgressFn = () => {},
): Promise<UpdateResult> {
  const { remote, branch, canaryMaxAttempts } = config.update;
  const fromSha = await currentSha();
  const result: UpdateResult = { ok: false, status: 'error', fromSha, toSha: fromSha, message: '' };

  // 0. PREFLIGHT
  onProgress('preflight', 'checking preconditions');
  if (!config.update.enabled) {
    return { ...result, status: 'refused', message: 'self-update is disabled (UPDATE_ENABLED=false)' };
  }
  let stashRef: string | undefined;
  if (await isTrackedDirty()) {
    if (!opts.stash) {
      return { ...result, status: 'refused',
        message: 'working tree has uncommitted TRACKED changes — commit them or retry with stash=true' };
    }
    const st = await git(['stash', 'push', '-u', '-m', `self-update-${Date.now()}`]);
    if (st.code !== 0) return { ...result, status: 'refused', message: `stash failed: ${st.stderr.slice(0, 200)}` };
    // capture the stash ref so we can always restore it (C4)
    const list = await git(['stash', 'list', '--format=%gd', '-n', '1']);
    stashRef = list.stdout.trim() || 'stash@{0}';
    result.stashRef = stashRef;
    onProgress('preflight', `stashed local changes → ${stashRef}`);
  }

  // helper: always try to restore the stash before returning (C4)
  const restoreStash = async () => {
    if (!stashRef) return;
    const pop = await git(['stash', 'pop']);
    if (pop.code !== 0) {
      onProgress('stash', `⚠️ could not auto-pop ${stashRef} — restore manually with: git stash pop ${stashRef}`);
    } else {
      onProgress('stash', `restored local changes from ${stashRef}`);
    }
  };

  try {
    // 1. FETCH (C1 + C2)
    onProgress('fetch', `fetching ${remote}/${branch}`);
    const fetch = await withToken((token) =>
      git(['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], token));
    if (fetch.code !== 0) {
      await restoreStash();
      return { ...result, status: 'error', message: `fetch failed: ${fetch.stderr.slice(0, 300)}` };
    }

    // 2. ASSESS
    const tracking = `refs/remotes/${remote}/${branch}`;
    const toSha = (await git(['rev-parse', tracking])).stdout.trim();
    result.toSha = toSha;
    const behind = parseInt((await git(['rev-list', '--count', `HEAD..${tracking}`])).stdout.trim() || '0', 10);
    if (behind === 0) {
      await restoreStash();
      return { ...result, ok: true, status: 'up_to_date', message: 'already up to date' };
    }
    onProgress('assess', `${behind} commit(s) behind → ${toSha.slice(0, 8)}`, { behind });

    // Changed-file list for conditional deps/build (before we apply)
    const diffR = await git(['diff', '--name-only', `HEAD..${tracking}`]);
    const changed = diffR.stdout.split('\n').filter(Boolean);
    const depsChanged = changed.some((f) => f === 'package-lock.json' || f === 'package.json');
    const frontendChanged = changed.some((f) => FRONTEND_RE.test(f));
    const v4Changed = changed.some((f) => V4_RE.test(f));

    // 3. TAG rollback anchor
    const rollbackTag = `rollback/pre-update-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await git(['tag', rollbackTag, fromSha]);
    result.rollbackTag = rollbackTag;
    onProgress('tag', `rollback anchor → ${rollbackTag}`);

    // rollback helper (C6: code only — never touches schema)
    const rollback = async (why: string, buildRan: boolean): Promise<UpdateResult> => {
      onProgress('rollback', `reverting: ${why}`);
      await git(['reset', '--hard', rollbackTag]);
      if (buildRan && frontendChanged) {
        onProgress('rollback', 'rebuilding prior frontend bundle');
        await runBuild(v4Changed, onProgress).catch(() => {});
      }
      await restoreStash();
      return { ...result, ok: false, status: 'rolled_back', message: `rolled back: ${why}` };
    };

    // 4. APPLY (ff-only — refuses divergence rather than clobbering)
    onProgress('apply', `merging ${tracking} (ff-only)`);
    const merge = await git(['merge', '--ff-only', tracking]);
    if (merge.code !== 0) {
      await restoreStash();
      return { ...result, status: 'error',
        message: `merge --ff-only failed (local diverged from ${remote}/${branch}?): ${merge.stderr.slice(0, 300)}` };
    }

    // 5. DEPS
    if (depsChanged) {
      onProgress('deps', 'installing dependencies (package changed)');
      const npm = await runNpm(['install', '--no-audit', '--no-fund'], onProgress);
      if (npm.code !== 0) return rollback(`npm install failed: ${npm.stderr.slice(0, 200)}`, false);
    }

    // 6. BUILD (frontend only — backend runs from source via tsx)
    let buildRan = false;
    if (frontendChanged) {
      onProgress('build', `rebuilding dashboard bundle${v4Changed ? ' (v2+v4)' : ' (v2)'}`);
      const b = await runBuild(v4Changed, onProgress);
      buildRan = true;
      if (b.code !== 0) return rollback(`build:dashboard failed: ${b.stderr.slice(0, 200)}`, buildRan);
    }

    // 7. VERIFY (typecheck gate)
    onProgress('verify', 'typecheck (tsc --noEmit)');
    const tsc = await runNpx(['tsc', '--noEmit'], onProgress);
    if (tsc.code !== 0) {
      return rollback(`tsc --noEmit failed:\n${tsc.stdout.slice(-600)}`, buildRan);
    }

    // 8. MARK (canary hand-off) — written BEFORE the restart the route triggers
    writeMarker({
      phase: 'restarting', fromSha, toSha, rollbackTag, attempts: 0,
      ts: new Date().toISOString(), buildRan,
    });

    // stash is intentionally NOT popped here: it survives the restart in the
    // stash list; the route surfaces stashRef so the operator can pop it after.
    onProgress('ready', 'update applied + verified — restarting', { toSha, stashRef });
    return { ...result, ok: true, status: 'ready_to_restart',
      message: `updated ${fromSha.slice(0, 8)} → ${toSha.slice(0, 8)} — restarting`, toSha, rollbackTag, stashRef };
  } catch (e: any) {
    await restoreStash();
    return { ...result, status: 'error', message: String(e?.message ?? e).slice(0, 300) };
  }
}

// --- external command runners -------------------------------------------

function collect(args: string[], onProgress: ProgressFn, label: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(args[0], args.slice(1), { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; onProgress(label, String(d).trim().slice(0, 200)); });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: String(e.message) }));
  });
}
const runNpm = (a: string[], p: ProgressFn) => collect(['npm', ...a], p, 'deps');
const runNpx = (a: string[], p: ProgressFn) => collect(['npx', ...a], p, 'verify');
async function runBuild(v4: boolean, p: ProgressFn): Promise<GitResult> {
  const r = await collect(['npm', 'run', 'build:dashboard'], p, 'build');
  if (r.code !== 0 || !v4) return r;
  return collect(['npm', 'run', 'build:dashboard:v4'], p, 'build');
}

// --- canary marker (C5) --------------------------------------------------

export function readMarker(): UpdateMarker | null {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_MARKER_PATH, 'utf8'));
  } catch { return null; }
}
export function writeMarker(m: UpdateMarker): void {
  try { fs.writeFileSync(UPDATE_MARKER_PATH, JSON.stringify(m, null, 2)); }
  catch (e) { logger.error('self-update: failed to write marker', { e: String(e) }); }
}
export function clearMarker(): void {
  try { if (fs.existsSync(UPDATE_MARKER_PATH)) fs.unlinkSync(UPDATE_MARKER_PATH); } catch { /* ignore */ }
}

/** Called from server.ts once the HTTP server is listening AND migrations have
 *  succeeded (§9 C5 hook placement). Confirms a post-update boot is healthy and
 *  clears the marker so the next boot won't auto-revert. Layer-B guard for the
 *  uncaughtException handler reads this same marker. */
export function markBootHealthy(): void {
  const m = readMarker();
  if (!m) return;
  if (m.phase === 'restarting' || m.phase === 'verifying') {
    logger.info('self-update: post-update boot healthy — clearing marker', { toSha: m.toSha });
    clearMarker();
  }
}

/** True while a post-update boot is still unproven (marker present + not ok).
 *  server.ts's uncaughtException handler uses this to decide whether a stray
 *  throw during startup should crash the process (Layer B) instead of limping. */
export function isBootUnproven(): boolean {
  const m = readMarker();
  return !!m && m.phase !== 'ok';
}

// --- nonce (C7) ----------------------------------------------------------

interface Nonce { value: string; issued: number; }
let activeNonce: Nonce | null = null;
const NONCE_TTL_MS = 5 * 60 * 1000;

export function issueNonce(): string {
  activeNonce = { value: crypto.randomBytes(18).toString('hex'), issued: Date.now() };
  return activeNonce.value;
}
export function consumeNonce(v: string): boolean {
  if (!activeNonce) return false;
  const ok = activeNonce.value === v && (Date.now() - activeNonce.issued) < NONCE_TTL_MS;
  activeNonce = null; // single-use
  return ok;
}
