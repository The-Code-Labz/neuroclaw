// Uploaded-document storage layer (spec: uploaded-document-handling-overhaul).
//
// Raw uploaded documents (PDF / DOCX / EPUB / HTML / TXT / MD) are pushed to the
// PRIVATE Supabase 'chat-docs' bucket and referenced by short-lived SIGNED URLs.
// DocuFlow parses them via POST /parse/url (verified: it fetches the signed URL
// directly — no base64, no small/large branch). The raw file has a 24h TTL with
// touch-to-extend; the parsed markdown + pgvector chunks persist INDEPENDENTLY.
//
// HARD CONTRACT: this module is flag-gated (DOC_ARCHIVE_ENABLED). Every helper
// fails soft (returns null / a result object, never throws into a hot path) so a
// storage hiccup degrades to the legacy in-SQLite path rather than breaking an
// upload. Mirrors the proven image-archive.ts pattern (raw REST, service key
// server-side only).

import { logger } from '../utils/logger';

export const DOC_BUCKET = 'chat-docs';

const MAX_BYTES = 50 * 1024 * 1024; // matches the per-session attachment cap

// Raw-file TTL (touch-to-extend). Parsed content is NOT bound by this.
export const RAW_TTL_MS = parseInt(
  process.env.DOC_RAW_TTL_HOURS ?? '24', 10,
) * 60 * 60 * 1000;

// DocuFlow REST base (URL-based parse route — smoke-tested 2026-07-05).
const DOCUFLOW_API_URL = process.env.DOCUFLOW_API_URL ?? 'https://docuflow-api.neurolearninglabs.com';

// Capped total budget for inline parse retries. Parse blocks stream-open, so we
// never spend more than this on the hot path — on exhaustion the caller marks
// parse_status='failed' and enqueues a background re-parse for the next turn.
const PARSE_BUDGET_MS = parseInt(process.env.DOC_PARSE_BUDGET_MS ?? '22000', 10);
const PARSE_ATTEMPT_TIMEOUT_MS = parseInt(process.env.DOC_PARSE_ATTEMPT_TIMEOUT_MS ?? '12000', 10);

export function docArchiveEnabled(): boolean {
  return process.env.DOC_ARCHIVE_ENABLED === 'true' || process.env.DOC_ARCHIVE_ENABLED === '1';
}

function storageBase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

function extForName(name: string): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : 'bin';
}

export interface DocUploadResult {
  ok: boolean;
  bucket?: string;
  storagePath?: string;
  error?: string;
}

/**
 * Upload raw document bytes to the private 'chat-docs' bucket.
 * Path: <sessionId>/<contentHash>.<ext> — the content hash makes re-upload of
 * identical bytes idempotent (x-upsert overwrites the same object). Fails soft.
 */
export async function uploadDocToBucket(input: {
  buf: Buffer;
  mime: string;
  name: string;
  contentHash: string;
  sessionId: string | null;
}): Promise<DocUploadResult> {
  try {
    if (!docArchiveEnabled()) return { ok: false, error: 'doc archive disabled' };
    const sb = storageBase();
    if (!sb) return { ok: false, error: 'Supabase storage not configured' };
    if (!input.buf || input.buf.length === 0) return { ok: false, error: 'empty file' };
    if (input.buf.length > MAX_BYTES) return { ok: false, error: `too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB)` };

    const session     = (input.sessionId ?? 'orphan').replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext         = extForName(input.name);
    const storagePath = `${session}/${input.contentHash}.${ext}`;
    const mime        = input.mime || 'application/octet-stream';

    const up = await fetch(`${sb.url}/storage/v1/object/${DOC_BUCKET}/${storagePath}`, {
      method:  'POST',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': mime, 'x-upsert': 'true' },
      body:    new Uint8Array(input.buf),
    });
    if (!up.ok) {
      const body = (await up.text().catch(() => '')).slice(0, 200);
      logger.warn('doc-store: upload failed', { status: up.status, body });
      return { ok: false, error: `upload failed (${up.status})` };
    }
    logger.debug('doc-store: uploaded', { storagePath, bytes: input.buf.length });
    return { ok: true, bucket: DOC_BUCKET, storagePath };
  } catch (err) {
    logger.warn('doc-store: upload error (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Mint a short-lived signed URL for a stored document object. Null on failure. */
export async function mintDocSignedUrl(bucket: string, storagePath: string, expiresIn = 3600): Promise<string | null> {
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

/** Delete a raw document object from the bucket (called by the raw-TTL sweep,
 *  AFTER which the caller clears the raw-only DB columns). Fails soft. */
export async function deleteDocObject(bucket: string, storagePath: string): Promise<boolean> {
  try {
    const sb = storageBase();
    if (!sb) return false;
    const r = await fetch(`${sb.url}/storage/v1/object/${bucket}/${encodeURI(storagePath)}`, {
      method:  'DELETE',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` },
    });
    return r.ok;
  } catch { return false; }
}

export interface DocParseResult {
  ok: boolean;
  title?: string;
  markdown?: string;
  stats?: string;
  error?: string;
  retryable?: boolean;   // true = timeout/5xx/network → background re-parse worth it
}

/**
 * Parse a stored document by feeding DocuFlow a signed URL (POST /parse/url).
 * Capped-budget retry: up to a few quick attempts within PARSE_BUDGET_MS total,
 * so we never blow the stream-open budget. On exhaustion returns retryable=true
 * so the caller can enqueue a background re-parse instead of blocking longer.
 * A 4xx (bad format) is non-retryable and surfaced verbatim.
 */
export async function parseDocViaUrl(signedUrl: string, opts?: { title?: string; format?: string }): Promise<DocParseResult> {
  const deadline = Date.now() + PARSE_BUDGET_MS;
  let attempt = 0;
  let lastErr = 'unknown';

  while (Date.now() < deadline) {
    attempt++;
    const remaining = deadline - Date.now();
    const timeout = Math.min(PARSE_ATTEMPT_TIMEOUT_MS, remaining);
    if (timeout < 1500) break; // not enough budget left for a meaningful attempt

    try {
      const res = await fetch(`${DOCUFLOW_API_URL}/parse/url`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: signedUrl, title: opts?.title ?? '', format: opts?.format ?? '' }),
        signal:  AbortSignal.timeout(timeout),
      });

      if (res.ok) {
        const json = await res.json() as { title?: string; markdown?: string; stats?: string };
        return {
          ok:       true,
          title:    json.title    ?? '',
          markdown: json.markdown ?? '',
          stats:    json.stats    ?? '',
        };
      }

      // 4xx = client/format error → non-retryable, surface verbatim.
      if (res.status >= 400 && res.status < 500) {
        const text = (await res.text().catch(() => `HTTP ${res.status}`)).slice(0, 200);
        return { ok: false, error: `docuflow HTTP ${res.status}: ${text}`, retryable: false };
      }
      // 5xx → retryable within budget.
      lastErr = `docuflow HTTP ${res.status}`;
    } catch (err) {
      // timeout / network → retryable within budget.
      lastErr = err instanceof Error ? err.message : String(err);
    }

    // short backoff before the next in-budget attempt
    if (Date.now() < deadline) await new Promise(r => setTimeout(r, Math.min(1200, Math.max(0, deadline - Date.now()))));
  }

  logger.warn('doc-store: parse budget exhausted', { attempts: attempt, lastErr });
  return { ok: false, error: `parse budget exhausted after ${attempt} attempt(s): ${lastErr}`, retryable: true };
}
