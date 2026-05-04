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

export type TtsProvider = 'voidai' | 'elevenlabs';

export interface TtsRequest {
  text:      string;
  provider?: TtsProvider;     // defaults to 'voidai'
  voiceId?:  string;          // provider-specific (alloy/echo/... or an ElevenLabs voice id)
  model?:    string;          // override default tts model
  format?:   'mp3' | 'wav' | 'opus';   // response_format hint; mp3 is universal
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

export async function synthesize(req: TtsRequest): Promise<TtsResult> {
  const text = (req.text ?? '').trim();
  if (!text) throw new Error('tts: empty text');

  const max = config.audio.maxTtsChars;
  const truncated = text.length > max ? text.slice(0, max) : text;

  const provider: TtsProvider = req.provider ?? 'voidai';
  const format = req.format ?? 'mp3';

  if (provider === 'elevenlabs') return synthesizeElevenLabs(truncated, req, format);
  return synthesizeVoidAI(truncated, req, format);
}

async function synthesizeVoidAI(
  text:   string,
  req:    TtsRequest,
  format: NonNullable<TtsRequest['format']>,
): Promise<TtsResult> {
  const cfg = config.voidai;
  if (!cfg.apiKey) throw new Error('tts: VOIDAI_API_KEY is not set');
  const voice = req.voiceId || config.audio.voidai.ttsVoice;
  const model = req.model   || config.audio.voidai.ttsModel;

  const res = await fetch(`${cfg.baseURL}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model, voice, input: text, response_format: format }),
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
  // ElevenLabs output_format takes mp3_44100_128 / pcm_16000 / etc; we only
  // expose the common cases. mp3_44100_128 is the universal default.
  const outputFormat =
    format === 'wav'  ? 'pcm_16000'
    : format === 'opus' ? 'opus_48000_64'
    : 'mp3_44100_128';

  const url = `${el.baseURL}/text-to-speech/${encodeURIComponent(voice)}?output_format=${outputFormat}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key':   el.apiKey,
      'Content-Type': 'application/json',
      'Accept':       FORMAT_MIME[format],
    },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) {
    const detail = await safeReadError(res);
    throw new Error(`tts (elevenlabs): HTTP ${res.status} ${detail}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, mimeType: FORMAT_MIME[format], provider: 'elevenlabs', voiceId: voice, model };
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const t = (await res.text()).slice(0, 240);
    return t || res.statusText;
  } catch {
    return res.statusText;
  }
}

/** Resolve TTS provider+voice for an agent record, falling back to env defaults. */
export function resolveAgentVoice(agent: { tts_provider?: string | null; tts_voice?: string | null }): { provider: TtsProvider; voiceId: string } {
  const provider: TtsProvider = agent.tts_provider === 'elevenlabs' ? 'elevenlabs' : 'voidai';
  const voiceId =
    (agent.tts_voice && agent.tts_voice.trim()) ||
    (provider === 'elevenlabs' ? config.audio.elevenlabs.defaultVoiceId : config.audio.voidai.ttsVoice);
  return { provider, voiceId };
}

export function logTtsFailure(where: string, err: unknown): void {
  logger.error(`tts: ${where}`, { err: (err as Error)?.message });
}
