// system/render-forge.ts — one-call remote render dispatch (Studio render forge).
//
// PURPOSE: take a composition authored on the app box (HyperFrames HTML+GSAP, or
// a Remotion project) and render it on the GPU render-node, then pull the MP4
// back and auto-land it in the Media gallery. This is the single primitive that
// merges three loose ends proven manually across prior work:
//   (1) the ssh_upload → ssh_run → ssh_download dispatch,
//   (2) the "wrap it as a tool" recommendation, and
//   (3) the registerLocalMedia auto-registration hook.
//
// SECURITY: SSH credentials are NEVER touched here. The dispatch rides the
// vetted ssh-connect helpers, which resolve the machine password server-side
// through the restricted-secret broker capability. We pass operator:true so the
// tool works for ANY agent regardless of the per-machine allow-list — the tool
// itself (fixed machine, constrained render command, validated inputs) is the
// authorization boundary, not a per-agent grant.
//
// SELF-CONTAINED: the HyperFrames render driver is generated and uploaded PER
// JOB, so the node only needs the persistent forge node_modules (puppeteer for
// HyperFrames, remotion for Remotion) — not a harness script we'd have to keep
// in sync. Everything else is staged into a throwaway ~/render-jobs/<id> dir
// that is removed after the pull.

import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { sshRunCommand, sshUpload, sshDownload } from './ssh-connect';
import { runDetachedOnRenderNode } from './render-node-detached';
import { registerLocalMedia } from './media-store';
import { logger } from '../utils/logger';

const execFileP = promisify(execFile);

export type RenderEngine = 'hyperframes' | 'remotion';

export interface RenderRemoteOpts {
  engine: RenderEngine;
  projectPath: string;
  title?: string;
  durationSeconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  compositionId?: string;
  entry?: string;
  register?: boolean;
  // caller identity (threaded from the tool handler)
  agentId?: string | null;
  agentName: string;
  sessionId?: string | null;
  runId?: string | null;
}

export interface RenderRemoteResult {
  ok: boolean;
  engine: RenderEngine;
  machine: string;
  localPath?: string;
  mediaId?: string;
  playbackNote?: string;
  frames?: number;
  renderMs?: number;
  stdoutTail?: string;
  error?: string;
}

const MACHINE = () => (process.env['RENDER_NODE_MACHINE'] || 'render-node').trim();
const HF_FORGE = '$HOME/render-forge';        // persistent puppeteer install
const REMOTION_FORGE = '$HOME/remotion-forge'; // persistent remotion install (reference only)
// The render itself is dispatched DETACHED (launch-and-poll) so it is NOT bound
// by the render node's ~10m sshd exec ceiling — a long HyperFrames capture +
// NVENC encode ("Last Page" needs >9m of GPU time) would otherwise be SIGKILLed
// mid-capture, surfacing as a phantom "Chromium connection drop". Wall-clock
// budget is governed by RENDER_NODE_MAX_WAIT_MS (default 45m) in the runner.

/**
 * The per-job HyperFrames driver. Loads the composition, drives the GSAP
 * timeline frame-by-frame, screenshots each frame, then NVENC-encodes to MP4.
 *
 * CRITICAL: the seek callback must NOT return the GSAP timeline — seek() is
 * chainable and returns `this`, which Puppeteer then tries to serialize over
 * CDP, hanging Runtime.callFunctionOn until timeout. Every page.evaluate below
 * is wrapped so it returns undefined. (This is the exact bug proven+fixed
 * earlier; baking the fix into the shipped driver so it can never regress.)
 */
