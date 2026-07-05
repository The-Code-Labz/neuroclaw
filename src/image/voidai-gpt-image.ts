import { config } from '../config';
import { delay, isTransientVoidaiError, TRANSIENT_BACKOFF_MS } from './voidai-image';

// Direct-API image generate/edit via VoidAI's OpenAI-compatible Images API,
// using OpenAI's gpt-image models (default gpt-image-2). Modeled on the
// The-Code-Labz/void-canvas-studio Supabase edge functions (generate-image /
// edit-image), minus the Supabase auth/storage/DB layer — here images are
// delivered via send_image_to_user.
//
// This speaks a DIFFERENT protocol from voidai-image.ts (the Gemini/Nano-Banana
// tool): the OpenAI Images endpoints, not chat/completions. Generate is a JSON
// POST to /images/generations; edit is a multipart/form-data POST to
// /images/edits carrying the source image (and optional mask) as files.
// gpt-image models reject the dall-e-only `n` / `response_format` params and
// always return base64 PNGs in data[].b64_json (there is no url response).

export const DEFAULT_VOIDAI_GPT_IMAGE_MODEL = 'gpt-image-2';

// Sizes accepted by gpt-image via VoidAI (see void-canvas-studio SizeSelector).
export const VOIDAI_GPT_IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024', '512x512'] as const;
export type VoidaiGptImageSize = (typeof VOIDAI_GPT_IMAGE_SIZES)[number];

export interface VoidaiGptImageItem {
  base64: string;
  mime:   string; // gpt-image returns PNG
}

export interface VoidaiGptImageResult {
  items: VoidaiGptImageItem[];
  usage?: unknown;
  model: string;
}

export interface GenerateVoidaiGptImageArgs {
  operation:   'generate' | 'edit';
  prompt:      string;
  inputImage?: string; // edit only: https URL or base64 data URL
  mask?:       string; // edit only: optional mask, https URL or base64 data URL
  size?:       string; // default '1024x1024'
  model?:      string; // default gpt-image-2
}

interface FetchedImage { buffer: Buffer; mime: string }

