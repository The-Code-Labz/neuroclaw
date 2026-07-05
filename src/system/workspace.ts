// Per-agent workspace scoping.
//
// Single source of truth for where an agent's file output lands. We relocate the
// *default home* of the in-process exec tools (bash_run, fs_*, run_skill_script,
// broker /exec) from the repo root into a scoped, ephemeral directory keyed by
// session + agent: `<WORKSPACE_ROOT>/<sessionId>/<agentId>/`.
//
// This is workspace SCOPING, not OS/container isolation. The `EXEC_ROOT`
// boundary (checkFsBoundary) still governs what an agent may touch; here we only
// change where relative paths and the default cwd resolve to, so generated files
// stop crowding the repo root and storage stays organized + sweepable. Agents
// can still READ the repo via absolute paths (shared-read model).
//
// Design spec: docs/superpowers/specs/2026-06-02-agent-workspace-scoping-design.md

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getSessionById, deleteSessionUploadsBySession } from '../db';

/** Restrict an id to a safe path segment. Prevents `../` traversal and unsafe
 *  characters via crafted session/agent ids. Empty → the supplied fallback. */
export function sanitizeId(id: string | null | undefined, fallback: string): string {
  const raw = (id ?? '').trim();
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')  // collapse anything unsafe
    .replace(/^[.]+/, '_')              // never a leading-dot segment ('.', '..')
    .slice(0, 128);
  return safe || fallback;
}

/** Absolute workspace root (`./workspaces` by default), resolved against cwd. */
export function workspaceRoot(): string {
  return path.resolve(config.workspace.root);
}

// Persistent sandbox buckets — direct children of the workspace root that the
// orphan/TTL sweep NEVER reaps. `_shared` is the sessionless scratch bucket (was
// already orphan-exempt; now TTL-exempt too, matching its documented "persistent
// scratch" intent). `_persistent` is an explicit home for long-lived files that
// live in the agent sandbox by design (e.g. relocated out of the repo root).
// Both survive restarts and the 5-minute cleanup tick. See persistentDir().
const PERSISTENT_BUCKETS = new Set(['_shared', '_persistent']);

/** Absolute path to a persistent sandbox bucket that the sweep never reaps,
 *  optionally a sanitized sub-path within it. Created on demand; mirrors the
 *  resolveWorkspace fallbacks (tmpdir on mkdir failure). Defaults to the
 *  `_persistent` bucket. */
export function persistentDir(sub?: string): string {
  const leaf = sub ? sanitizeId(sub, 'misc') : '';
  const dir = path.join(workspaceRoot(), '_persistent', leaf);
  if (tryMkdir(dir)) return dir;
  const tmp = path.join(os.tmpdir(), 'neuroclaw-workspaces', '_persistent', leaf);
  if (tryMkdir(tmp)) return tmp;
  return os.tmpdir();
}

function tryMkdir(dir: string): boolean {
  try { fs.mkdirSync(dir, { recursive: true }); return true; }
  catch (err) {
    logger.warn('workspace: mkdir failed', { dir, error: (err as Error).message });
    return false;
  }
}

/**
 * Resolve the scoped working directory for (session, agent), creating it on
 * demand. NEVER returns the repo root:
 *   - missing sessionId → the `_shared` session bucket
 *   - missing agentId   → the `_system` agent bucket
 *   - mkdir failure     → an os.tmpdir()-based workspace (last resort: tmpdir)
 */
export function resolveWorkspace(
  sessionId: string | null | undefined,
  agentId: string | null | undefined,
): string {
  const ses   = sanitizeId(sessionId, '_shared');
  const agent = sanitizeId(agentId, '_system');
  const dir   = path.join(workspaceRoot(), ses, agent);
  if (tryMkdir(dir)) return dir;

  // Fallback: a tmpdir-based workspace. Still scoped, still never the repo root.
  const tmp = path.join(os.tmpdir(), 'neuroclaw-workspaces', ses, agent);
  if (tryMkdir(tmp)) return tmp;
  return os.tmpdir();
}

/** Inject the resolved workspace dir into a child-process env so scripts can
 *  reference it explicitly (e.g. write to `$WORKSPACE_DIR/out.png`). */
export function workspaceEnv(dir: string): Record<string, string> {
  return { WORKSPACE_DIR: dir };
}

/** Session-shared inbound-uploads dir: `<root>/<sessionId>/_uploads/`. Created on
 *  demand; never the repo root (same fallbacks as resolveWorkspace). `_uploads`
 *  is a reserved session segment — real agent ids are UUIDs and never collide. */
export function sessionUploadsDir(sessionId: string | null | undefined): string {
  const ses = sanitizeId(sessionId, '_shared');
  const dir = path.join(workspaceRoot(), ses, '_uploads');
  if (tryMkdir(dir)) return dir;
  const tmp = path.join(os.tmpdir(), 'neuroclaw-workspaces', ses, '_uploads');
  if (tryMkdir(tmp)) return tmp;
  return os.tmpdir();
}

