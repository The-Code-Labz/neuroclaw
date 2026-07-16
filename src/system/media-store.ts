// Media gallery store (agent_media) — Studio › Media.
//
// PURPOSE: give the human one place to watch/hear every piece of media the
// agents generate (images, video, audio), and keep the bytes off the app box.
// The bytes live in Cloudflare R2 (S3-compatible object storage); this module
// is the single CRUD + object-storage surface used by BOTH the dashboard API
// routes and the register_media tool.
//
// CREDENTIALS: resolved from the broker at boot into process.env
// (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME).
// The S3 endpoint is DERIVED from the account id — no endpoint secret needed.
// All values are re-trimmed here defensively (the bucket name was pasted with a
// trailing newline, which yields InvalidBucketName if not stripped).
//
// PLAYBACK: nothing in R2 is public. The gallery streams via short-lived
// presigned GET URLs derived from object_key on each list, so a leaked list
// response expires quickly and the bucket stays private.

import { randomUUID } from 'crypto';
import {
  S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDb } from '../db';
import { logger } from '../utils/logger';

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaRow {
  id: string;
  kind: MediaKind;
  title: string;
  prompt: string;
  object_key: string;
  mime_type: string;
  size: number;
  source_tool: string;
  author: string;
  agent_id: string | null;
  session_id: string | null;
  archived: number;
  created_at: string;
}

// List/detail shape enriched with a ready-to-use presigned playback URL.
export interface MediaItem extends Omit<MediaRow, 'object_key'> {
  url: string;
}

const PRESIGN_TTL_SECONDS = 60 * 60; // 1h — long enough for a viewing session
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const env = (k: string) => (process.env[k] ?? '').trim();

/** True once all four R2 creds are present (broker-injected at boot). */
export function mediaEnabled(): boolean {
  return !!(env('R2_ACCOUNT_ID') && env('R2_ACCESS_KEY_ID') && env('R2_SECRET_ACCESS_KEY') && env('R2_BUCKET_NAME'));
}

export function mediaBucket(): string {
  return env('R2_BUCKET_NAME');
}

let _client: S3Client | null = null;
let _clientKey = '';

/** Lazily build (and cache) the R2 S3 client from the current env creds. */
function s3(): S3Client {
  if (!mediaEnabled()) throw new Error('media storage not configured (R2 creds missing)');
  const accountId = env('R2_ACCOUNT_ID');
  const accessKeyId = env('R2_ACCESS_KEY_ID');
  const secretAccessKey = env('R2_SECRET_ACCESS_KEY');
  const key = `${accountId}:${accessKeyId}`;
  if (_client && _clientKey === key) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  _clientKey = key;
  return _client;
}

/** Drop the cached client (call after broker rotation of R2 creds). */
export function resetMediaClient(): void { _client = null; _clientKey = ''; }

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/mp4': 'm4a',
};

function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'image';
}

/** Presign a playback (inline) URL for an object key. */
async function presignGet(objectKey: string, opts?: { downloadName?: string }): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: mediaBucket(),
    Key: objectKey,
    ...(opts?.downloadName
      ? { ResponseContentDisposition: `attachment; filename="${opts.downloadName.replace(/"/g, '')}"` }
      : {}),
  });
  return getSignedUrl(s3(), cmd, { expiresIn: PRESIGN_TTL_SECONDS });
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function rowById(id: string): MediaRow | null {
  const db = getDb();
  const r = db.prepare('SELECT * FROM agent_media WHERE id = ?').get(id) as MediaRow | undefined;
  return r ?? null;
}

async function toItem(r: MediaRow): Promise<MediaItem> {
  const { object_key, ...rest } = r;
  let url = '';
  try { url = await presignGet(object_key); }
  catch (err) { logger.warn('media-store: presign failed', { id: r.id, err: (err as Error).message }); }
  return { ...rest, url };
}

/** List media (newest first), each enriched with a presigned playback URL. */
export async function listMedia(opts?: { kind?: MediaKind; includeArchived?: boolean; limit?: number }): Promise<MediaItem[]> {
  const db = getDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (!opts?.includeArchived) where.push('archived = 0');
  if (opts?.kind) { where.push('kind = ?'); args.push(opts.kind); }
  const sql = `SELECT * FROM agent_media ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT ?`;
  args.push(Math.min(Math.max(opts?.limit ?? 300, 1), 1000));
  const rows = db.prepare(sql).all(...args) as MediaRow[];
  return Promise.all(rows.map(toItem));
}