const HF_DRIVER = String.raw`
const puppeteer = require('puppeteer');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

(async () => {
  const htmlPath = process.argv[2];
  const outMp4   = process.argv[3];
  const fps      = parseInt(process.argv[4], 10) || 30;
  const dur      = parseFloat(process.argv[5]) || 5;
  const W        = parseInt(process.argv[6], 10) || 1280;
  const H        = parseInt(process.argv[7], 10) || 720;
  const total    = Math.max(1, Math.round(fps * dur));
  const framesDir = path.join(path.dirname(outMp4), 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.goto('file://' + path.resolve(htmlPath), { waitUntil: 'networkidle0' });
    // Resolve which timeline instance actually drives this composition. The
    // HyperFrames authoring convention (see hyperframes-cut/AGENTS.md) registers
    // the master GSAP timeline as window.__timelines[<data-composition-id>], NOT
    // window.__TL — that stale key never matched anything, so every render fell
    // through to seeking window.gsap.globalTimeline, which does NOT propagate
    // into a *paused* child timeline. Net effect: the composition was frozen at
    // t=0 (scene 1) for the entire capture. Pause the actual composition
    // timeline explicitly and seek THAT instance.
    await page.evaluate(() => {
      const root = document.getElementById('root');
      const compId = root && root.getAttribute('data-composition-id');
      const map = window.__timelines || {};
      const tl = (compId && map[compId]) || window.__TL || map['main'] || Object.values(map)[0];
      if (tl && typeof tl.pause === 'function') { tl.pause(); }
      else if (window.gsap) { window.gsap.globalTimeline.pause(); }
    });
    for (let f = 0; f < total; f++) {
      const t = f / fps;
      // seek returns the timeline (chainable) — swallow it, return nothing.
      await page.evaluate((tt) => {
        const root = document.getElementById('root');
        const compId = root && root.getAttribute('data-composition-id');
        const map = window.__timelines || {};
        const tl = (compId && map[compId]) || window.__TL || map['main'] || Object.values(map)[0];
        if (tl && typeof tl.seek === 'function') { tl.seek(tt); }
        else if (window.gsap) { window.gsap.globalTimeline.seek(tt); }
      }, t);
      await page.screenshot({ path: path.join(framesDir, 'frame' + String(f).padStart(5, '0') + '.png') });
    }
    await browser.close();
    // HARD-FAIL frame-diff check: a silently-frozen composition (e.g. seek()
    // resolving to the wrong/paused timeline instance) still produces exactly
    // \`total\` identical screenshots, so frame COUNT alone can never catch it —
    // this is how a static-frame render with audio slid through as "done"
    // before. Hash first/mid/last frames; if capture never advanced, fail loud
    // here instead of letting ffmpeg happily encode a frozen video that later
    // gets auto-registered into the gallery as a finished render.
    if (total >= 2) {
      const hash = (f) => crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(framesDir, f))).digest('hex');
      const first = 'frame' + String(0).padStart(5, '0') + '.png';
      const mid = 'frame' + String(Math.floor(total / 2)).padStart(5, '0') + '.png';
      const last = 'frame' + String(total - 1).padStart(5, '0') + '.png';
      const hFirst = hash(first), hMid = hash(mid), hLast = hash(last);
      if (hFirst === hMid && hFirst === hLast) {
        fs.rmSync(framesDir, { recursive: true, force: true });
        throw new Error('FROZEN_CAPTURE: first/mid/last frames are byte-identical — timeline did not advance during capture (composition is likely stuck at t=0)');
      }
    }
    // NVENC encode (h264_nvenc on the GTX 1060). Even-dimension safety via scale.
    execFileSync('ffmpeg', [
      '-y', '-framerate', String(fps),
      '-i', path.join(framesDir, 'frame%05d.png'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'h264_nvenc', '-preset', 'p4', '-pix_fmt', 'yuv420p',
      outMp4,
    ], { stdio: 'inherit' });
    fs.rmSync(framesDir, { recursive: true, force: true });
    console.log('FRAMES=' + total);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
})().catch((e) => { console.error('DRIVER_ERROR', e && e.stack || e); process.exit(1); });
`;

/** Shell-quote a single argument for safe interpolation into a remote command. */
function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function ssh(command: string, opts: RenderRemoteOpts, timeoutMs = 60_000) {
  return sshRunCommand({
    machineRef: MACHINE(), command,
    agentId: opts.agentId ?? null, agentName: opts.agentName,
    sessionId: opts.sessionId ?? 'render-forge', runId: opts.runId ?? null,
    operator: true, timeoutMs,
  });
}

/**
 * Dispatch a render to the node and return the pulled-back MP4 (auto-registered
 * into the Media gallery unless register:false). Cleans up remote + local temp.
 */
