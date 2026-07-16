// Agent-generated image archive.
//
// Every image a generation tool produces is pushed to the Supabase
// 'agent-images' PRIVATE bucket (durable, off-box) and indexed in the local
// SQLite `agent_images` table with its ORIGINAL prompt. The gallery reads that
// index and mints short-lived signed URLs on demand — the bucket is never
// public and the service key never leaves the backend.
//
// HARD CONTRACT: archiving is fire-and-forget and fully swallowed. It must
// NEVER throw into the image-delivery hot path — a failed archive still leaves
// the user with their image; it just doesn't show up in the gallery.

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { recordAgentImage, listAgentImages, countAgentImages, getAgentImage, type AgentImageRecord } from '../db';

const BUCKET = 'agent-images';
const MAX_BYTES = 25 * 1024 * 1024;

function storageBase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

function extFor(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif'))  return 'gif';
  return 'png';
}

export interface ArchiveInput {
  source:     string;          // generation tool name (e.g. 'voidai_image')
  prompt:     string;          // the ORIGINAL generation prompt
  alt:        string;
  caption:    string | null;
  base64:     string | null;   // preferred: raw bytes already in hand
  sourceUrl:  string | null;   // fallback: fetch an external http(s) URL
  mime:       string | null;
  agentId:    string | null;
  agentName:  string;
  sessionId:  string | null;
  runId:      string | null;
  model?:     string | null;   // the actual model used to generate the image, when known
}

