// Text-to-speech. Two providers behind one synthesize() entry point so callers
// (dashboard /api/audio/speak, Discord bot reply path) don't have to know which
// backend an agent is configured for.
//
// VoidAI: OpenAI-compatible POST /audio/speech. Returns audio bytes directly
// in the response body; mime defaults to audio/mpeg unless `response_format`
// is overridden.
//
// ElevenLabs: POST /text-to-speech/{voice_id}. Auth via xi-api-key header.
// Default model is eleven_turbo_v2_5 — cheap and fast; swap to a higher-fidelity
// model via ELEVENLABS_MODEL when quality matters more than latency.

import { config } from '../config';
import { logger } from '../utils/logger';
import { fetchRetry } from './retry';
import { pcmToWav } from '../agent/abacus-media';

export type TtsProvider = 'voidai' | 'elevenlabs' | 'hermes' | 'kokoro' | 'chatterbox';

export interface TtsRequest {
  text:       string;
  provider?:  TtsProvider;     // defaults to 'voidai'
  voiceId?:   string;          // provider-specific (alloy/echo/... or an ElevenLabs voice id)
  model?:     string;          // override default tts model
  format?:    'mp3' | 'wav' | 'opus';   // response_format hint; mp3 is universal
  agentName?: string;          // forwarded to TTS normalizer for per-agent profile lookup
}

export interface TtsResult {
  buffer:   Buffer;
  mimeType: string;           // 'audio/mpeg' | 'audio/wav' | 'audio/ogg'
  provider: TtsProvider;
  voiceId:  string;
  model:    string;
}

const FORMAT_MIME: Record<NonNullable<TtsRequest['format']>, string> = {
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  opus: 'audio/ogg',
};

async function maybeNormalize(text: string, agentName?: string): Promise<string> {
  const url = process.env.TTS_NORMALIZER_URL;
  if (!url) return text;
  try {
    const res = await fetch(`${url}/normalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No `mode` — normalizer resolves from agent profile. Never hardcode 'mixed'
      // here; that would force LLM assist on every call and bypass per-agent settings.
      body: JSON.stringify({ text, agent: agentName }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return text;
    const data = await res.json() as { normalized?: string };
    return data.normalized ?? text;
  } catch {
    return text;
  }
}

export async function synthesize(req: TtsRequest): Promise<TtsResult> {
  const text = (req.text ?? '').trim();
  if (!text) throw new Error('tts: empty text');

  const max = config.audio.maxTtsChars;
  const truncated = text.length > max ? text.slice(0, max) : text;

  const normalized = await maybeNormalize(truncated, req.agentName);
  // Normalization can EXPAND text (e.g. "$5" → "five dollars", abbreviation
  // expansion), so re-clamp to the cap. Without this, a near-cap input can be
  // pushed back over maxTtsChars and reach the provider (cost / HTTP 413 risk).
  const finalText = normalized.length > max ? normalized.slice(0, max) : normalized;

  const provider: TtsProvider = req.provider ?? 'voidai';
  const format = req.format ?? 'mp3';

  if (provider === 'elevenlabs') return synthesizeElevenLabs(finalText, req, format);
  if (provider === 'hermes')     return synthesizeHermes(finalText, req, format);
  if (provider === 'kokoro')     return synthesizeKokoro(finalText, req, format);
  if (provider === 'chatterbox') return synthesizeChatterbox(finalText, req, format);
  return synthesizeVoidAI(finalText, req, format);
}

async function synthesizeVoidAI(
  text:   string,
  req:    TtsRequest,
  format: NonNullable<TtsRequest['format']>,
): Promise<TtsResult> {
  const cfg   = config.voidai;
  if (!cfg.apiKey) throw new Error('tts: VOIDAI_API_KEY is not set');
  const voice = req.voiceId || config.audio.voidai.ttsVoice;
  const model = req.model   || config.audio.voidai.ttsModel;

  const res = await fetchRetry(`${cfg.baseURL}/audio/speech`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type':  'application/json',
    },
    body:      JSON.stringify({ model, voice, input: text, response_format: format }),
    timeoutMs: 30_000,
  });

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`tts (voidai): HTTP ${res.status} ${detail}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, mimeType: FORMAT_MIME[format], provider: 'voidai', voiceId: voice, model };
}

async function synthesizeElevenLabs(
  text:   string,
  req:    TtsRequest,
  format: NonNullable<TtsRequest['format']>,
): Promise<TtsResult> {
  const el = config.audio.elevenlabs;
  if (!el.enabled) throw new Error('tts: ELEVENLABS_API_KEY is not set');
  const voice = req.voiceId || el.defaultVoiceId;
  if (!voice) throw new Error('tts: no ElevenLabs voice id (set agent tts_voice or ELEVENLABS_DEFAULT_VOICE_ID)');
  const model = req.model || el.model;
  const outputFormat =
    format === 'wav'   ? 'pcm_16000'
    : format === 'opus' ? 'opus_48000_64'
    : 'mp3_44100_128';

  const url = `${el.baseURL}/text-to-speech/${encodeURIComponent(voice)}?output_format=${outputFormat}`;

  const res = await fetchRetry(url, {
    method:  'POST',
    headers: {
      'xi-api-key':   el.apiKey,
      'Content-Type': 'application/json',
      'Accept':       FORMAT_MIME[format],
    },
    body:      JSON.stringify({ text, model_id: model }),
    timeoutMs: 30_000,
  });

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`tts (elevenlabs): HTTP ${res.status} ${detail}`);
  }
  const raw = Buffer.from(await res.arrayBuffer());
  // ElevenLabs has no WAV container output — `wav` is requested as pcm_16000
  // (headerless 16 kHz / mono / 16-bit raw PCM). Wrap it in a RIFF header so the
  // 'audio/wav' mime is truthful; otherwise consumers (<audio>, Discord) play
  // raw PCM as static.
  const buf = format === 'wav' ? pcmToWav(raw, 16000, 1, 16) : raw;
  return { buffer: buf, mimeType: FORMAT_MIME[format], provider: 'elevenlabs', voiceId: voice, model };
}

