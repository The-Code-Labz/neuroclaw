// Speech-to-text via VoidAI's OpenAI-compatible /audio/transcriptions endpoint
// (Whisper). Single provider for now — ElevenLabs has a separate STT product
// but we don't need a second backend until users ask for it.
//
// The endpoint takes multipart/form-data. Node 20+'s native FormData + Blob
// handle this without a `form-data` dep.

import { config } from '../config';
import { transcodeForWhisper } from './transcode';

export interface TranscribeRequest {
  audio:     Buffer;
  mimeType:  string;        // e.g. 'audio/webm', 'audio/mpeg', 'audio/ogg'
  filename?: string;        // hint to whisper; defaults from mime
  model?:    string;        // override whisper model
  language?: string;        // ISO-639-1 hint, optional
  prompt?:   string;        // priming context for transcription, optional
}

export interface TranscribeResult {
  text:  string;
  model: string;
}

export async function transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
  const cfg = config.voidai;
  if (!cfg.apiKey) throw new Error('transcribe: VOIDAI_API_KEY is not set');
  if (!req.audio || req.audio.length === 0) throw new Error('transcribe: empty audio buffer');

  const maxBytes = config.audio.maxFileMb * 1024 * 1024;
  if (req.audio.length > maxBytes) {
    throw new Error(`transcribe: audio exceeds AUDIO_MAX_MB (${config.audio.maxFileMb} MB)`);
  }

  const model = req.model || config.audio.voidai.transcribeModel;

  // VoidAI's Whisper rejects .ogg even though OpenAI's spec accepts it
  // (Discord voice messages ship as Ogg-Opus). Remux/re-encode unsupported
  // formats before upload — no-op for already-supported containers.
  const transcoded = await transcodeForWhisper(req.audio, req.mimeType, req.filename);
  const filename = req.filename
    ? req.filename.replace(/\.[^.]+$/, '') + '.' + transcoded.ext
    : `audio.${transcoded.ext}`;

  const form = new FormData();
  const blob = new Blob([new Uint8Array(transcoded.buffer)], { type: transcoded.mimeType });
  form.append('file', blob, filename);
  form.append('model', model);
  if (req.language) form.append('language', req.language);
  if (req.prompt)   form.append('prompt',   req.prompt);
  // response_format=json keeps the body small; we only need the transcript.
  form.append('response_format', 'json');

  const res = await fetch(`${cfg.baseURL}/audio/transcriptions`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
    body:    form,
  });
  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`transcribe: HTTP ${res.status} ${detail}`);
  }

  const body = await res.json().catch(() => null) as { text?: string } | null;
  const text = (body?.text ?? '').trim();
  return { text, model };
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const t = (await res.text()).slice(0, 240);
    return t || res.statusText;
  } catch {
    return res.statusText;
  }
}
