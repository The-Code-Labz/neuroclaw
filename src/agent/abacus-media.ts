import { getAbacusClient } from './abacus-client';
import { logger } from '../utils/logger';

// ── Abacus media generation helper ──────────────────────────────────────────
// Abacus AI (RouteLLM) serves ALL media through the SAME /v1/chat/completions
// endpoint as text — there are no /v1/images or /v1/audio routes (they 404).
// The `modalities` param switches the endpoint into media mode; without it a
// media model id is rejected. Output comes back on `choices[0].message.images[]`
// (each `{type:'image_url', image_url:{url}}`, url = base64 data URL OR hosted
// URL). Metered in `usage.compute_points_used`. Verified live 2026-06-20.

export interface AbacusMediaItem {
  /** Hosted https URL, when the model returned one. */
  url?:    string;
  /** Raw base64 (data: prefix stripped), when the model returned inline bytes. */
  base64?: string;
  mime:    string;
}

export interface AbacusMediaResult {
  items:         AbacusMediaItem[];
  computePoints: number;
  model:         string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw:           any;
}

export interface AbacusMediaRequest {
  model:        string;
  prompt:       string;
  modalities:   string[];                       // ['image'] | ['text','audio'] | ['video'] ...
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  imageConfig?: Record<string, any>;            // num_images, aspect_ratio, quality, resolution, mode...
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  audio?:       Record<string, any>;            // { voice, format } for TTS
  /** Input image (base64 data URL or https URL) for edit/upscale — sent as an
   *  image_url content part in the user message. */
  inputImage?:  string;
  timeoutMs?:   number;
}

// Sniff the real image type from a base64 payload's leading bytes — Abacus
// sometimes mislabels the data: mime (e.g. flux_pro tags JPEG bytes as
// image/png), which would save with the wrong extension.
function sniffImageMime(b64: string, fallback: string): string {
  if (b64.startsWith('/9j/'))       return 'image/jpeg';
  if (b64.startsWith('iVBORw0KGg')) return 'image/png';
  if (b64.startsWith('R0lGOD'))     return 'image/gif';
  if (b64.startsWith('UklGR'))      return 'image/webp';
  return fallback;
}

function parseDataUrl(url: string): { base64?: string; url?: string; mime: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (m) {
    const declared = m[1] || 'application/octet-stream';
    const mime = declared.startsWith('image/') ? sniffImageMime(m[2], declared) : declared;
    return { base64: m[2], mime };
  }
  // Hosted URL — best-effort mime from extension.
  const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  const extMime: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus',
  };
  return { url, mime: extMime[ext] ?? 'application/octet-stream' };
}

/**
 * Extracts media items from an Abacus chat/completions response. Handles the
 * confirmed `message.images[]` shape and is defensive about video/audio that
 * may land on alternative fields (message.audio, message.video, content url).
 */
// Map an Abacus `format` string to a mime type. L16/pcm stay flagged as raw
// PCM so the caller knows to wrap them in a WAV container before serving.
function audioMime(format: string | undefined): string {
  const f = String(format ?? 'mp3').toLowerCase();
  if (f === 'mp3' || f === 'mpeg') return 'audio/mpeg';
  if (f === 'wav')                 return 'audio/wav';
  if (f === 'l16' || f === 'pcm')  return 'audio/L16';
  if (f === 'opus')                return 'audio/opus';
  if (f === 'ogg')                 return 'audio/ogg';
  return `audio/${f}`;
}

// Extracts media items from an Abacus chat/completions response. Verified shapes:
// image → message.images[].image_url.url ; audio → message.audios[].{data,format}.
// videos[] is handled by symmetry (unverified — Abacus video is the open risk).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractItems(message: any): AbacusMediaItem[] {
  const out: AbacusMediaItem[] = [];
  const pushUrl = (url: string | undefined, mimeHint?: string) => {
    if (!url || typeof url !== 'string') return;
    const p = parseDataUrl(url);
    out.push({ url: p.url, base64: p.base64, mime: mimeHint ?? p.mime });
  };

  // Images (verified): message.images[].image_url.url (base64 data URL or https).
  if (Array.isArray(message?.images)) {
    for (const img of message.images) pushUrl(img?.image_url?.url ?? img?.url);
  }
  // Audio (verified): message.audios[].{data(base64), format}.
  if (Array.isArray(message?.audios)) {
    for (const a of message.audios) {
      if (a?.data) out.push({ base64: String(a.data), mime: audioMime(a.format) });
      else if (a?.image_url?.url ?? a?.url) pushUrl(a?.image_url?.url ?? a?.url);
    }
  }
  // Video (by symmetry — unverified): message.videos[] of {data|url} or a video field.
  if (Array.isArray(message?.videos)) {
    for (const v of message.videos) {
      if (v?.data) out.push({ base64: String(v.data), mime: `video/${(v.format ?? 'mp4')}` });
      else pushUrl(v?.video_url?.url ?? v?.image_url?.url ?? v?.url, 'video/mp4');
    }
  }
  if (message?.video?.url) pushUrl(message.video.url, 'video/mp4');
  // Last resort: a media URL embedded in the text content.
  if (out.length === 0 && typeof message?.content === 'string') {
    const urlMatch = message.content.match(/https?:\/\/\S+\.(png|jpg|jpeg|webp|gif|mp4|webm|mov|mp3|wav|ogg)\b/i);
    if (urlMatch) pushUrl(urlMatch[0]);
  }
  return out;
}

