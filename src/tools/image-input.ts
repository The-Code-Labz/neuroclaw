// Shared image-input resolution for edit-capable tools (venice_image_edit,
// abacus_image, voidai_image, voidai_gpt_image, voidai_gemini_pro_image,
// kie_image, fal_image).
//
// Problem: agents were reading multi-MB local images (uploads or generated
// files), base64-encoding them CLIENT-SIDE (in their own context), and
// inlining the resulting megabyte-scale string as a tool_use argument. That
// balloons the tool-call payload and gets rejected/mis-handled well before it
// ever reaches the provider. Fix: accept a session upload id or a local file
// path and resolve+read the bytes SERVER-SIDE — the raw bytes never touch the
// agent's context at all.
//
// Three output "formats", matching what each provider actually expects:
//  - 'bare-base64' (Venice): bare base64 string, or an https URL passed
//    through unchanged — Venice's /image/edit accepts either directly.
//  - 'data-url' (Abacus, VoidAI trio): a full `data:<mime>;base64,...` URI,
//    or an https URL passed through unchanged (their own code fetches it).
//  - 'public-url' (KIE, fal): these REQUIRE a public https URL — base64 is
//    not accepted at all. Local bytes are staged to the public /uploads/
//    dir and returned as an absolute URL.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUpload } from '../system/session-uploads';
import { resolveWorkspace } from '../system/workspace';
import { checkFsBoundary } from '../system/exec-tools';

const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort mime sniff from magic bytes — used when a bare base64 blob
 *  gives us no extension/mime hint to work with. */
function sniffMime(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.slice(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/png';
}

export interface ResolveCtx { agentId?: string | null; sessionId?: string | null }
export type ResolvedImage = { ok: true; value: string } | { ok: false; error: string };

/** Read raw bytes if `raw` is a session upload id (from list_uploads/get_upload)
 *  or a local file path (absolute, or relative to the agent's workspace).
 *  Returns null (not an error) if it's neither, so callers fall through to
 *  their own URL/base64 handling. */
async function readLocalBytes(raw: string, ctx: ResolveCtx): Promise<{ buf: Buffer; mime: string } | null> {
  if (UUID_RE.test(raw) && ctx.sessionId) {
    const rec = getUpload(ctx.sessionId, raw);
    if (rec?.path) {
      const buf = await fsp.readFile(rec.path);
      const ext = path.extname(rec.path).toLowerCase();
      return { buf, mime: rec.mime || IMAGE_EXT_MIME[ext] || sniffMime(buf) };
    }
  }

  // Local file path — detected by path separators + a recognized image
  // extension. A bare base64 blob never has that shape (no '/' structure,
  // no trailing dotted extension).
  const ext = path.extname(raw).toLowerCase();
  const looksLikePath = (raw.includes('/') || raw.includes('\\')) && !!IMAGE_EXT_MIME[ext];
  if (looksLikePath) {
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(resolveWorkspace(ctx.sessionId ?? null, ctx.agentId ?? null), raw);
    checkFsBoundary(resolved); // throws if outside EXEC_ROOT
    const buf = await fsp.readFile(resolved);
    return { buf, mime: IMAGE_EXT_MIME[ext] };
  }

  return null;
}

/** Stage raw bytes into the public, unauthenticated /uploads/edit-src/ dir
 *  (same serving pattern as /uploads/chat/) and return an absolute https URL
 *  built from config.dashboard.publicUrl. */
function stagePublicUrl(buf: Buffer, mime: string, ctx: ResolveCtx): string {
  const ext = MIME_EXT[mime] ?? 'png';
  const safeSession = (ctx.sessionId ?? 'orphan').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${Date.now()}-${randomUUID()}.${ext}`;
  const dir = path.resolve(process.cwd(), 'uploads', 'edit-src', safeSession);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buf);
  const url = `${config.dashboard.publicUrl}/uploads/edit-src/${safeSession}/${filename}`;
  logger.info('image-input: staged local image as public URL', { sessionId: ctx.sessionId, url, bytes: buf.length });
  return url;
}

/**
 * Resolve a tool's `input_image` argument into the exact string shape that
 * provider expects, reading local uploads/files server-side so their bytes
 * never have to round-trip through the agent's own context.
 *
 * Accepts, in all three formats: an https URL, a `data:` URI, a bare base64
 * string, a session upload id (from list_uploads), or a local file path
 * (absolute, or relative to the agent's workspace) ending in a recognized
 * image extension.
 */
export async function resolveImageInput(
  raw: string,
  ctx: ResolveCtx,
  format: 'bare-base64' | 'data-url' | 'public-url',
): Promise<ResolvedImage> {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, error: 'input_image is empty' };

  // https URL — every format accepts (or itself fetches) a URL unchanged.
  if (/^https?:\/\//i.test(input)) return { ok: true, value: input };

  if (format === 'public-url') {
    let buf: Buffer;
    let mime = 'image/png';
    try {
      if (input.startsWith('data:')) {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(input);
        if (!match) return { ok: false, error: 'malformed data: URI — expected data:<mime>;base64,<payload>' };
        mime = match[1];
        buf = Buffer.from(match[2], 'base64');
      } else {
        const local = await readLocalBytes(input, ctx);
        if (local) {
          buf = local.buf; mime = local.mime;
        } else {
          buf = Buffer.from(input, 'base64');
          if (buf.length === 0) {
            return { ok: false, error: 'input_image must be a public https URL, a session upload id, a local file path, or a base64 string.' };
          }
          mime = sniffMime(buf);
        }
      }
    } catch (err) {
      return { ok: false, error: `failed to read input_image '${input.slice(0, 120)}': ${(err as Error).message}` };
    }
    if (buf.length === 0) return { ok: false, error: 'input_image resolved to 0 bytes' };
    try {
      return { ok: true, value: stagePublicUrl(buf, mime, ctx) };
    } catch (err) {
      return { ok: false, error: `failed to stage input_image for upload: ${(err as Error).message}` };
    }
  }

  // bare-base64 / data-url formats
  if (input.startsWith('data:')) {
    if (format === 'data-url') return { ok: true, value: input };
    const b64 = input.split(',')[1] ?? '';
    return b64 ? { ok: true, value: b64 } : { ok: false, error: 'malformed data: URI — no base64 payload found' };
  }

  try {
    const local = await readLocalBytes(input, ctx);
    if (local) {
      return format === 'data-url'
        ? { ok: true, value: `data:${local.mime};base64,${local.buf.toString('base64')}` }
        : { ok: true, value: local.buf.toString('base64') };
    }
  } catch (err) {
    return { ok: false, error: `failed to read input_image '${input.slice(0, 120)}': ${(err as Error).message}` };
  }

  // Not a URL, data: URI, upload id, or local path — assume it's already a
  // bare base64 string (legacy behavior).
  if (format === 'data-url') {
    try {
      const buf = Buffer.from(input, 'base64');
      if (buf.length === 0) return { ok: false, error: 'input_image is not a valid https URL, upload id, file path, or base64 string.' };
      return { ok: true, value: `data:${sniffMime(buf)};base64,${input}` };
    } catch {
      return { ok: false, error: 'input_image is not a valid https URL, upload id, file path, or base64 string.' };
    }
  }
  return { ok: true, value: input };
}