/** Fetch a single item (with presigned URL) by id. */
export async function getMediaItem(id: string): Promise<MediaItem | null> {
  const r = rowById(id);
  return r ? toItem(r) : null;
}

/** Presigned DOWNLOAD url (forces attachment). Null if the row is missing. */
export async function presignDownload(id: string): Promise<string | null> {
  const r = rowById(id);
  if (!r) return null;
  const ext = EXT_BY_MIME[r.mime_type] ?? 'bin';
  const base = (r.title || r.id).replace(/[^\w.-]+/g, '_').slice(0, 80);
  return presignGet(r.object_key, { downloadName: `${base}.${ext}` });
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export interface RegisterInput {
  kind?: MediaKind;
  title?: string;
  prompt?: string;
  mimeType?: string;
  sourceTool?: string;
  author?: string;
  agentId?: string | null;
  sessionId?: string | null;
}

/** Put raw bytes into R2 and index them. The core ingest primitive. */
export async function uploadMedia(bytes: Buffer, input: RegisterInput): Promise<MediaItem> {
  if (!mediaEnabled()) throw new Error('media storage not configured (R2 creds missing)');
  const mime = (input.mimeType || 'application/octet-stream').trim();
  const kind = input.kind ?? kindFromMime(mime);
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  const id = randomUUID();
  const objectKey = `media/${kind}/${id}.${ext}`;

  await s3().send(new PutObjectCommand({
    Bucket: mediaBucket(), Key: objectKey, Body: bytes, ContentType: mime,
  }));

  const db = getDb();
  db.prepare(
    `INSERT INTO agent_media
       (id, kind, title, prompt, object_key, mime_type, size, source_tool, author, agent_id, session_id, archived, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    id, kind, (input.title ?? '').slice(0, 300), (input.prompt ?? '').slice(0, 4000),
    objectKey, mime, bytes.length, (input.sourceTool ?? '').slice(0, 120),
    (input.author ?? 'agent').slice(0, 120), input.agentId ?? null, input.sessionId ?? null, nowIso(),
  );
  logger.info('media-store: uploaded', { id, kind, mime, bytes: bytes.length, source: input.sourceTool });
  return (await getMediaItem(id))!;
}

/** Fetch a remote URL (e.g. a generated image link) and register the bytes. */
export async function registerMediaFromUrl(url: string, input: RegisterInput): Promise<MediaItem> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch media source failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = input.mimeType || res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return uploadMedia(buf, { ...input, mimeType: mime });
}

/** Register from a base64/data-URL payload. */
export async function registerMediaFromBase64(b64: string, input: RegisterInput): Promise<MediaItem> {
  let data = b64.trim();
  let mime = input.mimeType;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(data);
  if (m) { mime = mime || m[1]; data = m[2]; }
  const buf = Buffer.from(data, 'base64');
  return uploadMedia(buf, { ...input, mimeType: mime });
}

const EXT_MIME: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
};

/**
 * Register a file already on the app-box filesystem (e.g. an MP4 the render
 * forge just pulled back from the node). Reads the bytes and uploads them to R2.
 * This is the hook the render dispatch calls so every render auto-lands in the
 * gallery. MIME is inferred from the extension unless overridden.
 */
export async function registerLocalMedia(filePath: string, input: RegisterInput = {}): Promise<MediaItem> {
  const { readFile } = await import('fs/promises');
  const buf = await readFile(filePath);
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const mime = input.mimeType || EXT_MIME[ext] || 'application/octet-stream';
  const title = input.title || filePath.split('/').pop() || 'render';
  return uploadMedia(buf, { ...input, mimeType: mime, title });
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function setArchived(id: string, archived: boolean): Promise<MediaItem | null> {
  const r = rowById(id);
  if (!r) return null;
  getDb().prepare('UPDATE agent_media SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  return getMediaItem(id);
}

/**
 * Delete media. Removes the R2 object FIRST, then the DB row — so a failed
 * object delete leaves the row intact rather than orphaning billable bytes
 * behind a phantom "gone from the list" state. Returns { ok, error? }.
 */
export async function deleteMedia(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = rowById(id);
  if (!r) return { ok: false, error: 'not found' };
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: mediaBucket(), Key: r.object_key }));
  } catch (err) {
    logger.warn('media-store: R2 object delete failed — keeping row', { id, err: (err as Error).message });
    return { ok: false, error: `object delete failed: ${(err as Error).message}` };
  }
  getDb().prepare('DELETE FROM agent_media WHERE id = ?').run(id);
  logger.info('media-store: deleted', { id });
  return { ok: true };
}
