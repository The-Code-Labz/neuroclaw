// Per-session attachment registry.
//
// When a user uploads a binary document (PDF / DOCX / EPUB / HTML) from the
// dashboard chat input, the file's bytes need to be reachable by tool calls —
// most importantly external MCP parsers like docuflow that accept either a
// URL or base64. We don't want to push the raw base64 into the user message
// (it pollutes context badly and would re-stream on every turn), and we don't
// want to write the file to disk + expose a public URL (that surface area is
// out of scope per the upload-strategy decision).
//
// Instead we keep an in-memory map keyed by a generated attachment_id. The
// dashboard `/api/chat` route registers attachments at request entry, threads
// a compact descriptor (id, name, mime, size) into the agent's system context,
// and tells the agent how to retrieve the bytes.
//
// For SMALL files (< LARGE_FILE_THRESHOLD):
//   get_attachment → base64 → mcp__docuflow__parse_document_base64
//
// For LARGE files (>= LARGE_FILE_THRESHOLD):
//   get_attachment returns disk_path → agent POSTs directly to docuflow REST
//   API via bash_run (curl). No base64 truncation risk.
//
// Entries TTL out after RETENTION_MS to keep memory bounded — long enough to
// survive multi-turn tool dances but short enough not to leak. We also cap
// total bytes per session.

import { randomUUID, createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import {
  upsertChatAttachment,
  getChatAttachmentById,
  getChatAttachmentBySessionHash,
  listChatAttachmentsBySession,
  updateChatAttachmentParse,
  refreshChatAttachmentCreatedAt,
  pruneChatAttachments,
  deleteChatAttachmentsBySession,
  updateChatAttachmentStorage,
  touchChatAttachmentRawTtl,
  listExpiredRawAttachments,
  clearChatAttachmentRaw,
  type ChatAttachmentRow,
} from '../db';
import {
  docArchiveEnabled,
  uploadDocToBucket,
  mintDocSignedUrl,
  parseDocViaUrl,
  deleteDocObject,
  RAW_TTL_MS,
} from './doc-store';
import { docRagEnabled, chunkAndEmbedDocument, deleteDocChunks } from './doc-rag';

// Optional disk persistence mirror. Off by default — the registry was
// originally designed to be in-memory only. Set ATTACHMENT_DISK_MIRROR=1 in
// the environment to also write each registered document to
// $ATTACHMENT_DISK_DIR (default: <cwd>/uploads/docs/<sessionId>/<id>__<safe-name>).
// Useful for:
//   - debugging: inspect the bytes the agent actually saw
//   - surviving process restarts / the 30-min in-memory TTL for forensics
//   - external tools (search, indexing) reaching the same files
//   - large-file direct REST API uploads (bypasses base64 truncation)
// Not on the read path — `getAttachment()` still serves from memory. Disk is
// a write-side mirror, fire-and-forget, never blocks registration.
const DISK_MIRROR_ENABLED = process.env.ATTACHMENT_DISK_MIRROR === '1'
                         || process.env.ATTACHMENT_DISK_MIRROR === 'true';
const DISK_MIRROR_DIR = process.env.ATTACHMENT_DISK_DIR
  ? path.resolve(process.env.ATTACHMENT_DISK_DIR)
  : path.resolve(process.cwd(), 'uploads', 'docs');

// Files at or above this size bypass the base64 MCP route and are sent
// directly to the docuflow REST API from the agent via curl/bash_run.
// Default: 1 MB. Override via DOCUFLOW_LARGE_FILE_THRESHOLD_BYTES.
const LARGE_FILE_THRESHOLD = parseInt(
  process.env.DOCUFLOW_LARGE_FILE_THRESHOLD_BYTES ?? String(1 * 1024 * 1024), 10,
);

// Parsed-markdown token ceiling for INLINE context. A pre-parsed doc estimated
// above this is too big to dump whole — when doc RAG is on, the context block
// steers the agent to search_document (chunk retrieval) instead. Tunable.
const RAG_INLINE_TOKEN_THRESHOLD = parseInt(
  process.env.DOC_RAG_INLINE_THRESHOLD ?? '6000', 10,
);

// Docuflow REST API URL — used in the system context block for large files.
const DOCUFLOW_API_URL = process.env.DOCUFLOW_API_URL ?? 'https://docuflow-api.neurolearninglabs.com';

function safeFilename(name: string): string {
  // Strip path separators + control chars; keep dots, dashes, underscores.
  // Don't lowercase — preserves original casing in the on-disk artifact.
  return name.replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 200) || 'unnamed';
}

