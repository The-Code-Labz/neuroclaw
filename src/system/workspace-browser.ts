// Workspace introspection — read-only browsing of the agent workspace sandbox.
//
// Agents write their file output into `<WORKSPACE_ROOT>/<sessionId>/<agentId>/`
// (see workspace.ts). When a mid-task error swallows the chat reply, the *files*
// the agent produced still land there — this module lets the dashboard show them
// so work is never invisible. Read-only: list workspaces → list files → read one
// file. Ported from Agent OS's `*Workspace.ts` pattern, adapted to our 2-level
// (session/agent) scoping instead of their flat scratch/brain roots.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { workspaceRoot } from './workspace';

export type WsFileKind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'binary';

export interface WsEntry {
  session: string;
  agent: string;
  root: string;
  mtime: number;
  fileCount: number;
}
export interface WsFile {
  name: string;
  relPath: string;
  bytes: number;
  mtime: number;
  isText: boolean;
  kind: WsFileKind;
}

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.html', '.htm',
  '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.log', '.csv', '.tsv',
  '.xml', '.toml', '.env', '.svg', '.rs', '.go', '.rb', '.java', '.c', '.cpp', '.h',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', 'dist', 'build']);

const MAX_READ = 1_000_000; // 1 MB inline text cap

export function fileKind(name: string): WsFileKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}

/** Strict path-segment validation for read requests — REJECTS (does not
 *  transform) anything unsafe, including `.`/`..`, so a crafted session/agent id
 *  can never escape the workspace root. */
function isSafeSegment(seg: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(seg) && seg !== '.' && seg !== '..';
}

async function safeStat(p: string) {
  try { return await stat(p); } catch { return null; }
}

async function countFiles(dir: string, depth = 4): Promise<number> {
  if (depth < 0) return 0;
  let n = 0;
  try {
    const items = await readdir(dir, { withFileTypes: true });
    for (const it of items) {
      if (SKIP_DIRS.has(it.name)) continue;
      const full = path.join(dir, it.name);
      if (it.isFile()) n++;
      else if (it.isDirectory()) n += await countFiles(full, depth - 1);
    }
  } catch { /* ignore */ }
  return n;
}

/** List every (session, agent) scoped workspace that holds at least one file,
 *  newest first. Skips empty dirs and reserved inbound-upload buckets. */
export async function listWorkspaces(maxEntries = 200): Promise<WsEntry[]> {
  const root = workspaceRoot();
  if (!existsSync(root)) return [];
  const out: WsEntry[] = [];
  let sessions: import('node:fs').Dirent[];
  try { sessions = await readdir(root, { withFileTypes: true }); }
  catch { return []; }

  for (const ses of sessions) {
    if (out.length >= maxEntries) break;
    if (!ses.isDirectory()) continue;
    const sesDir = path.join(root, ses.name);
    let agents: import('node:fs').Dirent[];
    try { agents = await readdir(sesDir, { withFileTypes: true }); }
    catch { continue; }
    for (const ag of agents) {
      if (out.length >= maxEntries) break;
      if (!ag.isDirectory()) continue;
      if (ag.name === '_uploads') continue; // inbound uploads, not agent output
      const agDir = path.join(sesDir, ag.name);
      const st = await safeStat(agDir);
      if (!st) continue;
      const fileCount = await countFiles(agDir);
      if (fileCount === 0) continue; // nothing to show
      out.push({ session: ses.name, agent: ag.name, root: agDir, mtime: st.mtimeMs, fileCount });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Resolve a validated scoped root for (session, agent), or null if unsafe/missing. */
function scopedRoot(session: string, agent: string): string | null {
  if (!isSafeSegment(session) || !isSafeSegment(agent)) return null;
  const dir = path.join(workspaceRoot(), session, agent);
  if (!existsSync(dir)) return null;
  return dir;
}

/** List the files in one scoped workspace (recursive, capped, newest first). */
export async function listWorkspaceFiles(
  session: string, agent: string, maxFiles = 200,
): Promise<{ root: string; files: WsFile[] } | null> {
  const wsRoot = scopedRoot(session, agent);
  if (!wsRoot) return null;
  const rootDir: string = wsRoot; // typed non-null for closure capture

  const out: WsFile[] = [];
  async function walk(dir: string, depth: number) {
    if (out.length >= maxFiles || depth > 5) return;
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const it of items) {
      if (out.length >= maxFiles) break;
      if (SKIP_DIRS.has(it.name)) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(full, depth + 1);
      } else if (it.isFile()) {
        const st = await safeStat(full);
        if (!st) continue;
        const kind = fileKind(it.name);
        out.push({
          name: it.name,
          relPath: path.relative(rootDir, full),
          bytes: st.size,
          mtime: st.mtimeMs,
          isText: kind === 'text',
          kind,
        });
      }
    }
  }
  await walk(rootDir, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return { root: rootDir, files: out };
}

/** Resolve a file path inside a scoped workspace, guarding against traversal.
 *  Returns the absolute path or null if unsafe/missing. */
export function resolveWorkspaceFile(session: string, agent: string, relPath: string): string | null {
  const wsRoot = scopedRoot(session, agent);
  if (!wsRoot) return null;
  const abs = path.resolve(wsRoot, relPath);
  if (abs !== wsRoot && !abs.startsWith(wsRoot + path.sep)) return null; // escaped the root
  return abs;
}

/** Read one text file from a scoped workspace (1 MB cap, traversal-guarded). */
export async function readWorkspaceFile(
  session: string, agent: string, relPath: string,
): Promise<{ path: string; content: string; bytes: number; mtime: number; truncated: boolean; kind: WsFileKind } | null> {
  const abs = resolveWorkspaceFile(session, agent, relPath);
  if (!abs) return null;
  const st = await safeStat(abs);
  if (!st || !st.isFile()) return null;
  const truncated = st.size > MAX_READ;
  const buf = await readFile(abs);
  const trimmed = truncated ? buf.subarray(0, MAX_READ) : buf;
  return {
    path: relPath,
    content: trimmed.toString('utf8'),
    bytes: st.size,
    mtime: st.mtimeMs,
    truncated,
    kind: fileKind(abs),
  };
}
