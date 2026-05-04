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

/** Return the picker payload for both providers in a single call (used by /api/audio/voices). */
export async function listAllVoices(): Promise<{ voidai: VoiceOption[]; elevenlabs: VoiceOption[]; elevenlabsAvailable: boolean }> {
  const elevenAvailable = config.audio.elevenlabs.enabled;
  const elevenlabs = elevenAvailable ? await listElevenLabsVoices().catch(() => [] as VoiceOption[]) : [];
  return {
    voidai:              listVoidAIVoices(),
    elevenlabs,
    elevenlabsAvailable: elevenAvailable,
  };
}
