// Speech-to-text. Two providers behind one transcribe() entry point:
//
// Deepgram (preferred): POST /v1/listen with raw audio bytes. Accepts ogg/opus/
// webm/wav natively so no transcode step is needed. Enabled when DEEPGRAM_API_KEY
// is set.
//
// VoidAI Whisper (fallback): OpenAI-compatible /audio/transcriptions endpoint.
// Requires multipart/form-data. Ogg inputs are remuxed to WebM first via
// transcodeForWhisper() because VoidAI's Whisper clone rejects .ogg.

import { config } from '../config';
import { transcodeForWhisper } from './transcode';
import { fetchRetry } from './retry';

export interface TranscribeRequest {
  audio:     Buffer;
  mimeType:  string;        // e.g. 'audio/webm', 'audio/mpeg', 'audio/ogg'
  filename?: string;        // hint to whisper; defaults from mime
  model?:    string;        // override model
  language?: string;        // ISO-639-1 hint, optional
  prompt?:   string;        // priming context for transcription, optional (VoidAI only)
}

export interface TranscribeResult {
  text:     string;
  model:    string;
  provider: 'deepgram' | 'voidai';
}

export async function transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
  if (!req.audio || req.audio.length === 0) throw new Error('transcribe: empty audio buffer');

  const maxBytes = config.audio.maxFileMb * 1024 * 1024;
  if (req.audio.length > maxBytes) {
    throw new Error(`transcribe: audio exceeds AUDIO_MAX_MB (${config.audio.maxFileMb} MB)`);
  }

  if (config.audio.deepgram.enabled) return transcribeDeepgram(req);
  return transcribeVoidAI(req);
}

// ── Deepgram ───────────────────────────────────────────────────────────────

async function transcribeDeepgram(req: TranscribeRequest): Promise<TranscribeResult> {
  const cfg = config.audio.deepgram;
  const model = req.model || cfg.model;

  const params = new URLSearchParams({ model, smart_format: 'true' });
  if (req.language) params.set('language', req.language);

  const res = await fetchRetry(`${cfg.baseURL}/listen?${params}`, {
    method:  'POST',
    headers: {
      'Authorization': `Token ${cfg.apiKey}`,
      'Content-Type':  req.mimeType,
    },
    body:      new Uint8Array(req.audio),
    timeoutMs: 30_000,
  });

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`transcribe (deepgram): HTTP ${res.status} ${detail}`);
  }

  type DeepgramResponse = {
    results?: { channels?: { alternatives?: { transcript: string }[] }[] };
  };
  const body = await res.json().catch(() => null) as DeepgramResponse | null;
  // null body = the 2xx response wasn't valid JSON — a real failure, not silence.
  // Distinguish it from an empty transcript (legitimate "no speech detected").
  if (body === null) throw new Error('transcribe (deepgram): response body was not valid JSON');
  const text = (body?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
  return { text, model, provider: 'deepgram' };
}

// ── VoidAI Whisper ─────────────────────────────────────────────────────────

async function transcribeVoidAI(req: TranscribeRequest): Promise<TranscribeResult> {
  const cfg = config.voidai;
  if (!cfg.apiKey) throw new Error('transcribe: VOIDAI_API_KEY is not set');

  const model = req.model || config.audio.voidai.transcribeModel;

  // VoidAI's Whisper rejects .ogg even though OpenAI's spec accepts it
  // (Discord voice messages ship as Ogg-Opus). Remux/re-encode unsupported
  // formats before upload — no-op for already-supported containers.
  const transcoded = await transcodeForWhisper(req.audio, req.mimeType, req.filename);

  // The mp3 re-encode fallback in transcodeForWhisper can grow a small,
  // highly-compressed input past the cap. Re-check after transcode so the
  // spend guard isn't defeated by a ballooned buffer.
  const maxBytes = config.audio.maxFileMb * 1024 * 1024;
  if (transcoded.buffer.length > maxBytes) {
    throw new Error(`transcribe: transcoded audio exceeds AUDIO_MAX_MB (${config.audio.maxFileMb} MB)`);
  }

  const filename = req.filename
    ? req.filename.replace(/\.[^.]+$/, '') + '.' + transcoded.ext
    : `audio.${transcoded.ext}`;

  const form = new FormData();
  const blob = new Blob([new Uint8Array(transcoded.buffer)], { type: transcoded.mimeType });
  form.append('file', blob, filename);
  form.append('model', model);
  if (req.language) form.append('language', req.language);
  if (req.prompt)   form.append('prompt',   req.prompt);
  form.append('response_format', 'json');

  const res = await fetchRetry(`${cfg.baseURL}/audio/transcriptions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
    body:    form,
    timeoutMs: 30_000,
  });

  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`transcribe (voidai): HTTP ${res.status} ${detail}`);
  }

  const body = await res.json().catch(() => null) as { text?: string } | null;
  // null body = unparseable 2xx response — a real failure, not "no speech".
  if (body === null) throw new Error('transcribe (voidai): response body was not valid JSON');
  const text = (body?.text ?? '').trim();
  return { text, model, provider: 'voidai' };
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const t = (await res.text()).slice(0, 240);
    return t || res.statusText;
  } catch {
    return res.statusText;
  }
}