async function synthesizeHermes(
  text:   string,
  req:    TtsRequest,
  format: NonNullable<TtsRequest['format']>,
): Promise<TtsResult> {
  const proxyUrl = config.hermes.proxyUrl;
  if (!proxyUrl) throw new Error('tts: HERMES_PROXY_URL is not set (Hermes TTS unavailable)');
  const voice    = req.voiceId || config.audio.hermes.ttsVoice;
  const model    = req.model   || 'tts-1';

  const res = await fetchRetry(`${proxyUrl}/tts`, {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer hermes-proxy',
      'Content-Type':  'application/json',
    },
    body:      JSON.stringify({ model, voice, input: text }),
    timeoutMs: 30_000,
  });

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`tts (hermes): HTTP ${res.status} ${detail}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, mimeType: FORMAT_MIME[format], provider: 'hermes', voiceId: voice, model };
}

async function synthesizeKokoro(
  text:   string,
  req:    TtsRequest,
  format: NonNullable<TtsRequest['format']>,
): Promise<TtsResult> {
  const k = config.audio.kokoro;
  if (!k.enabled) throw new Error('tts: KOKORO_API_KEY is not set');
  const voice = req.voiceId || k.defaultVoiceId;
  const model = req.model   || k.model;

  const res = await fetchRetry(`${k.baseURL}/audio/speech`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${k.apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: format,
      stream: false, // buffer full response for Discord/dashboard attachment
    }),
    timeoutMs: 60_000,
  });

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`tts (kokoro): HTTP ${res.status} ${detail}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, mimeType: FORMAT_MIME[format], provider: 'kokoro', voiceId: voice, model };
}

