// NeuroArchive — long-term reusable asset store (MinIO).
//
// PURPOSE: a durable library for deliberately reusable assets — b-roll, reference
// footage, brand assets, reusable image sets, code snippets/templates — separate
// from the ephemeral Media gallery (R2 / agent_media). Nothing here auto-expires;
// bucket versioning is the overwrite/delete safety net.
//
// CREDENTIALS: resolved from the broker at boot into process.env
// (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET_NAME).
// MinIO requires forcePathStyle:true unless a wildcard DNS/virtual-host setup
// exists; this deployment uses path-style addressing.
//
// ACCESS: objects are private. Presigned GET URLs (6h TTL) are derived on demand.
// Local byte fetches write to a persistent scratch path so agents/tools that need
// actual files (video composition, code-gen templates) can consume them directly.

import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import {
  S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDb } from '../db';
import { logger } from '../utils/logger';
import { workspaceRoot } from './workspace';

export type ArchiveCategory = 'video' | 'image' | 'audio' | 'broll' | 'code' | 'document' | 'other';

export interface ArchiveRow {
  id: string;
  category: ArchiveCategory;
  title: string;
  description: string;
  tags: string; // JSON array string
  object_key: string;
  mime_type: string;
  size: number;
  checksum_sha256: string;
  source_tool: string;
  author: string;
  agent_id: string | null;
  session_id: string | null;
  pinned: number;
  archived: number;
  created_at: string;
  last_used_at: string | null;
}

// List/detail shape enriched with a ready-to-use presigned URL.
export interface ArchiveItem extends Omit<ArchiveRow, 'object_key' | 'tags'> {
  tags: string[];
  url: string;
}

const PRESIGN_TTL_SECONDS = 6 * 60 * 60; // 6h — long enough for workflow pulls
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const env = (k: string) => (process.env[k] ?? '').trim();

/** True once all four MinIO creds are present (broker-injected at boot). */
export function archiveEnabled(): boolean {
  return !!(env('MINIO_ENDPOINT') && env('MINIO_ACCESS_KEY') && env('MINIO_SECRET_KEY') && env('MINIO_BUCKET_NAME'));
}

export function archiveBucket(): string {
  return env('MINIO_BUCKET_NAME');
}

let _client: S3Client | null = null;
let _clientKey = '';

/** Lazily build (and cache) the MinIO S3 client from the current env creds. */
function s3(): S3Client {
  if (!archiveEnabled()) throw new Error('archive storage not configured (MINIO creds missing)');
  const endpoint = env('MINIO_ENDPOINT');
  const accessKeyId = env('MINIO_ACCESS_KEY');
  const secretAccessKey = env('MINIO_SECRET_KEY');
  const key = `${endpoint}:${accessKeyId}`;
  if (_client && _clientKey === key) return _client;
  _client = new S3Client({
    region: 'us-east-1', // MinIO ignores region but the SDK requires one
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // REQUIRED for MinIO unless virtual-host DNS is configured
  });
  _clientKey = key;
  return _client;
}

/** Drop the cached client (call after broker rotation of MinIO creds). */
export function resetArchiveClient(): void { _client = null; _clientKey = ''; }

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/flac': 'flac',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html', 'text/css': 'css',
  'application/json': 'json', 'application/javascript': 'js', 'text/javascript': 'js',
  'application/typescript': 'ts', 'text/typescript': 'ts', 'application/pdf': 'pdf',
  'application/zip': 'zip', 'application/octet-stream': 'bin',
};

function extFromMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'bin';
}

function categoryFromMime(mime: string): ArchiveCategory {
  const lower = mime.toLowerCase();
  if (lower.startsWith('video/')) return 'video';
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower === 'text/plain' || lower === 'text/markdown' || lower.startsWith('text/')) return 'document';
  if (lower === 'application/json' || lower === 'application/javascript' || lower.startsWith('text/')) return 'code';
  return 'other';
}

/** Presign a GET URL for an object key. */
async function presignGet(objectKey: string, opts?: { downloadName?: string }): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: archiveBucket(),
    Key: objectKey,
    ...(opts?.downloadName
      ? { ResponseContentDisposition: `attachment; filename="${opts.downloadName.replace(/"/g, '')}"` }
      : {}),
  });
  return getSignedUrl(s3(), cmd, { expiresIn: PRESIGN_TTL_SECONDS });
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function rowById(id: string): ArchiveRow | null {
  const db = getDb();
  const r = db.prepare('SELECT * FROM archive_items WHERE id = ?').get(id) as ArchiveRow | undefined;
  return r ?? null;
}

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch { /* fall through */ }
  return [];
}

async function toItem(r: ArchiveRow): Promise<ArchiveItem> {
  const { object_key, tags, ...rest } = r;
  let url = '';
  try { url = await presignGet(object_key); }
  catch (err) { logger.warn('archive-store: presign failed', { id: r.id, err: (err as Error).message }); }
  return { ...rest, tags: parseTags(tags), url };
}