async function mirrorToDisk(rec: AttachmentRecord): Promise<string | null> {
  if (!DISK_MIRROR_ENABLED) return null;
  try {
    const dir = path.join(DISK_MIRROR_DIR, rec.sessionId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${rec.id}__${safeFilename(rec.name)}`);
    await fs.writeFile(file, Buffer.from(rec.base64, 'base64'));
    logger.debug('attachment-registry: mirrored to disk', { id: rec.id, file });
    return file;
  } catch (err) {
    // Disk mirror is best-effort — never fail the request because the FS is
    // full / readonly / etc. The in-memory record is still the canonical one.
    logger.warn('attachment-registry: disk mirror failed', {
      id: rec.id, sessionId: rec.sessionId, error: (err as Error).message,
    });
    return null;
  }
}

export interface AttachmentRecord {
  id:        string;
  sessionId: string;
  name:      string;
  mime:      string;
  size:      number;       // bytes (decoded)
  base64:    string;       // raw base64, no data-URI prefix
  createdAt: number;
  contentHash?: string;    // sha256 of the cleaned base64 — used for per-session dedup
  diskPath?: string;       // set when disk mirror is enabled — absolute path on host
  // ── eager parse fields (set by parseAttachment()) ────────────────────────
  parsedContent?: {
    title:    string;
    markdown: string;
    stats:    string;
    parsedAt: number;
  };
  parseError?: string;     // set when parseAttachment() failed or timed out
}

export interface AttachmentDescriptor {
  id:          string;
  name:        string;
  mime:        string;
  size:        number;
  diskPath?:   string;     // present when disk mirror is enabled
  isLarge:     boolean;    // true when size >= LARGE_FILE_THRESHOLD
  isParsed:    boolean;    // true when parsedContent is available on the record
  parseError?: string;     // set when parsing failed at upload time
  parsedTokens?: number;   // rough token estimate of the parsed markdown (when isParsed)
}

const RETENTION_MS      = 30 * 60 * 1000;      // 30 minutes (in-memory hot cache)
const MAX_BYTES_PER_SES = 50 * 1024 * 1024;    // 50 MB per session
// Durable rows live longer than the in-memory cache so an upload survives a
// process restart mid-conversation. Tunable via ATTACHMENT_DB_RETENTION_HOURS.
const DURABLE_RETENTION_MS = parseInt(process.env.ATTACHMENT_DB_RETENTION_HOURS ?? '24', 10) * 60 * 60 * 1000;
let lastDbPrune = 0;
const DB_PRUNE_INTERVAL_MS = 10 * 60 * 1000;   // prune the durable table at most every 10 min

// id → record
const store = new Map<string, AttachmentRecord>();
// sessionId → Set<id>  (for cleanup + size accounting)
const bySession = new Map<string, Set<string>>();
// `${sessionId}::${sha256}` → id  (per-session content dedup — lets the Discord
// document carryover re-feed the same bytes on follow-up turns without
// re-registering and re-parsing the same (possibly large) PDF every turn).
const bySessionHash = new Map<string, string>();

function dedupKey(sessionId: string, hash: string): string {
  return `${sessionId}::${hash}`;
}

function forgetRecord(id: string, rec: AttachmentRecord): void {
  store.delete(id);
  const set = bySession.get(rec.sessionId);
  if (set) {
    set.delete(id);
    if (set.size === 0) bySession.delete(rec.sessionId);
  }
  if (rec.contentHash) bySessionHash.delete(dedupKey(rec.sessionId, rec.contentHash));
}

function sweep(): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, rec] of store) {
    if (rec.createdAt < cutoff) forgetRecord(id, rec);
  }
}

function recordToDescriptor(rec: AttachmentRecord): AttachmentDescriptor {
  return {
    id:         rec.id,
    name:       rec.name,
    mime:       rec.mime,
    size:       rec.size,
    diskPath:   rec.diskPath,
    isLarge:    rec.size >= LARGE_FILE_THRESHOLD,
    isParsed:   !!rec.parsedContent,
    parseError: rec.parseError,
    parsedTokens: rec.parsedContent ? Math.ceil(rec.parsedContent.markdown.length / 4) : undefined,
  };
}

// Rebuild an in-memory record from a durable row (after a restart, or a cache
// miss). parsedContent is restored too, so a re-fed document is never re-parsed.
function rowToRecord(row: ChatAttachmentRow): AttachmentRecord {
  const rec: AttachmentRecord = {
    id:          row.id,
    sessionId:   row.session_id,
    name:        row.name,
    mime:        row.mime,
    size:        row.size,
    base64:      row.bytes ? Buffer.from(row.bytes).toString('base64') : '',
    createdAt:   row.created_at,
    contentHash: row.content_hash,
    diskPath:    row.disk_path ?? undefined,
  };
  if (row.parsed_markdown !== null && row.parsed_markdown !== undefined) {
    rec.parsedContent = {
      title:    row.parsed_title ?? row.name,
      markdown: row.parsed_markdown,
      stats:    row.parsed_stats ?? '',
      parsedAt: row.parsed_at ?? Date.now(),
    };
  } else if (row.parse_error) {
    rec.parseError = row.parse_error;
  }
  return rec;
}

// Put a record into the in-memory hot cache without re-persisting it.
function cacheRecord(rec: AttachmentRecord): void {
  store.set(rec.id, rec);
  let set = bySession.get(rec.sessionId);
  if (!set) { set = new Set(); bySession.set(rec.sessionId, set); }
  set.add(rec.id);
  if (rec.contentHash) bySessionHash.set(dedupKey(rec.sessionId, rec.contentHash), rec.id);
}

// Prune the durable table on a throttle so a busy registry doesn't DELETE on
// every call. Best-effort — never throws into the caller.
function maybePruneDurable(): void {
  const now = Date.now();
  if (now - lastDbPrune < DB_PRUNE_INTERVAL_MS) return;
  lastDbPrune = now;
  try { pruneChatAttachments(DURABLE_RETENTION_MS); } catch { /* non-fatal */ }
  // When the bucket path is live, also sweep raw objects past their 24h TTL —
  // deletes the bucket object + clears raw columns, leaving parse + embeddings.
  if (docArchiveEnabled()) void sweepExpiredRawDocs();
}

function sessionBytes(sessionId: string): number {
  const set = bySession.get(sessionId);
  if (!set) return 0;
  let total = 0;
  for (const id of set) {
    const rec = store.get(id);
    if (rec) total += rec.size;
  }
  return total;
}

/** Strip a data-URI prefix if present. Returns the raw base64 payload. */
function stripDataUri(input: string): { base64: string; mime?: string } {
  const m = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s.exec(input);
  if (!m) return { base64: input };
  return { base64: m[2], mime: m[1] || undefined };
}

// Mirrors docuflow MCP's parse_document_* tool support:
//   "Supported: PDF, EPUB, DOCX, TXT, MD, HTML"
// Anything outside this set won't get a structured extraction even if we
// register the bytes, so we reject up front with a clear error.
const ACCEPTED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/epub+zip',
  'text/html',
  'application/xhtml+xml',
  'text/plain',     // .txt
  'text/markdown',  // .md
]);
const ACCEPTED_EXTS = ['.pdf', '.docx', '.epub', '.html', '.htm', '.xhtml', '.txt', '.md', '.markdown'];

function inferMime(name: string, declared?: string): string {
  if (declared && ACCEPTED_MIMES.has(declared)) return declared;
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf'))   return 'application/pdf';
  if (lower.endsWith('.docx'))  return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.epub'))  return 'application/epub+zip';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.xhtml')) return 'application/xhtml+xml';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.txt'))   return 'text/plain';
  return declared || 'application/octet-stream';
}

export function isAcceptedAttachmentName(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTS.some(ext => lower.endsWith(ext));
}

export interface RegisterInput {
  sessionId: string;
  name:      string;
  /** Either raw base64 or a `data:...;base64,...` URI. */
  data:      string;
  /** Declared MIME (best-effort). Will be normalized / inferred. */
  mime?:     string;
  /** Pre-written file on disk (e.g. the session-uploads workspace file). When
   *  set, it is used as the record's disk_path and the internal mirror is skipped. */
  diskPath?: string;
}

export interface RegisterResult {
  ok:         true;
  descriptor: AttachmentDescriptor;
}
export interface RegisterError {
  ok:    false;
  error: string;
}

/** Register a document attachment for a session. Returns a descriptor the
 *  caller can thread into the system context so the agent knows the file
 *  exists and how to retrieve it. */
export function registerAttachment(input: RegisterInput): RegisterResult | RegisterError {
  sweep();

  if (!input.sessionId) return { ok: false, error: 'sessionId required' };
  if (!input.name)      return { ok: false, error: 'name required' };
  if (!input.data)      return { ok: false, error: 'data required' };
  if (!isAcceptedAttachmentName(input.name)) {
    return { ok: false, error: `unsupported attachment type — accepted: ${ACCEPTED_EXTS.join(', ')}` };
  }

  const { base64, mime: dataUriMime } = stripDataUri(input.data);

  // Validate base64 cheaply — strict enough to reject obvious garbage without
  // round-tripping the whole buffer.
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64) || base64.length < 4) {
    return { ok: false, error: 'data does not look like valid base64' };
  }

  const clean = base64.replace(/\s+/g, '');
  let size: number;
  try {
    size = Buffer.byteLength(Buffer.from(clean, 'base64'));
  } catch (err) {
    return { ok: false, error: `base64 decode failed: ${(err as Error).message}` };
  }
  if (size === 0) return { ok: false, error: 'attachment is empty' };

  // Per-session content dedup: if these exact bytes were already registered for
  // this session (and haven't expired), reuse that record — refresh its TTL and
  // return its descriptor (incl. any parse already done). This makes the Discord
  // document carryover cheap: re-feeding the same PDF on every follow-up turn
  // doesn't re-register or re-parse it.
  const contentHash = createHash('sha256').update(clean).digest('hex');
  const priorId = bySessionHash.get(dedupKey(input.sessionId, contentHash));
  if (priorId) {
    const prior = store.get(priorId);
    if (prior) {
      prior.createdAt = Date.now();   // refresh TTL — keep it alive for the conversation
      try { refreshChatAttachmentCreatedAt(prior.id, prior.createdAt); } catch { /* non-fatal */ }
      // Re-reference → touch-to-extend the raw-file TTL so the bucket object
      // isn't swept while the conversation is still using it.
      if (docArchiveEnabled()) { try { touchChatAttachmentRawTtl(prior.id, Date.now() + RAW_TTL_MS); } catch { /* non-fatal */ } }
      return { ok: true, descriptor: recordToDescriptor(prior) };
    }
    bySessionHash.delete(dedupKey(input.sessionId, contentHash));
  }
  // Durable dedup: after a restart the in-memory index is empty, but the row
  // (and its server-side parse) may still be in SQLite. Rehydrate it instead of
  // re-registering + re-parsing the same document — this is what lets a Discord
  // document carryover survive a process restart mid-conversation.
  try {
    const row = getChatAttachmentBySessionHash(input.sessionId, contentHash);
    if (row) {
      const rec = rowToRecord(row);
      rec.createdAt = Date.now();
      cacheRecord(rec);
      refreshChatAttachmentCreatedAt(rec.id, rec.createdAt);
      if (docArchiveEnabled()) { try { touchChatAttachmentRawTtl(rec.id, Date.now() + RAW_TTL_MS); } catch { /* non-fatal */ } }
      return { ok: true, descriptor: recordToDescriptor(rec) };
    }
  } catch (err) {
    logger.warn('attachment-registry: durable dedup lookup failed', { error: (err as Error).message });
  }

  const existing = sessionBytes(input.sessionId);
  if (existing + size > MAX_BYTES_PER_SES) {
    return {
      ok: false,
      error: `attachment would exceed per-session limit (${Math.round(MAX_BYTES_PER_SES / 1024 / 1024)} MB)`,
    };
  }

  const mime = inferMime(input.name, dataUriMime ?? input.mime);
  const id   = randomUUID();
  const rec: AttachmentRecord = {
    id,
    sessionId: input.sessionId,
    name:      input.name,
    mime,
    size,
    base64:    clean,
    createdAt: Date.now(),
    contentHash,
    diskPath:  input.diskPath,
  };

  cacheRecord(rec);

  // Durable write-through: persist the bytes so the upload survives a restart.
  // Best-effort — the in-memory record is still canonical for this process.
  try {
    upsertChatAttachment({
      id, sessionId: input.sessionId, contentHash, name: input.name,
      mime, size, bytes: Buffer.from(clean, 'base64'), diskPath: input.diskPath ?? null, createdAt: rec.createdAt,
    });
  } catch (err) {
    logger.warn('attachment-registry: durable persist failed', { id, error: (err as Error).message });
  }
  maybePruneDurable();

  logger.debug('attachment-registry: registered', {
    id, sessionId: input.sessionId, name: input.name, mime, size,
    isLarge: size >= LARGE_FILE_THRESHOLD,
  });

  // Prefer a caller-supplied on-disk file (session-uploads workspace file); else
  // fall back to the optional internal mirror.
  if (input.diskPath) {
    rec.diskPath = input.diskPath;
  } else {
    void mirrorToDisk(rec).then(diskPath => {
      if (diskPath) rec.diskPath = diskPath;
    });
  }

  return { ok: true, descriptor: recordToDescriptor(rec) };
}

/** Bucket + URL-based parse path (flag-gated by DOC_ARCHIVE_ENABLED).
 *  Returns:
 *    'ok'          — rec.parsedContent set (+ embed hook fired)
 *    'error'       — parse failed after the capped budget (state persisted for a
 *                    future background re-parse)
 *    'fallthrough' — a storage-side prerequisite was missing (Supabase not
 *                    configured, bucket upload failed, signed-URL mint failed) →
 *                    caller degrades to the legacy multipart path.
 */
async function parseViaBucket(rec: AttachmentRecord): Promise<'ok' | 'error' | 'fallthrough'> {
  const MAX_ERR_LEN = 200;
  try {
    // Reload the durable row to see whether the bytes are already in the bucket.
    const row = getChatAttachmentById(rec.id);
    let storageBucket = row?.storage_bucket ?? null;
    let storagePath   = row?.storage_path ?? null;

    if (!storageBucket || !storagePath) {
      // First parse for this doc — push the raw bytes to the bucket.
      const contentHash = rec.contentHash
        ?? createHash('sha256').update(rec.base64.replace(/\s+/g, '')).digest('hex');
      const buf = Buffer.from(rec.base64, 'base64');
      const up = await uploadDocToBucket({ buf, mime: rec.mime, name: rec.name, contentHash, sessionId: rec.sessionId });
      if (!up.ok || !up.bucket || !up.storagePath) {
        logger.warn('attachment-registry: bucket upload failed — falling back to multipart', { id: rec.id, error: up.error });
        return 'fallthrough';
      }
      storageBucket = up.bucket;
      storagePath   = up.storagePath;
      try {
        updateChatAttachmentStorage(rec.id, {
          storageBucket, storagePath, rawExpiresAt: Date.now() + RAW_TTL_MS, parseStatus: 'pending',
        });
      } catch { /* non-fatal */ }
    } else {
      // Re-parse of an already-bucketed doc → touch-to-extend the raw TTL so an
      // actively-referenced file isn't swept mid-conversation.
      try { touchChatAttachmentRawTtl(rec.id, Date.now() + RAW_TTL_MS); } catch { /* non-fatal */ }
    }

    const signed = await mintDocSignedUrl(storageBucket, storagePath, 3600);
    if (!signed) {
      logger.warn('attachment-registry: signed-URL mint failed — falling back to multipart', { id: rec.id });
      return 'fallthrough';
    }

    const parsed = await parseDocViaUrl(signed, { title: rec.name });

    if (parsed.ok) {
      rec.parsedContent = {
        title:    parsed.title    || rec.name,
        markdown: parsed.markdown ?? '',
        stats:    parsed.stats    ?? '',
        parsedAt: Date.now(),
      };
      try {
        updateChatAttachmentParse(rec.id, {
          parsedTitle:    rec.parsedContent.title,
          parsedMarkdown: rec.parsedContent.markdown,
          parsedStats:    rec.parsedContent.stats,
          parsedAt:       rec.parsedContent.parsedAt,
          parseError:     null,
        });
        updateChatAttachmentStorage(rec.id, { parseStatus: 'done' });
      } catch { /* non-fatal */ }

      // Embed-once hook — fire-and-forget AFTER the parse result is committed, so
      // it never blocks the stream-open budget. Idempotent + fail-soft internally.
      if (docRagEnabled() && rec.parsedContent.markdown) {
        void chunkAndEmbedDocument({
          attachmentId: rec.id, sessionId: rec.sessionId, markdown: rec.parsedContent.markdown,
        });
      }

      logger.debug('attachment-registry: parseViaBucket ok', { id: rec.id, name: rec.name, title: rec.parsedContent.title });
      return 'ok';
    }

    // Parse failed. Persist state for a future background re-parse; a retryable
    // failure (timeout/5xx) keeps 'failed' + bumps attempts, a 4xx is terminal.
    rec.parseError = (parsed.error ?? 'parse failed').slice(0, MAX_ERR_LEN);
    const attempts = (row?.parse_attempts ?? 0) + 1;
    try {
      updateChatAttachmentParse(rec.id, { parseError: rec.parseError });
      updateChatAttachmentStorage(rec.id, { parseStatus: 'failed', parseAttempts: attempts });
    } catch { /* non-fatal */ }
    logger.warn('attachment-registry: parseViaBucket failed', {
      id: rec.id, retryable: parsed.retryable, attempts, error: rec.parseError,
    });
    return 'error';
  } catch (err) {
    logger.warn('attachment-registry: parseViaBucket error — falling back to multipart', {
      id: rec.id, error: (err as Error).message,
    });
    return 'fallthrough';
  }
}

/** Sweep raw document objects whose 24h TTL has expired: delete the bucket
 *  object, then clear ONLY the raw columns. Parsed markdown + doc_chunks
 *  embeddings are preserved — the no-data-loss guarantee. Best-effort. */
async function sweepExpiredRawDocs(): Promise<void> {
  try {
    const expired = listExpiredRawAttachments(Date.now(), 100);
    if (!expired.length) return;
    let cleared = 0;
    for (const row of expired) {
      if (row.storage_bucket && row.storage_path) {
        const ok = await deleteDocObject(row.storage_bucket, row.storage_path);
        if (!ok) continue;   // leave for the next sweep if the object delete failed
      }
      clearChatAttachmentRaw(row.id);
      cleared++;
    }
    if (cleared) logger.debug('attachment-registry: swept expired raw docs', { cleared, seen: expired.length });
  } catch (err) {
    logger.warn('attachment-registry: raw-doc sweep failed (non-fatal)', { error: (err as Error).message });
  }
}

/** Parse an already-registered attachment server-side via the docuflow REST API.
 *  Mutates the record in-place: sets rec.parsedContent on success, rec.parseError
 *  on failure. Never throws — all errors are captured into parseError.
 *
 *  Returns:
 *    'ok'        — rec.parsedContent is now set
 *    'error'     — rec.parseError is now set
 *    'not_found' — id not in the store (expired or invalid)
 */
export async function parseAttachment(id: string): Promise<'ok' | 'error' | 'not_found'> {
  let rec = store.get(id);
  if (!rec) {
    // Load-on-miss from the durable store (e.g. parse requested after a restart).
    try {
      const row = getChatAttachmentById(id);
      if (row) { rec = rowToRecord(row); cacheRecord(rec); }
    } catch { /* fall through to not_found */ }
  }
  if (!rec) return 'not_found';

  // Idempotent — if the record was already parsed successfully, don't overwrite it.
  if (rec.parsedContent) return 'ok';

  // ── Bucket + URL-based parse (flag-gated) ──────────────────────────────────
  // Uploads raw bytes to the private chat-docs bucket ONCE, mints a signed URL,
  // and feeds DocuFlow POST /parse/url (verified: it fetches the URL directly —
  // no base64, no small/large branch). Any storage-side miss returns
  // 'fallthrough' so we degrade to the legacy multipart path below rather than
  // breaking the upload. On success, fires the embed hook fire-and-forget.
  if (docArchiveEnabled()) {
    const viaUrl = await parseViaBucket(rec);
    if (viaUrl !== 'fallthrough') return viaUrl;
  }

  const MAX_ERR_LEN = 200;
  // Decode base64 back to raw bytes for the multipart POST.
  const buf = Buffer.from(rec.base64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: rec.mime }), rec.name);

  try {
    const res = await fetch(`${DOCUFLOW_API_URL}/parse`, {
      method: 'POST',
      body:   form,
      signal: AbortSignal.timeout(30_000),   // 30-second hard timeout
    });

    if (!res.ok) {
      const text = await res.text().catch(() => `HTTP ${res.status}`);
      rec.parseError = `docuflow HTTP ${res.status}: ${text.slice(0, MAX_ERR_LEN)}`.slice(0, MAX_ERR_LEN);
      try { updateChatAttachmentParse(id, { parseError: rec.parseError }); } catch { /* non-fatal */ }
      logger.warn('attachment-registry: parseAttachment failed', { id, status: res.status, error: rec.parseError });
      return 'error';
    }

    const json = await res.json() as {
      title?:    string;
      markdown?: string;
      stats?:    string;
    };

    rec.parsedContent = {
      title:    json.title    ?? rec.name,
      markdown: json.markdown ?? '',
      stats:    json.stats    ?? '',
      parsedAt: Date.now(),
    };
    // Persist the parse so a re-fed document (carryover / post-restart) reuses
    // it instead of hitting docuflow again.
    try {
      updateChatAttachmentParse(id, {
        parsedTitle:    rec.parsedContent.title,
        parsedMarkdown: rec.parsedContent.markdown,
        parsedStats:    rec.parsedContent.stats,
        parsedAt:       rec.parsedContent.parsedAt,
        parseError:     null,
      });
    } catch { /* non-fatal — in-memory parse still serves this process */ }

    logger.debug('attachment-registry: parseAttachment ok', {
      id, name: rec.name, title: rec.parsedContent.title,
    });
    return 'ok';
  } catch (err) {
    rec.parseError = (err as Error).message.slice(0, MAX_ERR_LEN);
    try { updateChatAttachmentParse(id, { parseError: rec.parseError }); } catch { /* non-fatal */ }
    logger.warn('attachment-registry: parseAttachment error', { id, name: rec.name, error: rec.parseError });
    return 'error';
  }
}

/** Look up an attachment by id. Returns the full record (including base64).
 *  Falls back to the durable store on a cache miss (e.g. after a restart). */
export function getAttachment(id: string): AttachmentRecord | null {
  sweep();
  const hot = store.get(id);
  if (hot) return hot;
  try {
    const row = getChatAttachmentById(id);
    if (row) { const rec = rowToRecord(row); cacheRecord(rec); return rec; }
  } catch { /* fall through */ }
  return null;
}

/** Document descriptors for re-feeding into a chat turn — name + mime + bytes.
 *  Reads the durable store so it survives a restart. Used by the Discord
 *  document carryover to re-attach a recently-uploaded file on a follow-up turn
 *  when the in-memory carryover cache is cold. */
export function getSessionDocuments(
  sessionId: string,
  withinMs: number = DURABLE_RETENTION_MS,
): Array<{ name: string; mime_type: string; data: string }> {
  try {
    const rows = listChatAttachmentsBySession(sessionId, Date.now() - withinMs);
    return rows
      .filter(r => r.bytes)
      .map(r => ({ name: r.name, mime_type: r.mime, data: Buffer.from(r.bytes as Buffer).toString('base64') }));
  } catch (err) {
    logger.warn('attachment-registry: getSessionDocuments failed', { sessionId, error: (err as Error).message });
    return [];
  }
}

/** List descriptors (no base64) for a session. */
export function listAttachments(sessionId: string): AttachmentDescriptor[] {
  sweep();
  const set = bySession.get(sessionId);
  if (!set) return [];
  const out: AttachmentDescriptor[] = [];
  for (const id of set) {
    const rec = store.get(id);
    if (rec) out.push({
      id:          rec.id,
      name:        rec.name,
      mime:        rec.mime,
      size:        rec.size,
      diskPath:    rec.diskPath,
      isLarge:     rec.size >= LARGE_FILE_THRESHOLD,
      isParsed:    !!rec.parsedContent,
      parseError:  rec.parseError,
      parsedTokens: rec.parsedContent ? Math.ceil(rec.parsedContent.markdown.length / 4) : undefined,
    });
  }
  return out;
}

/** Drop all attachments for a session (e.g. when the session is deleted). */
export function clearSessionAttachments(sessionId: string): void {
  // Collect every attachment id for this session (hot cache + durable rows) so we
  // can also drop its doc_chunks embeddings — the in-memory set may be cold after
  // a restart, so we union it with the durable rows.
  const ids = new Set<string>();
  const set = bySession.get(sessionId);
  if (set) {
    for (const id of set) {
      ids.add(id);
      const rec = store.get(id);
      if (rec?.contentHash) bySessionHash.delete(dedupKey(sessionId, rec.contentHash));
      store.delete(id);
    }
    bySession.delete(sessionId);
  }
  if (docRagEnabled()) {
    try { for (const r of listChatAttachmentsBySession(sessionId, 0)) ids.add(r.id); } catch { /* non-fatal */ }
    for (const id of ids) void deleteDocChunks(id);   // fail-soft, embeddings are anchored to attachment_id
  }
  // Also drop the durable rows so a deleted session doesn't leave document bytes behind.
  try { deleteChatAttachmentsBySession(sessionId); } catch { /* non-fatal */ }
}

/** Build the system-context block injected into the agent's prompt when
 *  attachments are present.
 *  - Pre-parsed files (isParsed = true): direct the agent to get_attachment_parsed.
 *  - Unparsed files (isParsed = false): keep the existing base64 / REST API fallback. */
export function buildAttachmentContextBlock(descriptors: AttachmentDescriptor[]): string {
  if (descriptors.length === 0) return '';

  const lines = descriptors.map(d => {
    const sizeKb = Math.round(d.size / 1024);
    let tag = '';
    if (d.isParsed)          tag = '  ✓ pre-parsed';
    else if (d.parseError)   tag = `  ⚠ parse failed: ${d.parseError.slice(0, 80)}`;
    else if (d.isLarge)      tag = '  ⚠ LARGE FILE — use REST API route below';
    return `  - attachment_id: ${d.id}  name: "${d.name}"  mime: ${d.mime}  size: ${d.size} bytes (${sizeKb} KB)${tag}`;
  });

  const hasParsed   = descriptors.some(d => d.isParsed);
  const hasUnparsed = descriptors.some(d => !d.isParsed);
  const hasLarge    = descriptors.some(d => !d.isParsed && d.isLarge);
  const hasSmall    = descriptors.some(d => !d.isParsed && !d.isLarge);
  const thresholdKb = Math.round(LARGE_FILE_THRESHOLD / 1024);

  // Doc-RAG retrieval steering — ONLY when the flag is on. When off, bigParsed is
  // empty and this whole block collapses to '', keeping the legacy context output
  // byte-identical (Stage 2 dormant contract).
  const bigParsed = docRagEnabled()
    ? descriptors.filter(d => d.isParsed && (d.parsedTokens ?? 0) > RAG_INLINE_TOKEN_THRESHOLD)
    : [];

  const parsedSection = hasParsed ? `
### Pre-parsed documents — use get_attachment_parsed

For each "✓ pre-parsed" document above, call:

    get_attachment_parsed({ id: "<attachment_id>" })
    → returns { ok: true, id, name, mime, size, title, markdown, stats }

Rules:
  - Do NOT call get_attachment for pre-parsed files — use get_attachment_parsed.
  - Use the returned markdown as context to answer the user's question.
  - If it returns { ok: false, parseError: "..." }, report the error verbatim and fall back to the base64 route.
  - Do NOT echo the raw markdown back to the user unprompted — use it as input context.` : '';

  const smallSection = hasSmall ? `
### Small files (< ${thresholdKb} KB) — MCP base64 route (fallback)

Step 1 — Pull the base64 bytes from the registry:

    get_attachment({ id: "<attachment_id>" })
    → returns { ok: true, id, name, mime, size, base64: "<long string>" }

Step 2 — Forward to docuflow MCP:

    mcp__docuflow__parse_document_base64({
      content_base64: "<the base64 from step 1>",
      filename: "<name from step 1>"
    })

    Common parameter mistakes that will fail:
      ✗ \`base64\`        → use \`content_base64\`
      ✗ \`data\`          → use \`content_base64\`
      ✗ \`file\` / \`bytes\` → use \`content_base64\`
      ✗ \`name\`          → use \`filename\`` : '';

  const largeSection = hasLarge ? `
### Large files (>= ${thresholdKb} KB) — REST API route (no base64, no truncation)

Do NOT call get_attachment for these — base64 will be truncated in transit.
Instead POST the file directly to the docuflow REST API using bash_run:

    bash_run({
      command: "curl -s -X POST ${DOCUFLOW_API_URL}/parse -F 'file=@<disk_path>' | python3 -c \\"import json,sys; d=json.load(sys.stdin); print(d['title']); print(d['stats'])\\""
    })

    Where <disk_path> is the attachment's disk_path from get_attachment (only
    available when ATTACHMENT_DISK_MIRROR=1). If disk_path is null, fall back
    to the base64 route and warn the user about possible truncation.

Full parse (title + markdown + chunks + stats):

    bash_run({
      command: "curl -s -X POST ${DOCUFLOW_API_URL}/parse -F 'file=@<disk_path>'"
    })

Raw text only (faster, no chunking):

    bash_run({
      command: "curl -s -X POST ${DOCUFLOW_API_URL}/extract -F 'file=@<disk_path>'"
    })` : '';

  const ragSection = bigParsed.length ? `
### Large pre-parsed documents — use search_document (chunk retrieval)

These pre-parsed documents are large — dumping their full markdown would flood the context. For each, retrieve ONLY the passages relevant to the user's question:

${bigParsed.map(d => `    search_document({ id: "${d.id}", query: "<your question>" })   // "${d.name}" ≈ ${d.parsedTokens} tokens`).join('\n')}

    → returns { ok: true, hits: [{ chunkIndex, content, score }] }

Rules:
  - Prefer search_document for these — call it with a focused query per sub-question.
  - get_attachment_parsed still returns the FULL markdown if you genuinely need the whole document, but avoid it for these large files unless necessary.
  - If search_document returns no hits (not embedded yet), fall back to get_attachment_parsed.` : '';

  const fallbackHeader = hasUnparsed ? `\n## Fallback routes (for files that could not be pre-parsed)` : '';

  return `

---
The user has uploaded ${descriptors.length} document${descriptors.length === 1 ? '' : 's'} to this turn. The bytes are NOT inlined in the message — they live in a per-session attachment registry. Treat these as first-class context:

${lines.join('\n')}

## How to parse these documents
${parsedSection}${ragSection}${fallbackHeader}${smallSection}${largeSection}

## Rules

- Do NOT claim the file is unavailable, that you can only infer from the filename, or that you "couldn't access" it.
- Do NOT echo the raw base64 back to the user or into chat — it's binary intended for tool input only.
- For large files, ALWAYS use the REST API route via bash_run — do not attempt base64 for files >= ${thresholdKb} KB.
- If \`get_attachment\` returns \`ok: false\`, surface the actual error (likely "no attachment with id …" or "expired (30 min TTL)").
- If \`mcp__docuflow__parse_document_base64\` errors, retry ONCE with \`parse_pdf_base64\` for PDFs. If it still fails, report the error verbatim.`;
}