// ── Chatterbox concurrency gate ────────────────────────────────────────────
// Chatterbox generates audio in real time (up to 120s per request). Running
// multiple requests concurrently overwhelms the service. The semaphore limits
// in-flight calls to 1 and queues the rest in FIFO order.
//
// All callers (job worker ticks, Discord voice path, dashboard /api/audio/speak)
// share this module-level instance because the whole app is one Node.js process.
class AsyncSemaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  /** Number of callers waiting for the slot (excludes the active caller). */
  get queueDepth(): number { return this.queue.length; }

  /** Number of callers currently holding the slot (0 or 1 for limit=1). */
  get activeCount(): number { return this.active; }

  acquire(timeoutMs?: number): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = () => { this.active++; if (timer) clearTimeout(timer); resolve(); };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(new Error(`AsyncSemaphore: acquire timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.queue.push(entry);
    });
  }

  release(): void {
    if (this.active <= 0) return; // defensive: ignore spurious double-release
    this.active--;
    this.queue.shift()?.();
  }
}

const chatterboxSem = new AsyncSemaphore(1);

// Chatterbox TTS — internal service at chatterbox.internal.your-domain.com.
// Two-step synthesis: POST /api/generate → JSON with audio URL → GET audio bytes.
// No API key required for the internal instance; CHATTERBOX_API_KEY is optional
// for deployments that add bearer auth in front of the service.
//
// Key differences from other providers:
//  • Two-step: generate then fetch audio (not direct streaming bytes)
//  • Extra creative controls: exaggeration, cfg_weight, seed, model_type
//  • No response_format selection — returns whatever the model produces (usually WAV)
//  • Timeout is higher (120s) because the model generates in real time
async function synthesizeChatterbox(
  text:   string,
  req:    TtsRequest,
  format: NonNullable<TtsRequest['format']>,
): Promise<TtsResult> {
  const cb = config.audio.chatterbox;
  if (!cb.enabled) throw new Error('tts: Chatterbox is disabled (set CHATTERBOX_ENABLED=true)');

  // Chatterbox hard-limits text to 5000 characters regardless of the global
  // AUDIO_MAX_TTS_CHARS setting. Clamp here so we never send a payload that
  // will deterministically fail with HTTP 422.
  const CHATTERBOX_MAX_CHARS = 5000;
  let safeText = text;
  if (text.length > CHATTERBOX_MAX_CHARS) {
    logger.warn('tts (chatterbox): text truncated to 5000 chars', { original: text.length });
    safeText = text.slice(0, CHATTERBOX_MAX_CHARS);
  }

  // Log when a caller has to wait. activeCount > 0 means the slot is held,
  // so this caller will enter the queue. queueDepth is pre-enqueue (callers
  // already waiting before this one), so the actual queue after enqueue is
  // queueDepth + 1.
  if (chatterboxSem.activeCount > 0) {
    logger.info('tts (chatterbox): semaphore busy, queued', { depth: chatterboxSem.queueDepth + 1 });
  }
  await chatterboxSem.acquire(600_000);  // 10 min max queue wait; fail-safe if release() is never called
  try {
    const voiceKey  = req.voiceId?.trim() || cb.defaultVoice || undefined;
    const modelType = req.model?.trim()   || cb.modelType;

    // ── Step 1: generate ──────────────────────────────────────────────────
    const genBody: Record<string, unknown> = {
      text: safeText,
      model_type:  modelType,
      exaggeration: cb.exaggeration,
      cfg_weight:   cb.cfgWeight,
      seed:         0,
    };
    if (voiceKey) genBody.voice_key = voiceKey;

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (cb.apiKey) headers['Authorization'] = `Bearer ${cb.apiKey}`;

    const genRes = await fetchRetry(`${cb.baseURL}/api/generate`, {
      method:    'POST',
      headers,
      body:      JSON.stringify(genBody),
      timeoutMs: 120_000,  // model generates in real time — give it room
    }, 1);  // no retries — generation is not idempotent; job-worker handles retry

    if (!genRes.ok) {
      const detail = await safeReadError(genRes);
      throw new Error(`tts (chatterbox): generate HTTP ${genRes.status} ${detail}`);
    }

    const genJson = await genRes.json().catch(() => null) as Record<string, unknown> | null;
    if (!genJson) throw new Error('tts (chatterbox): generate returned non-JSON body');

    // ── Step 2: fetch audio ───────────────────────────────────────────────
    // The response schema is undocumented — try common field names in priority order.
    const rawUrl =
      (genJson.audio_url   as string | undefined) ||
      (genJson.url         as string | undefined) ||
      (genJson.file_url    as string | undefined);

    let audioUrl: string;
    if (rawUrl) {
      // Relative paths are relative to the service root (e.g. "/api/audio/abc.wav").
      audioUrl = rawUrl.startsWith('http') ? rawUrl : `${cb.baseURL}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
    } else {
      // Fall back to constructing the URL from the filename / generation_id field.
      const filename =
        (genJson.filename      as string | undefined) ||
        (genJson.generation_id as string | undefined);
      if (!filename) throw new Error('tts (chatterbox): generate response missing audio URL or filename field');
      audioUrl = `${cb.baseURL}/api/audio/${encodeURIComponent(filename)}`;
    }

    const fetchHeaders: Record<string, string> = {};
    if (cb.apiKey) fetchHeaders['Authorization'] = `Bearer ${cb.apiKey}`;

    const audioRes = await fetchRetry(audioUrl, { headers: fetchHeaders, timeoutMs: 30_000 });
    if (!audioRes.ok) {
      const detail = await safeReadError(audioRes);
      throw new Error(`tts (chatterbox): audio fetch HTTP ${audioRes.status} ${detail}`);
    }

    const buf = Buffer.from(await audioRes.arrayBuffer());

    // Detect mime type from Content-Type; fall back to caller's requested format.
    const ct = audioRes.headers.get('content-type') ?? '';
    const mimeType =
      ct.includes('wav')  ? 'audio/wav'
      : ct.includes('ogg')  ? 'audio/ogg'
      : ct.includes('mpeg') || ct.includes('mp3') ? 'audio/mpeg'
      : FORMAT_MIME[format];

    return { buffer: buf, mimeType, provider: 'chatterbox', voiceId: voiceKey ?? '', model: modelType };
  } finally {
    chatterboxSem.release();
  }
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const t = (await res.text()).slice(0, 240);
    return t || res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * Split text into chunks that fit within maxChars, breaking at sentence
 * boundaries where possible. Used by enqueue sites to avoid single-job
 * timeouts on long replies.
 */
