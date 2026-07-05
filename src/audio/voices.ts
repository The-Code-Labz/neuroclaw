// Voice catalog for the dashboard picker.
//
// VoidAI: the OpenAI TTS voices are a fixed enum (no /voices endpoint), so
// they're hardcoded here.
//
// ElevenLabs: GET /v1/voices returns the user's full library (premade +
// cloned). Cached for 5 minutes to keep the picker snappy without hammering
// the API every time the agents page mounts.

import { config } from '../config';

export interface VoiceOption {
  id:       string;
  name:     string;
  // Optional metadata for the UI (preview URL, language, gender) — we surface
  // whatever the provider returns but always include id+name as the contract.
  preview?: string | null;
  labels?:  Record<string, string>;
}

const VOIDAI_VOICES: VoiceOption[] = [
  { id: 'alloy',   name: 'Alloy'   },
  { id: 'echo',    name: 'Echo'    },
  { id: 'fable',   name: 'Fable'   },
  { id: 'onyx',    name: 'Onyx'    },
  { id: 'nova',    name: 'Nova'    },
  { id: 'shimmer', name: 'Shimmer' },
];

export function listVoidAIVoices(): VoiceOption[] {
  return VOIDAI_VOICES;
}

interface ElevenCacheEntry {
  fetchedAt: number;
  voices:    VoiceOption[];
}

const ELEVEN_CACHE_TTL_MS = 5 * 60 * 1000;
let elevenCache: ElevenCacheEntry | null = null;

export async function listElevenLabsVoices(force = false): Promise<VoiceOption[]> {
  const el = config.audio.elevenlabs;
  if (!el.enabled) return [];

  const now = Date.now();
  if (!force && elevenCache && now - elevenCache.fetchedAt < ELEVEN_CACHE_TTL_MS) {
    return elevenCache.voices;
  }

  const res = await fetch(`${el.baseURL}/voices`, {
    headers: { 'xi-api-key': el.apiKey, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    // Fall back to the cached list if we have one — better than crashing the picker.
    if (elevenCache) return elevenCache.voices;
    throw new Error(`elevenlabs voices: HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null) as { voices?: Array<{ voice_id: string; name: string; preview_url?: string; labels?: Record<string, string> }> } | null;
  const voices: VoiceOption[] = (body?.voices ?? []).map(v => ({
    id:      v.voice_id,
    name:    v.name,
    preview: v.preview_url ?? null,
    labels:  v.labels,
  }));
  elevenCache = { fetchedAt: now, voices };
  return voices;
}

let kokoroCache:      { fetchedAt: number; voices: VoiceOption[] } | null = null;
let chatterboxCache:  { fetchedAt: number; voices: VoiceOption[] } | null = null;

export async function listKokoroVoices(force = false): Promise<VoiceOption[]> {
  const k = config.audio.kokoro;
  if (!k.enabled) return [];

  const now = Date.now();
  if (!force && kokoroCache && now - kokoroCache.fetchedAt < ELEVEN_CACHE_TTL_MS) {
    return kokoroCache.voices;
  }

  const res = await fetch(`${k.baseURL}/audio/voices`, {
    headers: { 'Authorization': `Bearer ${k.apiKey}`, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    if (kokoroCache) return kokoroCache.voices;
    throw new Error(`kokoro voices: HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null) as { voices?: Array<{ id: string; name: string }> } | null;
  const voices: VoiceOption[] = (body?.voices ?? []).map((v) => ({
    id:   v.id,
    name: v.name,
  }));
  kokoroCache = { fetchedAt: now, voices };
  return voices;
}

// Chatterbox TTS — internal service. Voice profiles are user-uploaded and
// managed via POST/PATCH/DELETE /api/voices. The listing is cached the same
// as ElevenLabs (5 min TTL) to keep the dashboard picker snappy.
export async function listChatterboxVoices(force = false): Promise<VoiceOption[]> {
  const cb = config.audio.chatterbox;
  if (!cb.enabled) return [];

  const now = Date.now();
  if (!force && chatterboxCache && now - chatterboxCache.fetchedAt < ELEVEN_CACHE_TTL_MS) {
    return chatterboxCache.voices;
  }

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (cb.apiKey) headers['Authorization'] = `Bearer ${cb.apiKey}`;

  const res = await fetch(`${cb.baseURL}/api/voices`, { headers });
  if (!res.ok) {
    if (chatterboxCache) return chatterboxCache.voices;
    throw new Error(`chatterbox voices: HTTP ${res.status}`);
  }

  // Response schema is undocumented — handle both array and {voices:[]} shapes.
  const body = await res.json().catch(() => null) as
    | Array<{ name?: string; display_name?: string; voice_name?: string }>
    | { voices?: Array<{ name?: string; display_name?: string; voice_name?: string }> }
    | null;

  const rawList = Array.isArray(body) ? body : (body as { voices?: typeof body })?.voices ?? [];
  const voices: VoiceOption[] = (rawList as Array<{ name?: string; display_name?: string; voice_name?: string }>)
    .map(v => ({
      id:   v.name ?? v.voice_name ?? '',
      name: v.display_name ?? v.name ?? v.voice_name ?? '',
    }))
    .filter(v => v.id);

  chatterboxCache = { fetchedAt: now, voices };
  return voices;
}

/** Return the picker payload for all providers in a single call (used by /api/audio/voices). */
export async function listAllVoices(): Promise<{
  voidai: VoiceOption[];
  elevenlabs: VoiceOption[];
  kokoro: VoiceOption[];
  chatterbox: VoiceOption[];
  elevenlabsAvailable: boolean;
  kokoroAvailable: boolean;
  chatterboxAvailable: boolean;
}> {
  const elevenAvailable      = config.audio.elevenlabs.enabled;
  const kokoroAvailable      = config.audio.kokoro.enabled;
  const chatterboxAvailable  = config.audio.chatterbox.enabled;
  const [ elevenlabs, kokoro, chatterbox ] = await Promise.all([
    elevenAvailable     ? listElevenLabsVoices().catch(() => [] as VoiceOption[])   : Promise.resolve([] as VoiceOption[]),
    kokoroAvailable     ? listKokoroVoices().catch(() => [] as VoiceOption[])       : Promise.resolve([] as VoiceOption[]),
    chatterboxAvailable ? listChatterboxVoices().catch(() => [] as VoiceOption[])   : Promise.resolve([] as VoiceOption[]),
  ]);
  return {
    voidai:              listVoidAIVoices(),
    elevenlabs,
    kokoro,
    chatterbox,
    elevenlabsAvailable:  elevenAvailable,
    kokoroAvailable:      kokoroAvailable,
    chatterboxAvailable:  chatterboxAvailable,
  };
}