// Resolve an https URL or a base64 data URL to raw bytes + mime, for multipart upload.
async function fetchImageBytes(input: string): Promise<FetchedImage> {
  const dataUrl = input.match(/^data:(image\/[\w.+-]+);base64,(.+)$/i);
  if (dataUrl) {
    return { buffer: Buffer.from(dataUrl[2], 'base64'), mime: dataUrl[1].toLowerCase() };
  }
  const res = await fetch(input);
  if (!res.ok) {
    throw new Error(`Failed to fetch image (${res.status}) from ${input.slice(0, 120)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
  return { buffer, mime };
}

const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
};

function toBlobPart(img: FetchedImage): { blob: Blob; filename: string } {
  const mime = EXT_FOR_MIME[img.mime] ? img.mime : 'image/png';
  const ext = EXT_FOR_MIME[mime] ?? 'png';
  // Uint8Array copy so the Blob owns a clean ArrayBuffer (not the Node Buffer pool).
  const blob = new Blob([new Uint8Array(img.buffer)], { type: mime });
  return { blob, filename: `image.${ext}` };
}

export async function generateVoidaiGptImage(args: GenerateVoidaiGptImageArgs): Promise<VoidaiGptImageResult> {
  const apiKey  = config.voidai.apiKey;
  const baseURL = config.voidai.baseURL;
  if (!apiKey) {
    throw new Error('VOIDAI_API_KEY is not configured. Set it in .env to use voidai_gpt_image.');
  }

  const model = (args.model ?? DEFAULT_VOIDAI_GPT_IMAGE_MODEL).trim() || DEFAULT_VOIDAI_GPT_IMAGE_MODEL;
  const size  = args.size?.trim() || '1024x1024';

  // Fetch source/mask bytes once (outside the retry loop). The multipart body
  // itself is rebuilt per attempt via makeInit() — a consumed FormData/stream
  // cannot be safely re-sent on a retry.
  let url: string;
  let source: { blob: Blob; filename: string } | undefined;
  let mask: { blob: Blob; filename: string } | undefined;
  if (args.operation === 'edit') {
    if (!args.inputImage?.trim()) {
      throw new Error('operation "edit" requires input_image (an https URL or base64 data URL).');
    }
    source = toBlobPart(await fetchImageBytes(args.inputImage.trim()));
    if (args.mask?.trim()) mask = toBlobPart(await fetchImageBytes(args.mask.trim()));
    url = `${baseURL}/images/edits`;
  } else {
    url = `${baseURL}/images/generations`;
  }

  const makeInit = (signal: AbortSignal): RequestInit => {
    if (args.operation === 'edit') {
      const form = new FormData();
      form.append('image', source!.blob, source!.filename);
      if (mask) form.append('mask', mask.blob, mask.filename);
      form.append('prompt', args.prompt);
      form.append('model', model);
      form.append('size', size);
      // gpt-image models reject n / response_format (dall-e only) — omit them.
      return { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal };
    }
    return {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // gpt-image models reject n / response_format and always return b64_json.
      body: JSON.stringify({ model, prompt: args.prompt, size }),
      signal,
    };
  };

  // gpt-image is slow (15–60s/image) and its upstream 408/503-fails slowly, so
  // an unbounded retry could hang past the MCP idle timeout. Bound both a single
  // attempt (AbortController) and the total wall-clock across retries.
  const PER_ATTEMPT_TIMEOUT_MS = 120_000;
  const TOTAL_DEADLINE_MS      = 210_000;
  const startedAt = Date.now();

  let res: Response;
  let attempt = 0;
  for (;;) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PER_ATTEMPT_TIMEOUT_MS);
    let status: number | undefined;
    let detail: string;
    try {
      res = await fetch(url, makeInit(ac.signal));
      if (res.ok) { clearTimeout(timer); break; }
      status = res.status;
      detail = await res.text().catch(() => res.statusText);
    } catch (err) {
      status = undefined;
      detail = ac.signal.aborted
        ? `per-attempt timeout after ${PER_ATTEMPT_TIMEOUT_MS}ms`
        : ((err as Error).message ?? String(err));
    } finally {
      clearTimeout(timer);
    }

    const backoff = TRANSIENT_BACKOFF_MS[attempt];
    const elapsed = Date.now() - startedAt;
    const retryable = ac.signal.aborted || isTransientVoidaiError(status, detail);
    if (retryable && backoff !== undefined && elapsed + backoff < TOTAL_DEADLINE_MS) {
      await delay(backoff);
      attempt++;
      continue;
    }
    const where = status !== undefined ? String(status) : (ac.signal.aborted ? 'timeout' : 'network error');
    // Surface VoidAI's structured {error:{message}} when present.
    let msg = detail;
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } | string };
      const em = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
      if (em) msg = em;
    } catch { /* detail was not JSON */ }
    throw new Error(`VoidAI gpt-image ${args.operation} failed (${where}): ${msg.slice(0, 400)}`);
  }

  const body = await res.json() as {
    data?: Array<{ b64_json?: string; url?: string }>;
    usage?: unknown;
  };

  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`VoidAI returned no image for ${model} (${args.operation}). Response had no data[].`);
  }

  const items: VoidaiGptImageItem[] = [];
  for (const d of data) {
    if (typeof d.b64_json === 'string' && d.b64_json.length > 0) {
      items.push({ base64: d.b64_json, mime: 'image/png' });
      continue;
    }
    // Defensive: some models/configs may return a url instead of b64_json.
    if (typeof d.url === 'string') {
      const fetched = await fetchImageBytes(d.url);
      items.push({ base64: fetched.buffer.toString('base64'), mime: fetched.mime });
    }
  }

  if (items.length === 0) {
    throw new Error(`VoidAI returned data but no usable image bytes for ${model}.`);
  }

  return { items, usage: body.usage, model };
}