export function chunkTextForTts(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const lastBoundary = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('.\n'),
      window.lastIndexOf('!\n'),
      window.lastIndexOf('?\n'),
    );

    const cutAt = lastBoundary > 0 ? lastBoundary + 2 : maxChars;
    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks.filter(c => c.length > 0);
}

/** Resolve TTS provider+voice for an agent record, falling back to env defaults. */
export function resolveAgentVoice(agent: { tts_provider?: string | null; tts_voice?: string | null }): { provider: TtsProvider; voiceId: string } {
  const raw = agent.tts_provider;
  const KNOWN: TtsProvider[] = ['voidai', 'elevenlabs', 'hermes', 'kokoro', 'chatterbox'];
  // Surface misconfiguration: a non-empty provider string we don't recognise
  // (e.g. a typo like '11labs') silently falls through to voidai below, which
  // otherwise masks the error with the wrong voice.
  if (raw && raw.trim() && !KNOWN.includes(raw as TtsProvider)) {
    logger.warn('tts: unrecognised tts_provider, defaulting to voidai', { tts_provider: raw });
  }
  const provider: TtsProvider =
    raw === 'elevenlabs'  ? 'elevenlabs'
    : raw === 'hermes'    ? 'hermes'
    : raw === 'kokoro'    ? 'kokoro'
    : raw === 'chatterbox' ? 'chatterbox'
    : 'voidai';
  const voiceId =
    (agent.tts_voice && agent.tts_voice.trim()) ||
    (provider === 'elevenlabs'  ? config.audio.elevenlabs.defaultVoiceId
    : provider === 'hermes'     ? config.audio.hermes.ttsVoice
    : provider === 'kokoro'     ? config.audio.kokoro.defaultVoiceId
    : provider === 'chatterbox' ? config.audio.chatterbox.defaultVoice
    : config.audio.voidai.ttsVoice);
  return { provider, voiceId };
}

export function logTtsFailure(where: string, err: unknown): void {
  logger.error(`tts: ${where}`, { err: (err as Error)?.message });
}