export interface ListArchiveOpts {
  category?: ArchiveCategory;
  tag?: string;
  includeArchived?: boolean;
  pinnedFirst?: boolean;
  limit?: number;
}

/** List archive items, optionally filtered. Default: non-archived, newest first. */
export async function listArchive(opts: ListArchiveOpts = {}): Promise<ArchiveItem[]> {
  const db = getDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (!opts.includeArchived) { where.push('archived = 0'); }
  if (opts.category) { where.push('category = ?'); args.push(opts.category); }
  if (opts.tag?.trim()) { where.push('tags LIKE ?'); args.push(`%"${opts.tag.trim()}"%`); }

  const orderBy = opts.pinnedFirst ? 'pinned DESC, created_at DESC' : 'created_at DESC';
  const sql = `SELECT * FROM archive_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy} LIMIT ?`;
  args.push(Math.min(Math.max(opts.limit ?? 300, 1), 1000));

  const rows = db.prepare(sql).all(...args) as ArchiveRow[];
  return Promise.all(rows.map(toItem));
}

/** Simple substring/tag search across title, description, and tags. */
export async function searchArchive(query: string, opts?: { category?: ArchiveCategory; limit?: number }): Promise<ArchiveItem[]> {
  const db = getDb();
  const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
  const where: string[] = ['archived = 0'];
  const args: unknown[] = [];
  where.push('(title LIKE ? OR description LIKE ? OR tags LIKE ?)');
  args.push(like, like, like);
  if (opts?.category) { where.push('category = ?'); args.push(opts.category); }

  const sql = `SELECT * FROM archive_items WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC LIMIT ?`;
  args.push(Math.min(Math.max(opts?.limit ?? 100, 1), 1000));

  const rows = db.prepare(sql).all(...args) as ArchiveRow[];
  return Promise.all(rows.map(toItem));
}

/** Fetch a single archive item (with presigned URL) by id. */
export async function getArchiveItem(id: string): Promise<ArchiveItem | null> {
  const r = rowById(id);
  if (!r) return null;
  bumpLastUsed(id);
  return toItem(r);
}

/** Presigned download URL (forces attachment). Null if the row is missing. */
export async function presignArchiveDownload(id: string): Promise<string | null> {
  const r = rowById(id);
  if (!r) return null;
  bumpLastUsed(id);
  const ext = extFromMime(r.mime_type);
  const base = (r.title || r.id).replace(/[^\w.-]+/g, '_').slice(0, 80);
  return presignGet(r.object_key, { downloadName: `${base}.${ext}` });
}

/** Update last_used_at whenever an item is fetched/downloaded. */
export function bumpLastUsed(id: string): void {
  try {
    getDb().prepare('UPDATE archive_items SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
  } catch (err) {
    logger.warn('archive-store: bumpLastUsed failed', { id, err: (err as Error).message });
  }
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export interface RegisterArchiveInput {
  category?: ArchiveCategory;
  title?: string;
  description?: string;
  tags?: string[];
  mimeType?: string;
  sourceTool?: string;
  author?: string;
  agentId?: string | null;
  sessionId?: string | null;
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  return tags.map(t => t.trim()).filter(Boolean).slice(0, 50);
}

function validCategory(cat?: string): ArchiveCategory {
  const allowed: ArchiveCategory[] = ['video', 'image', 'audio', 'broll', 'code', 'document', 'other'];
  return allowed.includes(cat as ArchiveCategory) ? (cat as ArchiveCategory) : 'other';
}

/** Put raw bytes into MinIO and index them. The core ingest primitive. */
export async function uploadArchiveItem(bytes: Buffer, input: RegisterArchiveInput): Promise<ArchiveItem> {
  if (!archiveEnabled()) throw new Error('archive storage not configured (MINIO creds missing)');
  const mime = (input.mimeType || 'application/octet-stream').trim();
  const category = input.category ? validCategory(input.category) : categoryFromMime(mime);
  const ext = extFromMime(mime);
  const id = randomUUID();
  const objectKey = `archive/${category}/${id}.${ext}`;
  const checksum = createHash('sha256').update(bytes).digest('hex');

  await s3().send(new PutObjectCommand({
    Bucket: archiveBucket(), Key: objectKey, Body: bytes, ContentType: mime,
  }));

  const tags = normalizeTags(input.tags);
  const db = getDb();
  db.prepare(
    `INSERT INTO archive_items
       (id, category, title, description, tags, object_key, mime_type, size, checksum_sha256,
        source_tool, author, agent_id, session_id, pinned, archived, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL)`
  ).run(
    id, category, (input.title ?? '').slice(0, 300), (input.description ?? '').slice(0, 4000),
    JSON.stringify(tags), objectKey, mime, bytes.length, checksum,
    (input.sourceTool ?? '').slice(0, 120), (input.author ?? 'agent').slice(0, 120),
    input.agentId ?? null, input.sessionId ?? null, nowIso(),
  );
  logger.info('archive-store: uploaded', { id, category, mime, bytes: bytes.length, source: input.sourceTool });
  return (await getArchiveItem(id))!;
}

/** Fetch a remote URL and archive the bytes. */
export async function registerArchiveFromUrl(url: string, input: RegisterArchiveInput): Promise<ArchiveItem> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch archive source failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = input.mimeType || res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return uploadArchiveItem(buf, { ...input, mimeType: mime });
}

/** Archive from a base64/data-URL payload. */
export async function registerArchiveFromBase64(b64: string, input: RegisterArchiveInput): Promise<ArchiveItem> {
  let data = b64.trim();
  let mime = input.mimeType;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(data);
  if (m) { mime = mime || m[1]; data = m[2]; }
  const buf = Buffer.from(data, 'base64');
  return uploadArchiveItem(buf, { ...input, mimeType: mime });
}

/** Archive a file already on the app-box filesystem. */
export async function registerLocalArchive(filePath: string, input: RegisterArchiveInput = {}): Promise<ArchiveItem> {
  const buf = await fsp.readFile(filePath);
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const mime = input.mimeType || EXT_MIME[ext] || 'application/octet-stream';
  const title = input.title || filePath.split('/').pop() || 'archive';
  return uploadArchiveItem(buf, { ...input, mimeType: mime, title });
}

const EXT_MIME: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  md: 'text/markdown', txt: 'text/plain', html: 'text/html', css: 'text/css',
  json: 'application/json', js: 'application/javascript', ts: 'application/typescript',
  pdf: 'application/pdf', zip: 'application/zip',
};

