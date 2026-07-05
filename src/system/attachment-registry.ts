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
  type ChatAttachmentRow,
} from '../db';

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

// Docuflow REST API URL — used in the system context block for large files.
const DOCUFLOW_API_URL = process.env.DOCUFLOW_API_URL ?? 'https://docuflow-api.your-domain.com';

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
    });
  }
  return out;
}

/** Drop all attachments for a session (e.g. when the session is deleted). */
export function clearSessionAttachments(sessionId: string): void {
  const set = bySession.get(sessionId);
  if (set) {
    for (const id of set) {
      const rec = store.get(id);
      if (rec?.contentHash) bySessionHash.delete(dedupKey(sessionId, rec.contentHash));
      store.delete(id);
    }
    bySession.delete(sessionId);
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

  const fallbackHeader = hasUnparsed ? `\n## Fallback routes (for files that could not be pre-parsed)` : '';

  return `

---
The user has uploaded ${descriptors.length} document${descriptors.length === 1 ? '' : 's'} to this turn. The bytes are NOT inlined in the message — they live in a per-session attachment registry. Treat these as first-class context:

${lines.join('\n')}

## How to parse these documents
${parsedSection}${fallbackHeader}${smallSection}${largeSection}

## Rules

- Do NOT claim the file is unavailable, that you can only infer from the filename, or that you "couldn't access" it.
- Do NOT echo the raw base64 back to the user or into chat — it's binary intended for tool input only.
- For large files, ALWAYS use the REST API route via bash_run — do not attempt base64 for files >= ${thresholdKb} KB.
- If \`get_attachment\` returns \`ok: false\`, surface the actual error (likely "no attachment with id …" or "expired (30 min TTL)").
- If \`mcp__docuflow__parse_document_base64\` errors, retry ONCE with \`parse_pdf_base64\` for PDFs. If it still fails, report the error verbatim.`;
}
