import { config } from '../config';

// Direct-API image generate/edit via VoidAI's chat-completions "image" extension,
// using Gemini "Nano-Banana" models (default gemini-3.1-flash-image). Modeled on
// the The-Code-Labz/nanobanana-studio-93 Supabase edge functions, minus the
// Supabase auth/storage/DB layer — here images are delivered via send_image_to_user.
//
// Uses a raw fetch rather than the OpenAI SDK because the request carries the
// non-standard `responseModalities` / `image_config` fields and the response
// returns images in the non-standard `choices[0].message.images[]` field, neither
// of which the SDK models.

export const DEFAULT_VOIDAI_IMAGE_MODEL = 'gemini-3.1-flash-image';

export interface VoidaiImageItem {
  base64: string;
  mime:   string; // e.g. 'image/png'
}

export interface VoidaiImageResult {
  items: VoidaiImageItem[];
  usage?: unknown;
  model: string;
}

export interface GenerateVoidaiImageArgs {
  operation:    'generate' | 'edit';
  prompt:       string;
  inputImage?:  string; // edit only: https URL or base64 data URL
  aspectRatio?: string; // default '1:1'
  resolution?:  string; // 'STANDARD' | '2K' | '4K'
  model?:       string; // default gemini-3.1-flash-image
}

const RESOLUTION_MAP: Record<string, string> = { STANDARD: '1K', '2K': '2K', '4K': '4K' };

export const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Backoff schedule for transient upstream blips (429 / 5xx / "service
// unavailable" / socket resets). The heavier VoidAI image models — notably
// gemini-3-pro-image and gpt-image-2 — return HTTP 503 "Upstream provider
// temporarily unavailable" intermittently; a short retry clears it. Permanent
// rejections (4xx that aren't 429) never clear and are surfaced immediately.
// Shared with voidai-gpt-image.ts.
export const TRANSIENT_BACKOFF_MS = [1500, 4000, 8000];

export function isTransientVoidaiError(status: number | undefined, detail: string): boolean {
  // 408 = upstream request timeout, 429 = rate limit, 5xx = upstream errors —
  // all clear on a retry. The heavier models (gpt-image-2, gemini-3-pro-image)
  // are slow enough to trip 408/503 intermittently.
  if (status === 408 || status === 429 || (typeof status === 'number' && status >= 500)) return true;
  return /temporarily unavailable|service unavailable|try again later|overloaded|over capacity|rate limit|too many requests|econnreset|socket hang ?up|request timeout|timed? ?out/i.test(detail);
}

// Fetch a remote image and inline it as a base64 data URL, as the studio edge
// function does — the VoidAI image endpoint expects a data URL for edit inputs.
async function toDataUrl(input: string): Promise<string> {
  if (input.startsWith('data:')) return input;
  const res = await fetch(input);
  if (!res.ok) {
    throw new Error(`Failed to fetch input_image (${res.status}) from ${input.slice(0, 120)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/png';
  return `data:${contentType};base64,${buf.toString('base64')}`;
}

export async function generateVoidaiImage(args: GenerateVoidaiImageArgs): Promise<VoidaiImageResult> {
  const apiKey  = config.voidai.apiKey;
  const baseURL = config.voidai.baseURL;
  if (!apiKey) {
    throw new Error('VOIDAI_API_KEY is not configured. Set it in .env to use voidai_image.');
  }

  const model     = (args.model ?? DEFAULT_VOIDAI_IMAGE_MODEL).trim() || DEFAULT_VOIDAI_IMAGE_MODEL;
  const imageSize = RESOLUTION_MAP[args.resolution ?? 'STANDARD'] ?? '1K';
  const aspect    = args.aspectRatio?.trim() || '1:1';

  let messages: unknown;
  if (args.operation === 'edit') {
    if (!args.inputImage?.trim()) {
      throw new Error('operation "edit" requires input_image (an https URL or base64 data URL).');
    }
    const dataUrl = await toDataUrl(args.inputImage.trim());
    messages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: args.prompt },
      ],
    }];
  } else {
    messages = [{ role: 'user', content: args.prompt }];
  }

  const reqBody = JSON.stringify({
    model,
    messages,
    responseModalities: ['IMAGE'],
    image_config: { aspect_ratio: aspect, image_size: imageSize },
  });

  let res: Response;
  let transientUsed = 0;
  for (;;) {
    let status: number | undefined;
    let detail: string;
    try {
      res = await fetch(`${baseURL}/chat/completions`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: reqBody,
      });
      if (res.ok) break;
      status = res.status;
      detail = await res.text().catch(() => res.statusText);
    } catch (err) {
      // Network-level failure (ECONNRESET, socket hang up, DNS) — no HTTP status.
      status = undefined;
      detail = (err as Error).message ?? String(err);
    }

    if (isTransientVoidaiError(status, detail) && transientUsed < TRANSIENT_BACKOFF_MS.length) {
      const wait = TRANSIENT_BACKOFF_MS[transientUsed];
      transientUsed++;
      await delay(wait);
      continue;
    }
    const where = status !== undefined ? String(status) : 'network error';
    throw new Error(`VoidAI image ${args.operation} failed (${where}): ${detail.slice(0, 400)}`);
  }

  const body = await res.json() as {
    choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    usage?: unknown;
  };

  const images = body.choices?.[0]?.message?.images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error(`VoidAI returned no image for ${model} (${args.operation}). Response had no message.images.`);
  }

  const items: VoidaiImageItem[] = [];
  for (const img of images) {
    const url = img?.image_url?.url;
    const match = typeof url === 'string' ? url.match(/^data:(image\/[\w.+-]+);base64,(.+)$/) : null;
    if (match) items.push({ mime: match[1], base64: match[2] });
  }

  if (items.length === 0) {
    throw new Error(`VoidAI returned images but none were parseable base64 data URLs for ${model}.`);
  }

  return { items, usage: body.usage, model };
}