// ── Local byte fetch ─────────────────────────────────────────────────────────

/** Download an archive object to a persistent local scratch path. Returns the absolute path. */
export async function fetchArchiveBytes(id: string, opts?: { sessionId?: string | null; destPath?: string }): Promise<{ path: string; size: number; checksum: string }> {
  const r = rowById(id);
  if (!r) throw new Error('archive item not found');
  if (r.archived !== 0) throw new Error('archive item is soft-deleted');

  const dest = opts?.destPath ?? defaultFetchPath(id, r.mime_type, opts?.sessionId);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const res = await s3().send(new GetObjectCommand({ Bucket: archiveBucket(), Key: r.object_key }));
  if (!res.Body) throw new Error('empty response body from MinIO');

  const tmpPath = `${dest}.tmp.${Date.now()}`;
  const writeStream = fs.createWriteStream(tmpPath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pipeline(res.Body as any, writeStream);
  await fsp.rename(tmpPath, dest);

  bumpLastUsed(id);
  const stats = await fsp.stat(dest);
  logger.info('archive-store: fetched bytes', { id, path: dest, bytes: stats.size });
  return { path: dest, size: stats.size, checksum: r.checksum_sha256 };
}

function defaultFetchPath(id: string, mime: string, sessionId?: string | null): string {
  const ext = extFromMime(mime);
  const safeSession = sessionId ? sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 128) : '_shared';
  return path.join(workspaceRoot(), '_shared', 'archive-fetch', safeSession, `${id}.${ext}`);
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function setArchivePinned(id: string, pinned: boolean): Promise<ArchiveItem | null> {
  const r = rowById(id);
  if (!r) return null;
  getDb().prepare('UPDATE archive_items SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  return getArchiveItem(id);
}

export async function setArchiveArchived(id: string, archived: boolean): Promise<ArchiveItem | null> {
  const r = rowById(id);
  if (!r) return null;
  getDb().prepare('UPDATE archive_items SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  return getArchiveItem(id);
}

/**
 * Delete an archive item. Soft-delete (archived=1) by default.
 * With permanent=true, deletes the MinIO object FIRST, then the DB row — so a
 * failed object delete leaves the row intact rather than orphaning bytes.
 */
export async function deleteArchiveItem(id: string, permanent = false): Promise<{ ok: boolean; error?: string }> {
  const r = rowById(id);
  if (!r) return { ok: false, error: 'not found' };

  if (!permanent) {
    getDb().prepare('UPDATE archive_items SET archived = 1 WHERE id = ?').run(id);
    logger.info('archive-store: soft-deleted', { id });
    return { ok: true };
  }

  try {
    await s3().send(new DeleteObjectCommand({ Bucket: archiveBucket(), Key: r.object_key }));
  } catch (err) {
    logger.warn('archive-store: MinIO object delete failed — keeping row', { id, err: (err as Error).message });
    return { ok: false, error: `object delete failed: ${(err as Error).message}` };
  }
  getDb().prepare('DELETE FROM archive_items WHERE id = ?').run(id);
  logger.info('archive-store: permanently deleted', { id });
  return { ok: true };
}