export async function renderRemote(opts: RenderRemoteOpts): Promise<RenderRemoteResult> {
  const machine = MACHINE();
  const base: RenderRemoteResult = { ok: false, engine: opts.engine, machine };

  // ── validate local project ────────────────────────────────────────────────
  let stat;
  try { stat = await fsp.stat(opts.projectPath); }
  catch { return { ...base, error: `local project path not found: ${opts.projectPath}` }; }
  if (!stat.isDirectory()) return { ...base, error: `project_path must be a folder: ${opts.projectPath}` };
  if (opts.engine === 'hyperframes') {
    try { await fsp.stat(path.join(opts.projectPath, 'index.html')); }
    catch { return { ...base, error: 'hyperframes project must contain index.html' }; }
  }

  const jobId = randomUUID();
  const jobDir = `$HOME/render-jobs/${jobId}`;
  const remoteTgz = `${jobDir}/project.tgz`;
  const remoteProj = `${jobDir}/project`;
  const remoteOut = `${jobDir}/out.mp4`;
  const localTgz = path.join(tmpdir(), `render-${jobId}.tgz`);
  const localDriver = path.join(tmpdir(), `hf-driver-${jobId}.cjs`);
  const localOut = path.join(tmpdir(), `render-${jobId}.mp4`);
  const cleanupLocal = async () => {
    for (const f of [localTgz, localDriver]) { try { await fsp.rm(f, { force: true }); } catch { /* noop */ } }
  };

  try {
    // ── preflight: resolve $HOME, make the job dir, verify the forge exists ──
    const forgeModules = opts.engine === 'hyperframes'
      ? `${HF_FORGE}/node_modules/puppeteer`
      : `${REMOTION_FORGE}/node_modules`;
    const pre = await ssh(
      `set -e; mkdir -p ${jobDir}; echo "HOME=$HOME"; ` +
      `if [ -e ${forgeModules} ]; then echo FORGE_OK; else echo FORGE_MISSING; fi; ` +
      `command -v ffmpeg >/dev/null && echo FFMPEG_OK`,
      opts, 40_000,
    );
    if (!pre.ok) { await cleanupLocal(); return { ...base, error: `preflight/ssh failed: ${pre.error || pre.stderr || 'connection'}` }; }
    const homeMatch = /HOME=(\S+)/.exec(pre.stdout);
    const home = homeMatch ? homeMatch[1] : '';
    if (!home) { await cleanupLocal(); return { ...base, error: 'could not resolve remote $HOME' }; }
    if (/FORGE_MISSING/.test(pre.stdout)) {
      await cleanupLocal();
      return { ...base, error: `render forge not installed on ${machine} for ${opts.engine} (expected ${forgeModules}). Run Phase 2 provisioning first.` };
    }
    // absolute remote paths for SFTP (does not expand ~/$HOME)
    const absJob = `${home}/render-jobs/${jobId}`;
    const absTgz = `${absJob}/project.tgz`;
    const absDriver = `${absJob}/driver.cjs`;
    const absOut = `${absJob}/out.mp4`;

    // ── package + upload the project (exclude heavy/irrelevant dirs) ─────────
    const parent = path.dirname(opts.projectPath);
    const baseName = path.basename(opts.projectPath);
    await execFileP('tar', [
      'czf', localTgz,
      '--exclude=node_modules', '--exclude=.git', '--exclude=out', '--exclude=frames',
      '-C', parent, baseName,
    ], { maxBuffer: 64 * 1024 * 1024 });

    const up = await sshUpload({
      machineRef: machine, localPath: localTgz, remotePath: absTgz,
      agentId: opts.agentId ?? null, agentName: opts.agentName,
      sessionId: opts.sessionId ?? 'render-forge', runId: opts.runId ?? null, operator: true,
    });
    if (!up.ok) { await cleanupLocal(); return { ...base, error: `upload failed: ${up.error}` }; }

    // extract; normalize so the project always lands at ${jobDir}/project
    await ssh(
      `set -e; cd ${jobDir}; mkdir -p project; tar xzf project.tgz -C project --strip-components=1; rm -f project.tgz`,
      opts, 60_000,
    );

    // ── render ────────────────────────────────────────────────────────────
    const started = Date.now();
    let renderCmd: string;
    if (opts.engine === 'hyperframes') {
      await fsp.writeFile(localDriver, HF_DRIVER, 'utf8');
      const drv = await sshUpload({
        machineRef: machine, localPath: localDriver, remotePath: absDriver,
        agentId: opts.agentId ?? null, agentName: opts.agentName,
        sessionId: opts.sessionId ?? 'render-forge', runId: opts.runId ?? null, operator: true,
      });
      if (!drv.ok) { await cleanupLocal(); return { ...base, error: `driver upload failed: ${drv.error}` }; }
      const fps = opts.fps ?? 30, dur = opts.durationSeconds ?? 5, w = opts.width ?? 1280, h = opts.height ?? 720;
      renderCmd =
        `set -e; export NODE_PATH=${HF_FORGE}/node_modules; ` +
        `export PUPPETEER_CACHE_DIR=$HOME/.cache/puppeteer; ` +
        `node ${jobDir}/driver.cjs ${jobDir}/project/index.html ${remoteOut} ${fps} ${dur} ${w} ${h}`;
    } else {
      const comp = opts.compositionId || 'Main';
      const entry = opts.entry ? ` ${q(opts.entry)}` : '';
      renderCmd =
        `set -e; cd ${remoteProj}; ` +
        `if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --silent; else npm install --no-audit --no-fund --silent; fi; ` +
        `npx --yes remotion render${entry} ${q(comp)} ${remoteOut} --codec=h264 --log=error`;
    }

    // DETACHED dispatch: fire the render on the node, release the SSH channel,
    // and poll for the exit-code marker. Individual SSH calls stay well under the
    // sshd exec ceiling; total render time is bounded only by the wall-clock
    // budget in the runner. Durable stdout/stderr are read back from files, so a
    // torn streaming pipe can no longer be mistaken for a render failure.
    const render = await runDetachedOnRenderNode({
      machineRef: machine,
      command: renderCmd,
      label: `render:${opts.engine}`,
      agentId: opts.agentId ?? null, agentName: opts.agentName,
      sessionId: opts.sessionId ?? null, runId: opts.runId ?? null,
    });
    const renderMs = Date.now() - started;
    if (!render.ok) {
      await ssh(`rm -rf ${jobDir}`, opts, 30_000).catch(() => undefined);
      await cleanupLocal();
      const tail = (render.stderr || render.stdout || render.error || '').slice(-800);
      const reason = render.timedOut
        ? `render exceeded the wall-clock budget on ${machine} (raise RENDER_NODE_MAX_WAIT_MS if this is legitimate)`
        : `render failed on ${machine}`;
      return { ...base, renderMs, error: reason, stdoutTail: tail };
    }
    const framesM = /FRAMES=(\d+)/.exec(render.stdout);
    const frames = framesM ? parseInt(framesM[1], 10) : undefined;

    // ── pull the MP4 back ───────────────────────────────────────────────────
    const down = await sshDownload({
      machineRef: machine, remotePath: absOut, localPath: localOut,
      agentId: opts.agentId ?? null, agentName: opts.agentName,
      sessionId: opts.sessionId ?? 'render-forge', runId: opts.runId ?? null, operator: true,
    });
    // clean up the remote job dir regardless of what happens next
    await ssh(`rm -rf ${jobDir}`, opts, 30_000).catch(() => undefined);
    await cleanupLocal();
    if (!down.ok) return { ...base, renderMs, frames, error: `render succeeded but pull-back failed: ${down.error}` };

    // ── auto-land in the Media gallery ──────────────────────────────────────
    let mediaId: string | undefined;
    let playbackNote: string | undefined;
    if (opts.register !== false) {
      try {
        const item = await registerLocalMedia(localOut, {
          kind: 'video', mimeType: 'video/mp4',
          title: opts.title || path.basename(opts.projectPath),
          prompt: `render_remote:${opts.engine}`,
          sourceTool: `render_remote:${opts.engine}`,
          author: opts.agentName, agentId: opts.agentId ?? null, sessionId: opts.sessionId ?? null,
        });
        mediaId = item.id;
        playbackNote = 'Landed in Studio › Media';
      } catch (err) {
        playbackNote = `render OK but gallery registration failed: ${(err as Error).message}`;
        logger.warn('render-forge: media registration failed', { err: (err as Error).message });
      }
    }

    logger.info('render-forge: render complete', { engine: opts.engine, machine, renderMs, frames, mediaId });
    return { ok: true, engine: opts.engine, machine, localPath: localOut, mediaId, playbackNote, frames, renderMs, stdoutTail: render.stdout.slice(-400) };
  } catch (err) {
    await ssh(`rm -rf ${jobDir}`, opts, 30_000).catch(() => undefined);
    await cleanupLocal();
    return { ...base, error: (err as Error).message };
  }
}