// ── Cleanup / lifecycle ──────────────────────────────────────────────────────

/** Remove a single session's workspace subtree (all its agents). Best-effort. */
export async function cleanupSession(sessionId: string): Promise<void> {
  const ses = sanitizeId(sessionId, '');
  if (!ses || PERSISTENT_BUCKETS.has(ses)) return;  // never blow away a persistent bucket
  const dir = path.join(workspaceRoot(), ses);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    try { deleteSessionUploadsBySession(sessionId); } catch { /* non-fatal */ }
    logger.debug('workspace: cleaned session workspace', { sessionId, dir });
  } catch (err) {
    logger.warn('workspace: cleanupSession failed', { sessionId, error: (err as Error).message });
  }
}

/**
 * Remove session-workspace dirs whose session no longer exists in the DB, or
 * whose mtime exceeds the TTL. Persistent buckets (`_shared`, `_persistent`) are
 * never reaped — neither for "no session" nor by TTL. Capped per run; returns
 * the count removed.
 */
export async function sweepOrphans(opts?: { maxPerRun?: number }): Promise<number> {
  const root = workspaceRoot();
  const max  = opts?.maxPerRun ?? config.workspace.sweepMaxPerRun;
  const ttlMs = Math.max(0, config.workspace.ttlHours) * 60 * 60 * 1000;
  const cutoff = ttlMs > 0 ? Date.now() - ttlMs : 0;

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return 0;  // root doesn't exist yet — nothing to sweep
  }

  let removed = 0;
  for (const ent of entries) {
    if (removed >= max) break;
    if (!ent.isDirectory()) continue;
    if (PERSISTENT_BUCKETS.has(ent.name)) continue;  // never reap persistent buckets
    const sesDir = path.join(root, ent.name);

    let aged = false;
    if (cutoff > 0) {
      try { aged = (await fsp.stat(sesDir)).mtimeMs < cutoff; }
      catch { continue; }
    }

    const orphaned = !getSessionById(ent.name);

    if (orphaned || aged) {
      try {
        await fsp.rm(sesDir, { recursive: true, force: true });
        try { deleteSessionUploadsBySession(ent.name); } catch { /* non-fatal */ }
        removed++;
      } catch (err) {
        logger.warn('workspace: sweepOrphans rm failed', { dir: sesDir, error: (err as Error).message });
      }
    }
  }
  if (removed > 0) logger.info('workspace: swept orphaned/aged session workspaces', { removed });
  return removed;
}

// ── Uploads bounding ─────────────────────────────────────────────────────────
//
// Generated media in uploads/ (chat images, TTS audio, rendered PDFs, doc disk
// mirrors) is written directly by tools and is NOT row-tracked, so it grows
// unbounded. We age it out by mtime, capped per run. Deliverables and UI assets
// (agent-files/, avatars/, images/) are intentionally NEVER auto-deleted.

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const UPLOADS_SWEEP_CATEGORIES = ['chat', 'carbone_renders', 'docs'];

async function sweepDirByAge(dir: string, cutoff: number, budget: number): Promise<number> {
  let removed = 0;
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return 0; }

  for (const ent of entries) {
    if (removed >= budget) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      removed += await sweepDirByAge(full, cutoff, budget - removed);
      // Drop the directory if it's now empty.
      try {
        if ((await fsp.readdir(full)).length === 0) await fsp.rmdir(full);
      } catch { /* not empty / race — leave it */ }
      continue;
    }
    try {
      if ((await fsp.stat(full)).mtimeMs < cutoff) {
        await fsp.rm(full, { force: true });
        removed++;
      }
    } catch { /* vanished mid-sweep — fine */ }
  }
  return removed;
}

/** Age-based TTL sweep over the ephemeral uploads categories. Returns files removed. */
export async function sweepUploads(opts?: { maxPerRun?: number }): Promise<number> {
  if (!config.workspace.uploadsSweepEnabled) return 0;
  const ttlMs = Math.max(0, config.workspace.uploadsTtlHours) * 60 * 60 * 1000;
  if (ttlMs <= 0) return 0;  // 0 = disabled
  const cutoff = Date.now() - ttlMs;
  const max = opts?.maxPerRun ?? config.workspace.sweepMaxPerRun;

  let removed = 0;
  for (const cat of UPLOADS_SWEEP_CATEGORIES) {
    if (removed >= max) break;
    removed += await sweepDirByAge(path.join(UPLOADS_ROOT, cat), cutoff, max - removed);
  }
  if (removed > 0) logger.info('workspace: swept aged uploads', { removed, ttlHours: config.workspace.uploadsTtlHours });
  return removed;
}