/** Fire-and-forget: push bytes to Supabase + index metadata. Never throws. */
export async function archiveGeneratedImage(input: ArchiveInput): Promise<void> {
  try {
    if (process.env.IMAGE_ARCHIVE_ENABLED === 'false') return;
    const sb = storageBase();
    if (!sb) return;

    // 1. Resolve bytes — prefer the base64 we already have, else fetch a URL.
    let buf: Buffer | null = null;
    let mime = input.mime ?? 'image/png';
    if (input.base64 && input.base64.length > 0) {
      buf = Buffer.from(input.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    } else if (input.sourceUrl && /^https?:\/\//i.test(input.sourceUrl)) {
      const r = await fetch(input.sourceUrl);
      if (!r.ok) { logger.warn('image-archive: source fetch failed', { status: r.status, url: input.sourceUrl.slice(0, 120) }); return; }
      const ct = r.headers.get('content-type');
      if (ct && ct.startsWith('image/')) mime = ct;
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (!buf || buf.length === 0) return;              // local-path URL / no bytes → skip silently
    if (buf.length > MAX_BYTES) { logger.warn('image-archive: too large, skipped', { bytes: buf.length }); return; }

    // 2. Upload to the private Supabase bucket.
    const session     = (input.sessionId ?? 'orphan').replace(/[^a-zA-Z0-9._-]/g, '_');
    const id          = randomUUID();
    const storagePath = `${session}/${Date.now()}-${id}.${extFor(mime)}`;
    const up = await fetch(`${sb.url}/storage/v1/object/${BUCKET}/${storagePath}`, {
      method:  'POST',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': mime, 'x-upsert': 'true' },
      body:    new Uint8Array(buf),
    });
    if (!up.ok) { logger.warn('image-archive: upload failed', { status: up.status, body: (await up.text().catch(() => '')).slice(0, 200) }); return; }

    // 3. Index the metadata in SQLite.
    recordAgentImage({
      id, bucket: BUCKET, storage_path: storagePath,
      prompt:      (input.prompt ?? '').slice(0, 4000),
      alt:         (input.alt ?? '').slice(0, 1000),
      caption:     input.caption ? input.caption.slice(0, 1000) : null,
      source_tool: input.source,
      agent_id:    input.agentId,
      agent_name:  input.agentName,
      session_id:  input.sessionId,
      run_id:      input.runId,
      mime, bytes: buf.length,
      model:       input.model ?? null,
    });
    logger.info('image-archive: stored', { source: input.source, agent: input.agentName, storagePath, bytes: buf.length });
  } catch (err) {
    logger.warn('image-archive: failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }
}

export interface UploadInput {
  buf:       Buffer;
  mime:      string;
  filename:  string;           // original file name (folder path stripped upstream)
  prompt:    string;           // user description / note (defaults to the filename)
  agentName: string;           // attribution label, e.g. 'upload'
  sessionId: string | null;
}

/**
 * Archive a USER-uploaded image (single file or one file from a folder batch).
 * Unlike archiveGeneratedImage (fire-and-forget on the hot path), this is
 * awaited and returns a real result so the upload route can report per-file
 * success/failure to the browser.
 */
export async function archiveUploadedImage(input: UploadInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    if (process.env.IMAGE_ARCHIVE_ENABLED === 'false') return { ok: false, error: 'image archive disabled' };
    const sb = storageBase();
    if (!sb) return { ok: false, error: 'Supabase storage not configured' };

    const buf = input.buf;
    if (!buf || buf.length === 0) return { ok: false, error: 'empty file' };
    if (buf.length > MAX_BYTES)   return { ok: false, error: `too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB)` };

    const mime        = input.mime && input.mime.startsWith('image/') ? input.mime : 'image/png';
    const session     = (input.sessionId ?? 'uploads').replace(/[^a-zA-Z0-9._-]/g, '_');
    const id          = randomUUID();
    const storagePath = `${session}/${Date.now()}-${id}.${extFor(mime)}`;

    const up = await fetch(`${sb.url}/storage/v1/object/${BUCKET}/${storagePath}`, {
      method:  'POST',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': mime, 'x-upsert': 'true' },
      body:    new Uint8Array(buf),
    });
    if (!up.ok) return { ok: false, error: `upload failed (${up.status})` };

    recordAgentImage({
      id, bucket: BUCKET, storage_path: storagePath,
      prompt:      (input.prompt ?? '').slice(0, 4000),
      alt:         (input.filename ?? '').slice(0, 1000),
      caption:     null,
      source_tool: 'upload',
      agent_id:    null,
      agent_name:  input.agentName || 'upload',
      session_id:  input.sessionId,
      run_id:      null,
      mime, bytes: buf.length,
      model:       null,
    });
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch the raw bytes of a stored gallery image by id, for a forced download.
 * Pulls from the PRIVATE bucket with the service key (never exposed to the
 * browser) and derives a sensible download filename. Null on any failure.
 */
export async function fetchStoredImage(
  id: string,
): Promise<{ buf: Buffer; mime: string; filename: string } | null> {
  try {
    const rec = getAgentImage(id);
    if (!rec) return null;
    const sb = storageBase();
    if (!sb) return null;
    const r = await fetch(`${sb.url}/storage/v1/object/${rec.bucket}/${encodeURI(rec.storage_path)}`, {
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` },
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) return null;

    const ext = extFor(rec.mime);
    // Prefer the original upload filename (stored in `alt`) when it already
    // carries an extension; otherwise build a clean slug from the prompt.
    let filename = (rec.alt || '').trim().replace(/[/\\]+/g, '_');
    if (!/\.[a-z0-9]{2,5}$/i.test(filename)) {
      const slug = (rec.prompt || 'image')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .toLowerCase() || 'image';
      filename = `neuroclaw-${slug}-${rec.id.slice(0, 8)}.${ext}`;
    }
    return { buf, mime: rec.mime, filename };
  } catch {
    return null;
  }
}

/** Mint a short-lived signed URL for a stored object. Null on any failure. */
export async function mintSignedUrl(bucket: string, storagePath: string, expiresIn = 3600): Promise<string | null> {
  try {
    const sb = storageBase();
    if (!sb) return null;
    const r = await fetch(`${sb.url}/storage/v1/object/sign/${bucket}/${encodeURI(storagePath)}`, {
      method:  'POST',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ expiresIn }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { signedURL?: string };
    return j.signedURL ? `${sb.url}/storage/v1${j.signedURL}` : null;
  } catch { return null; }
}

export interface GalleryItem {
  id:          string;
  url:         string | null;   // signed URL (may be null if signing failed)
  prompt:      string;
  alt:         string;
  caption:     string | null;
  source_tool: string;
  agent_id:    string | null;
  agent_name:  string;
  session_id:  string | null;
  mime:        string;
  bytes:       number;
  created_at:  number;          // epoch ms
  model:       string | null;
}

/** Read the gallery index and attach fresh signed URLs. */
export async function getGallery(opts?: {
  limit?: number; offset?: number; agentId?: string; sessionId?: string; expiresIn?: number;
}): Promise<{ total: number; items: GalleryItem[] }> {
  const rows: AgentImageRecord[] = listAgentImages(opts);
  const total = countAgentImages(opts);
  const items = await Promise.all(rows.map(async (r): Promise<GalleryItem> => ({
    id:          r.id,
    url:         await mintSignedUrl(r.bucket, r.storage_path, opts?.expiresIn ?? 3600),
    prompt:      r.prompt,
    alt:         r.alt,
    caption:     r.caption,
    source_tool: r.source_tool,
    agent_id:    r.agent_id,
    agent_name:  r.agent_name,
    session_id:  r.session_id,
    mime:        r.mime,
    bytes:       r.bytes,
    created_at:  r.created_at,
    model:       r.model,
  })));
  return { total, items };
}