/** Wrap raw little-endian PCM bytes in a minimal WAV (RIFF) container. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate   = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM fmt chunk size
  header.writeUInt16LE(1, 20);           // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// image_config params are NOT uniform across Abacus models — flux_pro rejects
// `aspect_ratio` (wants `size`), flux2_pro only accepts enum aspect values like
// `square_hd`, while nano_banana2/imagen accept `aspect_ratio` directly. Rather
// than hard-code a per-model param matrix that drifts as Abacus adds models, we
// degrade gracefully: when the API 400s naming a specific config param, strip
// that one param and retry. (Input images for edit/upscale ride in the message
// as an image_url content part — see below — not in image_config, so they're
// never at risk here.)
const PROTECTED_IMAGE_CONFIG_KEYS = new Set<string>();

// Pull the offending image_config key out of an Abacus 400 message. Covers both
// observed shapes: "Invalid image config param <key> provided" and
// "Invalid <key> for <model>: <value>. Supported values are: …".
function offendingConfigKey(msg: string, present: string[]): string | undefined {
  const m1 = /invalid image config param[:\s]+([a-z0-9_]+)/i.exec(msg);
  if (m1 && present.includes(m1[1])) return m1[1];
  const m2 = /invalid\s+([a-z0-9_]+)\s+for\s+\S+/i.exec(msg);
  if (m2 && present.includes(m2[1])) return m2[1];
  return undefined;
}

const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

// Classify an Abacus error as a transient generation hiccup worth retrying.
// The non-flux image models intermittently return model-side capacity blips
// ("There was a temporary error while generating the image. Please try again.",
// nano_banana2's "An error occurred… Please try again later.", 429s, 5xx) that
// clear on a simple retry. flux_pro is the default and gets hammered, so it
// rarely trips this — which is exactly why it looked like "only flux works"
// while other models failed on first use. We must NOT retry permanent rejections
// (unknown/invalid param, unsupported model) — those never clear — nor the SDK's
// client-side "Request timed out" (a slow model; a retry just re-incurs the full
// timeout, so surface it so the caller can pick a faster model).
function isTransientAbacusError(msg: string, status?: number): boolean {
  if (/unknown parameter|invalid model|supported values are|invalid image config param|invalid \w+ for /i.test(msg)) return false;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  return /temporary error|please try again|try again later|overloaded|over capacity|rate limit|too many requests|service unavailable|econnreset|socket hang ?up/i.test(msg);
}

export async function generateAbacusMedia(req: AbacusMediaRequest): Promise<AbacusMediaResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = {
    model:      req.model,
    // Edit/upscale models require the source image as an OpenAI-standard
    // multimodal image_url content part in the message. Passing it via
    // image_config (image_prompt/images) is rejected with a 400 "Invalid
    // configuration found for generation image" across every edit model.
    messages:   [{
      role: 'user',
      content: req.inputImage
        ? [
            { type: 'text',      text: req.prompt },
            { type: 'image_url', image_url: { url: req.inputImage } },
          ]
        : req.prompt,
    }],
    modalities: req.modalities,
  };
  if (req.imageConfig) body.image_config = { ...req.imageConfig };
  if (req.audio) body.audio = req.audio;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resp: any;
  // Two independent retry budgets that don't compete:
  //  • strip budget — one attempt per strippable image_config key (param errors)
  //  • transient budget — a couple of backoff retries for model-side capacity blips
  const stripBudget = Object.keys(body.image_config ?? {})
    .filter(k => !PROTECTED_IMAGE_CONFIG_KEYS.has(k)).length;
  const TRANSIENT_BACKOFF_MS = [1500, 4000];
  let stripsUsed = 0;
  let transientUsed = 0;
  for (;;) {
    try {
      resp = await getAbacusClient().chat.completions.create(body, {
        timeout: req.timeoutMs ?? 180_000,
      });
      break;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (err as any)?.status as number | undefined;
      const present = Object.keys(body.image_config ?? {}).filter(k => !PROTECTED_IMAGE_CONFIG_KEYS.has(k));
      const bad = /\b400\b/.test(msg) ? offendingConfigKey(msg, present) : undefined;
      if (bad && stripsUsed < stripBudget) {
        stripsUsed++;
        logger.warn('abacus-media: stripping unsupported image_config param and retrying', { model: req.model, param: bad });
        delete body.image_config[bad];
        continue;
      }
      if (isTransientAbacusError(msg, status) && transientUsed < TRANSIENT_BACKOFF_MS.length) {
        const wait = TRANSIENT_BACKOFF_MS[transientUsed];
        transientUsed++;
        logger.warn('abacus-media: transient error, retrying after backoff', { model: req.model, attempt: transientUsed, waitMs: wait, error: msg.slice(0, 120) });
        await delay(wait);
        continue;
      }
      throw new Error(`Abacus media request failed (${req.model}): ${msg.slice(0, 240)}`);
    }
  }

  // Abacus signals model/param errors with a {success:false,error} payload.
  if (resp?.success === false || (resp?.error && !resp?.choices)) {
    throw new Error(`Abacus rejected the request (${req.model}): ${String(resp.error).slice(0, 240)}`);
  }

  const message = resp?.choices?.[0]?.message;
  const items   = extractItems(message);
  const computePoints = Number(resp?.usage?.compute_points_used ?? 0);

  if (items.length === 0) {
    logger.warn('abacus-media: no media in response', { model: req.model, keys: Object.keys(message ?? {}) });
    throw new Error(`Abacus returned no media for ${req.model} (modalities=${req.modalities.join(',')}). It may be async or need different params.`);
  }
  return { items, computePoints, model: req.model, raw: resp };
}
