import { getDb, logAudit } from '../db';
import { getClient } from '../agent/openai-client';
import { getOpenRouterClient } from '../agent/openrouter-client';
import { getAbacusClient } from '../agent/abacus-client';
import { getAnthropicClient } from '../agent/anthropic-client';
import { ANTIGRAVITY_MODELS, MODEL_DISPLAY_NAMES, fetchAntigravityModels, slugifyAntigravityModel } from '../providers/antigravity';
import { config } from '../config';
import { logger } from '../utils/logger';

// Live model catalog. Refreshed hourly from each provider's /v1/models endpoint
// (when available) or seeded from a hardcoded list. Tier is auto-classified by
// name pattern unless the user has explicitly pinned an override.

export type ModelTier = 'low' | 'mid' | 'high';
export const MODEL_PROVIDERS = ['voidai', 'anthropic', 'codex', 'antigravity', 'openrouter', 'ollama', 'kimi', 'minimax', 'claude-interactive', 'litellm', 'claude-gateway', 'abacus', 'omniroute'] as const;
export type ModelProvider = typeof MODEL_PROVIDERS[number];

export interface ModelCatalogRow {
  id:                  string;
  provider:            string;
  model_id:            string;
  tier:                ModelTier;
  tier_overridden:     number;
  context_window:      number | null;
  is_available:        number;
  last_seen_at:        string | null;
  created_at:          string;
  updated_at:          string;
  cost_per_1k_input:   number | null;
  cost_per_1k_output:  number | null;
  price_overridden:    number;
  chat_capable:        number;
  media_type:          string | null;   // 'image'|'video'|'audio'|null(chat)
}

// Per-model metadata a provider refresh can attach (overrides name-based
// inference). Set from the provider's /v1/models listing (e.g. Abacus model_type).
export interface ModelMeta {
  chatCapable?: boolean;
  mediaType?:   'image' | 'video' | 'audio' | null;
  tier?:        ModelTier;
}

// ── Known prices (USD per 1K tokens) ────────────────────────────────────────
// Patterns checked in order; first match wins. Update when new models ship.

interface PriceEntry { pattern: RegExp; input: number; output: number }

const KNOWN_PRICES: PriceEntry[] = [
  // Anthropic
  { pattern: /opus-4/i,         input: 15.00, output: 75.00 },
  { pattern: /opus-3/i,         input: 15.00, output: 75.00 },
  { pattern: /sonnet-4/i,       input:  3.00, output: 15.00 },
  { pattern: /sonnet-3-?7/i,    input:  3.00, output: 15.00 },
  { pattern: /sonnet-3-?5/i,    input:  3.00, output: 15.00 },
  { pattern: /sonnet/i,         input:  3.00, output: 15.00 },
  { pattern: /haiku-4/i,        input:  1.00, output:  5.00 },
  { pattern: /haiku-3-?5/i,     input:  0.80, output:  4.00 },
  { pattern: /haiku/i,          input:  0.25, output:  1.25 },
  // OpenAI
  { pattern: /^gpt-5\.1/i,      input: 10.00, output: 30.00 },
  { pattern: /^gpt-5/i,          input: 10.00, output: 30.00 },
  { pattern: /^gpt-4\.5/i,      input: 75.00, output:150.00 },
  { pattern: /gpt-4o-mini/i,    input:  0.15, output:  0.60 },
  { pattern: /gpt-4o/i,         input:  2.50, output: 10.00 },
  { pattern: /chatgpt-4o/i,     input:  2.50, output: 10.00 },
  { pattern: /gpt-4-turbo/i,    input: 10.00, output: 30.00 },
  { pattern: /gpt-4/i,          input: 30.00, output: 60.00 },
  { pattern: /gpt-3\.5/i,       input:  0.50, output:  1.50 },
  { pattern: /^o3-mini/i,        input:  3.00, output: 12.00 },
  { pattern: /^o3/i,             input: 60.00, output:240.00 },
  { pattern: /^o1-mini/i,        input:  3.00, output: 12.00 },
  { pattern: /^o1/i,             input: 15.00, output: 60.00 },
  // Google
  { pattern: /gemini-3.*pro/i,    input: 1.25, output:  5.00 },
  { pattern: /gemini-3.*flash/i,  input: 0.075, output: 0.30 },
  { pattern: /gemini-2\.5-pro/i,  input: 1.25, output:  5.00 },
  { pattern: /gemini-2.*flash/i,  input: 0.075, output: 0.30 },
  { pattern: /gemini-1\.5-flash/i, input: 0.075, output: 0.30 },
  { pattern: /gemini-1\.5-pro/i, input: 1.25, output:  5.00 },
  { pattern: /gemini.*ultra/i,  input:  7.00, output: 21.00 },
  // DeepSeek / Qwen / Mistral / Llama families — rough approximations
  { pattern: /deepseek-v3/i,    input:  0.14, output:  0.28 },
  { pattern: /deepseek-r1/i,    input:  0.55, output:  2.19 },
  { pattern: /qwen-?2.*72b/i,    input:  0.40, output:  1.20 },
  { pattern: /llama-3.*70b/i,    input:  0.59, output:  0.79 },
  { pattern: /mistral-large/i,  input:  2.00, output:  6.00 },
];

// Tier fallbacks for completely unknown models — rough rates so budget queries
// still produce a number. Conservative high-tier estimate.
const TIER_FALLBACK: Record<ModelTier, { input: number; output: number }> = {
  high: { input: 15.00, output: 60.00 },
  mid:  { input:  3.00, output: 12.00 },
  low:  { input:  0.50, output:  1.50 },
};

export function priceFor(modelId: string, tier: ModelTier): { input: number; output: number; source: 'known' | 'tier' } {
  for (const e of KNOWN_PRICES) {
    if (e.pattern.test(modelId)) return { input: e.input, output: e.output, source: 'known' };
  }
  const fb = TIER_FALLBACK[tier];
  return { input: fb.input, output: fb.output, source: 'tier' };
}

// ── Tier classifier ─────────────────────────────────────────────────────────

const HIGH_PATTERNS = [
  /opus/i,
  /\bo[1-9]\b/i,
  /^o[1-9]/i,
  /gpt-5/i,
  /gpt-4\.5/i,
  /\bultra\b/i,
  /405b/i,
  /llama-3.*70b/i,
  /llama-4/i,
  /gemini-.*ultra/i,
  /\bsonar-pro\b/i,
  /reasoner/i,
];

const LOW_PATTERNS = [
  /haiku/i,
  /-mini/i,
  /-nano/i,
  /gpt-3\.5/i,
  /gpt-4o-mini/i,
  /\bflash\b/i,
  /flash-lite/i,
  /1b\b/i,
  /3b\b/i,
  /7b\b/i,
  /8b\b/i,
  /\bphi-/i,
  /tiny/i,
  /\bsmall\b/i,
];

export function classifyTier(modelId: string): ModelTier {
  // LOW patterns checked first so size-suffixed cheaper variants (e.g.
  // gpt-5-mini, claude-haiku-4-5) don't get caught by their base-model HIGH
  // regex (e.g. /gpt-5/, /opus/).
  for (const p of LOW_PATTERNS)  if (p.test(modelId)) return 'low';
  for (const p of HIGH_PATTERNS) if (p.test(modelId)) return 'high';
  return 'mid';
}

// ── Chat-capability filter ────────────────────────────────────────────────────
// VoidAI (and some other providers) expose non-chat models — TTS, image gen,
// embeddings, moderation — in their /v1/models list. These must never be picked
// as a subagent model; triage filters them via the chat_capable column.

const NON_CHAT_PATTERNS = [
  // ── audio / speech / transcription / music ──
  /tts/i,                   // tts-1, tts-1-hd, gpt-4o-mini-tts, openai_tts
  /\bwhisper\b/i,           // whisper-1 (transcription)
  /-transcribe$/i,          // gpt-4o-mini-transcribe, gpt-4o-transcribe
  /gpt[_-]?audio/i,         // gpt-audio-1.5, gpt-audio-mini
  /elevenlabs/i,            // ElevenLabs voice
  /^hume$/i,                // Hume emotional voice
  // ── embeddings / moderation ──
  /text-embedding/i,        // text-embedding-3-small/large
  /\bembedding/i,           // other embedding model names
  /\bmoderation\b/i,        // omni-moderation-latest
  // ── image generation ──
  /gpt[_-]?image/i,         // gpt-image-1/1.5/2, gpt_image2_edit, gpt_image_edit
  /-image$/i,               // gemini-2.5-flash-image, etc.
  /-image-preview$/i,       // gemini-3.1-flash-image-preview
  /qwen[_-]?image/i,        // qwen_image_edit (plain Qwen chat models stay)
  /hunyuan[_-]?image/i,     // hunyuan_image (plain 'hunyuan' chat LLM stays)
  /dall-?e/i,               // dall-e-2/3, dalle
  /^flux/i,                 // flux-kontext, flux2, flux_pro, flux_pro_ultra
  /\bmidjourney\b/i,        // midjourney
  /recraft/i,               // recraft, recraft_svg, recraft_vectorize
  /\bstable-diffusion\b/i,  // stable-diffusion variants
  /^ideogram/i,             // ideogram, ideogram_character
  /^imagen/i,               // Google Imagen
  /imagine[_-]?art/i,       // imagine_art
  /grok[_-]?imagine/i,      // grok_imagine_image / grok_imagine_video
  /nano[_-]?banana/i,       // nano_banana, nano_banana_pro
  /^dreamina/i,             // Dreamina image gen
  /^seedream/i,             // Seedream image gen
  /^magnific/i,             // Magnific image upscaler
  /^topaz/i,                // Topaz image/video enhancer
  // ── video generation ──
  /kling/i,                 // kling_ai, kling_ai_v3, kling_ai_v26_motion
  /luma/i,                  // luma_labs
  /^runway/i,               // Runway
  /seedance/i,              // seedance, seedance_pro
  /^sora/i,                 // OpenAI Sora
  /^veo/i,                  // veo, veo3, veo31_lite
  /^wan\d*$/i,              // wan, wan25, wan27 (Alibaba Wan video)
];

export function isChatCapable(modelId: string): boolean {
  for (const p of NON_CHAT_PATTERNS) if (p.test(modelId)) return false;
  return true;
}

// ── Refresh ─────────────────────────────────────────────────────────────────

function antigravityTierFromName(displayName: string): ModelTier {
  const n = displayName.toLowerCase();
  if (/\(high\)/.test(n) || /\(thinking\)/.test(n) || /opus/.test(n)) return 'high';
  if (/\(medium\)/.test(n) || /sonnet/.test(n) || /pro/.test(n)) return 'mid';
  return 'low';
}

async function refreshAntigravity(): Promise<{ added: number; updated: number; missing: number }> {
  const displayNames = await fetchAntigravityModels();

  // Fall back to compile-time list when agy is unreachable
  const modelIds: string[] = [];
  const tierOverrides: Record<string, ModelTier> = {};

  if (displayNames.length > 0) {
    for (const name of displayNames) {
      const id = slugifyAntigravityModel(name);
      MODEL_DISPLAY_NAMES[id] = name;
      modelIds.push(id);
      tierOverrides[id] = antigravityTierFromName(name);
    }
  } else {
    for (const id of ANTIGRAVITY_MODELS) {
      modelIds.push(id);
      tierOverrides[id] = antigravityTierFromName(MODEL_DISPLAY_NAMES[id] ?? id);
    }
  }

  return upsertSeen('antigravity', modelIds, false, tierOverrides);
}

export async function refreshCatalog(provider: ModelProvider = 'voidai'): Promise<{ added: number; updated: number; missing: number }> {
  if (provider === 'antigravity') return refreshAntigravity();
  if (provider === 'voidai')      return refreshVoidAi();
  if (provider === 'anthropic')   return refreshAnthropic();
  if (provider === 'codex')       return refreshCodex();
  if (provider === 'kimi')        return refreshNativeGateway('kimi');
  if (provider === 'minimax')     return refreshNativeGateway('minimax');
  if (provider === 'claude-interactive') return refreshClaudeInteractive();
  if (provider === 'openrouter')  return refreshOpenRouter();
  if (provider === 'ollama')      return refreshOllama();
  if (provider === 'litellm')       return refreshLiteLlm();
  if (provider === 'claude-gateway') return refreshGatewayModels();
  if (provider === 'abacus')        return refreshAbacus();
  if (provider === 'omniroute')     return refreshOmniRoute();
  return { added: 0, updated: 0, missing: 0 };
}

async function refreshVoidAi(): Promise<{ added: number; updated: number; missing: number }> {
  let modelIds: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await getClient().models.list();
    const data = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allIds = data.map((m: any) => String(m?.id ?? m?.model ?? '')).filter(Boolean) as string[];
    // Strip non-chat models (TTS, image-gen, embeddings, moderation) so they
    // never appear in the agent model picker or triage pool.
    modelIds = allIds.filter(isChatCapable);
  } catch (err) {
    logger.warn('model-catalog: VoidAI /v1/models failed', { error: (err as Error).message });
    // Fallback so the catalog isn't left empty on a transient error.
    modelIds = ['claude-opus-4-7', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];
  }
  return upsertSeen('voidai', modelIds);
}

async function refreshAnthropic(): Promise<{ added: number; updated: number; missing: number }> {
  const { fetchClaudeCliModels } = await import('../providers/claude-cli');
  const cliIds = fetchClaudeCliModels();
  // additive: the CLI now names only the *current* model — never deactivate the rest.
  if (cliIds.length > 0) return upsertSeen('anthropic', cliIds, false, {}, {}, true);

  // Fall back to SDK when CLI subprocess is unavailable (e.g. nested inside Claude Code)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await getAnthropicClient().models.list({ limit: 100 });
    const data = Array.isArray(result?.data) ? result.data : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = data.map((m: any) => String(m?.id ?? '')).filter(isChatCapable);
    if (ids.length === 0) throw new Error('empty model list');
    return upsertSeen('anthropic', ids);
  } catch (err) {
    logger.warn('model-catalog: Anthropic models.list failed', { error: (err as Error).message });
    return upsertSeen('anthropic', ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
  }
}

async function refreshClaudeInteractive(): Promise<{ added: number; updated: number; missing: number }> {
  if (!config.claudeInteractive.enabled) return { added: 0, updated: 0, missing: 0 };
  const { fetchClaudeCliModels } = await import('../providers/claude-cli');
  const ids = fetchClaudeCliModels();
  if (ids.length === 0) return upsertSeen('claude-interactive', ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], true);
  // additive: CLI names only the current model — never deactivate the rest.
  return upsertSeen('claude-interactive', ids, true /* subscription */, {}, {}, true);
}

async function refreshCodex(): Promise<{ added: number; updated: number; missing: number }> {
  const { fetchCodexModels } = await import('../providers/codex-cli');
  const ids = await fetchCodexModels();
  if (ids.length === 0) return { added: 0, updated: 0, missing: 0 };
  return upsertSeen('codex', ids, true /* subscription */);
}


// Native Anthropic-endpoint gateways (provider='kimi' / 'minimax') — the Claude
// SDK drives these at each vendor's OWN /v1/messages endpoint. They each expose an
// Anthropic-style /v1/models listing ({data:[{id}]}); pull from it so the agent
// editor shows THEIR models, not VoidAI's. Billed via the user's subscription key,
// so subscriptionProvider=true (tokens tracked, cost $0). Falls back to the single
// configured default model if the listing is unreachable.
async function refreshNativeGateway(provider: 'kimi' | 'minimax'): Promise<{ added: number; updated: number; missing: number }> {
  const gw = config.claude.gateways[provider];
  if (!gw.baseURL || !gw.apiKey) return { added: 0, updated: 0, missing: 0 };
  const fallback = [gw.model].filter(Boolean);
  const url = `${gw.baseURL.replace(/\/+$/, '')}/v1/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${gw.apiKey}` },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn(`model-catalog: ${provider} /v1/models failed`, { status: res.status });
      return upsertSeen(provider, fallback, true);
    }
    const data = await res.json() as { data?: Array<{ id?: string; model?: string }> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelIds = (data?.data ?? []).map((m: any) => String(m?.id ?? m?.model ?? '')).filter(Boolean).filter(isChatCapable);
    if (modelIds.length === 0) return upsertSeen(provider, fallback, true);
    return upsertSeen(provider, modelIds, true /* subscription */);
  } catch (err) {
    logger.warn(`model-catalog: ${provider} refresh failed`, { error: (err as Error).message });
    return upsertSeen(provider, fallback, true);
  }
}

async function refreshOpenRouter(): Promise<{ added: number; updated: number; missing: number }> {
  // OpenRouter is OpenAI-compatible — /v1/models is the standard list endpoint.
  if (!config.openrouter.enabled) {
    // Not configured — seed with popular models (including free tier) so dashboard pickers work.
    const fallbackIds = [
      // Paid models
      'anthropic/claude-sonnet-4',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-haiku',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-pro-preview',
      'google/gemini-3.1-flash-lite',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-r1',
      // Free models
      'qwen/qwen3-next-80b-a3b-instruct:free',
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'openai/gpt-oss-20b:free',
      'openai/gpt-oss-120b:free',
      'baidu/cobuddy:free',
    ];
    return upsertSeen('openrouter', fallbackIds);
  }

  let modelIds: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await getOpenRouterClient().models.list();
    const data = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelIds = data.map((m: any) => String(m?.id ?? m?.model ?? '')).filter(Boolean);
  } catch (err) {
    logger.warn('model-catalog: OpenRouter /v1/models failed', { error: (err as Error).message });
    // Fallback to known models (including free tier)
    modelIds = [
      'anthropic/claude-sonnet-4',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-haiku',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-pro-preview',
      'google/gemini-3.1-flash-lite',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-r1',
      'qwen/qwen3-next-80b-a3b-instruct:free',
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'openai/gpt-oss-20b:free',
      'openai/gpt-oss-120b:free',
    ];
  }

  return upsertSeen('openrouter', modelIds);
}

// Abacus AI (RouteLLM) — OpenAI-compatible; /v1/models is the standard list
// endpoint. Unlike the other refreshers we DO NOT pre-filter via isChatCapable:
// the whole point of this provider is its media models (image/video/audio gen),
// so we pull EVERY model id and let upsertSeen() flag each with chat_capable=0/1.
// Media models are stored + visible but excluded from the chat/triage pool.
// Map Abacus's model_type → our media_type + chat-capability. This metadata is
// authoritative (name regexes can't tell e.g. video 'hunyuan'/'minimax' from a
// chat model), so we classify off it directly.
function abacusMetaFromType(modelType: string | undefined): ModelMeta {
  switch ((modelType ?? '').toLowerCase()) {
    case 'image_generation': return { chatCapable: false, mediaType: 'image' };
    case 'video_generation': return { chatCapable: false, mediaType: 'video' };
    case 'audio_generation': return { chatCapable: false, mediaType: 'audio' };
    case 'text_generation':  return { chatCapable: true,  mediaType: null };
    default:                 return {}; // unknown → fall back to name-based isChatCapable
  }
}

async function refreshAbacus(): Promise<{ added: number; updated: number; missing: number }> {
  if (!config.abacus.enabled) return { added: 0, updated: 0, missing: 0 };
  let modelIds: string[] = [];
  const meta: Record<string, ModelMeta> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await getAbacusClient().models.list();
    const data = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
    for (const m of data) {
      const id = String(m?.id ?? m?.model ?? '');
      if (!id) continue;
      modelIds.push(id);
      meta[id] = abacusMetaFromType(m?.model_type);
    }
  } catch (err) {
    logger.warn('model-catalog: Abacus /v1/models failed', { error: (err as Error).message });
    // Fall back to seeding only the configured default model so the catalog
    // isn't left empty on a transient error.
    modelIds = [config.abacus.model].filter(Boolean);
  }
  return upsertSeen('abacus', modelIds, false, {}, meta);
}

async function refreshOmniRoute(): Promise<{ added: number; updated: number; missing: number }> {
  // OmniRoute is a self-hosted, OpenAI-compatible gateway — /v1/models lists the
  // routing aliases (auto/best-*, oc/*-free, etc.). It's a local service, so a
  // failed listing just means the gateway is offline: seed the configured default
  // alias so the picker isn't empty rather than treating it as an error.
  const { getOmniRouteClient } = await import('../agent/omniroute-client');
  const fallback = [config.omniroute.model].filter(Boolean);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await getOmniRouteClient().models.list();
    const data = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelIds = data.map((m: any) => String(m?.id ?? m?.model ?? '')).filter(Boolean).filter(isChatCapable);
    if (modelIds.length === 0) return upsertSeen('omniroute', fallback);
    return upsertSeen('omniroute', modelIds);
  } catch (err) {
    logger.warn('model-catalog: OmniRoute /v1/models failed (gateway offline?)', { error: (err as Error).message });
    return upsertSeen('omniroute', fallback);
  }
}

async function refreshOllama(): Promise<{ added: number; updated: number; missing: number }> {
  if (!config.ollama.enabled) return { added: 0, updated: 0, missing: 0 };
  try {
    const res = await fetch(`${config.ollama.baseURL}/models`, {
      headers: { Authorization: 'Bearer ollama' },
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn('model-catalog: Ollama /v1/models failed', { status: res.status });
      return { added: 0, updated: 0, missing: 0 };
    }
    const data = await res.json() as { data?: Array<{ id: string }> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelIds = (data?.data ?? []).map((m: any) => String(m?.id ?? m?.name ?? '')).filter(Boolean);
    return upsertSeen('ollama', modelIds, true);
  } catch (err) {
    logger.warn('model-catalog: Ollama refresh failed', { error: (err as Error).message });
    return { added: 0, updated: 0, missing: 0 };
  }
}

async function refreshLiteLlm(): Promise<{ added: number; updated: number; missing: number }> {
  if (!config.litellm.enabled) return { added: 0, updated: 0, missing: 0 };
  try {
    const headers: Record<string, string> = {};
    if (config.litellm.apiKey) headers['Authorization'] = `Bearer ${config.litellm.apiKey}`;
    const res = await fetch(`${config.litellm.baseURL}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn('model-catalog: LiteLLM /v1/models failed', { status: res.status });
      // Fall back to seeding only the configured default model
      return upsertSeen('litellm', [config.litellm.model].filter(Boolean));
    }
    const data = await res.json() as { data?: Array<{ id: string }> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelIds = (data?.data ?? []).map((m: any) => String(m?.id ?? m?.model ?? '')).filter(Boolean).filter(isChatCapable);
    if (modelIds.length === 0) {
      return upsertSeen('litellm', [config.litellm.model].filter(Boolean));
    }
    return upsertSeen('litellm', modelIds);
  } catch (err) {
    logger.warn('model-catalog: LiteLLM refresh failed', { error: (err as Error).message });
    return upsertSeen('litellm', [config.litellm.model].filter(Boolean));
  }
}

// The claude-gateway plane drives models through LiteLLM's Anthropic /v1/messages
// endpoint, which registers a DIFFERENT (much smaller) model set than the OpenAI
// chat-completions endpoint — e.g. void/* and the metered claude-literouter models
// 404/403/500 on /v1/messages even though they list on /models. There's no metadata
// route with our restricted key, so probe each chat model against /v1/messages
// (max_tokens:1) and keep only those returning 200. Runs in the scheduled catalog
// refresh; the dashboard reads the stored result (no probing on dropdown open).
async function refreshGatewayModels(): Promise<{ added: number; updated: number; missing: number }> {
  if (!config.litellm.enabled) return { added: 0, updated: 0, missing: 0 };
  const base   = config.litellm.baseURL.replace(/\/$/, '');
  const apiKey = config.litellm.apiKey;
  const fallback = [config.claude.gateway.model].filter(Boolean);

  // Candidate set = the chat-capable models on the OpenAI /models listing.
  let candidates: string[] = [];
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id?: string; model?: string }> };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candidates = (data?.data ?? []).map((m: any) => String(m?.id ?? m?.model ?? '')).filter(Boolean).filter(isChatCapable);
    }
  } catch (err) {
    logger.warn('model-catalog: gateway candidate list failed', { error: (err as Error).message });
  }
  if (candidates.length === 0) return upsertSeen('claude-gateway', fallback);

  // Representative agentic probe — NOT a plain "hi". The real claude-gateway
  // traffic (Claude Agent SDK over /v1/messages) carries tool definitions and
  // array-content blocks (assistant tool_use, user tool_result). Some upstreams
  // accept plain text but mistranslate those blocks (e.g. void/* → a Responses-API
  // ZodError on the content arrays), so a plain-text probe would false-pass them.
  // This exercises the exact content shapes that break, so a 200 means the model
  // can actually run an agentic turn through the gateway, not just echo text.
  const probeBody = (model: string) => JSON.stringify({
    model,
    max_tokens: 16,
    tools: [{ name: 'echo', description: 'Echo the text back', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    messages: [
      { role: 'user',      content: [{ type: 'text', text: 'Echo hello.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_probe1', name: 'echo', input: { text: 'hello' } }] },
      { role: 'user',      content: [{ type: 'tool_result', tool_use_id: 'toolu_probe1', content: 'hello' }] },
    ],
  });
  async function onMessages(model: string): Promise<boolean> {
    try {
      const r = await fetch(`${base}/v1/messages`, {
        method:  'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body:    probeBody(model),
        signal:  AbortSignal.timeout(15000),
      });
      return r.status === 200;
    } catch { return false; }
  }

  const working: string[] = [];
  const CONC = 12;
  for (let i = 0; i < candidates.length; i += CONC) {
    const chunk = candidates.slice(i, i + CONC);
    const results = await Promise.all(chunk.map(async (m) => ({ m, ok: await onMessages(m) })));
    for (const { m, ok } of results) if (ok) working.push(m);
  }
  logger.info('model-catalog: claude-gateway /v1/messages probe', { probed: candidates.length, onMessages: working.length });
  return upsertSeen('claude-gateway', working.length > 0 ? working : fallback);
}

// subscriptionProvider: true means the provider is billed via a flat subscription
// (Gemini CLI, Codex CLI, Claude CLI) — tokens are tracked but cost is always $0.
// tierOverrides: explicit tier pins applied at seed time (tier_overridden=1 is set
// so auto-classify never clobbers them on subsequent refreshes).
function upsertSeen(
  provider: string,
  modelIds: string[],
  subscriptionProvider = false,
  tierOverrides: Record<string, ModelTier> = {},
  meta: Record<string, ModelMeta> = {},
  additive = false,
): { added: number; updated: number; missing: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const seen = new Set(modelIds);
  let added = 0;
  let updated = 0;

  const insert = db.prepare(`
    INSERT INTO model_catalog (id, provider, model_id, tier, tier_overridden, is_available, last_seen_at,
                               cost_per_1k_input, cost_per_1k_output, chat_capable, media_type)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      is_available       = 1,
      last_seen_at       = excluded.last_seen_at,
      updated_at         = datetime('now'),
      tier               = CASE WHEN tier_overridden = 1 THEN tier ELSE excluded.tier END,
      tier_overridden    = CASE WHEN tier_overridden = 1 THEN 1
                                WHEN excluded.tier_overridden = 1 THEN 1
                                ELSE 0 END,
      cost_per_1k_input  = CASE WHEN price_overridden = 1 THEN cost_per_1k_input  ELSE excluded.cost_per_1k_input  END,
      cost_per_1k_output = CASE WHEN price_overridden = 1 THEN cost_per_1k_output ELSE excluded.cost_per_1k_output END,
      chat_capable       = excluded.chat_capable,
      media_type         = excluded.media_type
  `);
  for (const modelId of modelIds) {
    const id = `${provider}:${modelId}`;
    const m = meta[modelId] ?? {};
    const manualTier = m.tier ?? tierOverrides[modelId];
    const tier = manualTier ?? classifyTier(modelId);
    const tierOverridden = manualTier ? 1 : 0;
    const price = subscriptionProvider ? { input: 0, output: 0 } : priceFor(modelId, tier);
    // Metadata wins over the name-regex when the provider gave us a model_type.
    const chatCapable = (m.chatCapable ?? isChatCapable(modelId)) ? 1 : 0;
    const mediaType = m.mediaType ?? null;
    const before = db.prepare('SELECT id FROM model_catalog WHERE id = ?').get(id);
    insert.run(id, provider, modelId, tier, tierOverridden, now, price.input, price.output, chatCapable, mediaType);
    if (before) updated++; else added++;
  }

  // Mark anything else for this provider as missing — UNLESS additive. Additive sources
  // are known to report an incomplete set (e.g. the Claude CLI now names only the *current*
  // model), so deactivating unseen entries would collapse a rich catalog snapshot.
  let missing = 0;
  if (!additive) {
    const provRows = db.prepare('SELECT id, model_id FROM model_catalog WHERE provider = ?').all(provider) as { id: string; model_id: string }[];
    const markMissing = db.prepare(`UPDATE model_catalog SET is_available = 0, updated_at = datetime('now') WHERE id = ?`);
    for (const row of provRows) {
      if (!seen.has(row.model_id)) {
        markMissing.run(row.id);
        missing++;
      }
    }
  }

  logAudit('model_catalog_refresh', 'model_catalog', undefined, { provider, added, updated, missing, total_seen: modelIds.length });
  logger.info('model-catalog: refresh complete', { provider, added, updated, missing, total: modelIds.length });
  return { added, updated, missing };
}

// ── Public read API ─────────────────────────────────────────────────────────

export interface ListCatalogOpts {
  provider?:           string;
  tier?:               ModelTier;
  includeUnavailable?: boolean;
  chatCapable?:        boolean;  // true = only return chat-capable models (triage use)
  mediaType?:          'image' | 'video' | 'audio';  // filter to a media category
}

export function listCatalog(opts: ListCatalogOpts = {}): ModelCatalogRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.provider)     { where.push('provider = ?'); args.push(opts.provider); }
  if (opts.tier)         { where.push('tier = ?');     args.push(opts.tier); }
  if (!opts.includeUnavailable) where.push('is_available = 1');
  if (opts.chatCapable)  where.push('chat_capable = 1');
  if (opts.mediaType)    { where.push('media_type = ?'); args.push(opts.mediaType); }
  const sql = `
    SELECT * FROM model_catalog
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY provider ASC, tier ASC, model_id ASC
  `;
  return getDb().prepare(sql).all(...args) as ModelCatalogRow[];
}

// Effort/reasoning suffixes some CLIs append to a model id (notably agy, e.g.
// "gemini-3-5-flash-medium"). Stripped before a normalized equivalence match.
const EFFORT_SUFFIXES = ['-thinking-lite', '-thinking', '-medium', '-minimal', '-low', '-high', '-max'];

function stripEffortSuffix(id: string): string {
  const lower = id.toLowerCase();
  for (const s of EFFORT_SUFFIXES) {
    if (lower.endsWith(s)) return id.slice(0, id.length - s.length);
  }
  return id;
}

// Separator-insensitive key so agy's dash-versioned slug (gemini-3-5-flash)
// matches the catalog's dot-versioned id (gemini-3.5-flash).
function modelKey(id: string): string {
  return id.toLowerCase().replace(/[-.]/g, '');
}

/**
 * Resolve any model id (e.g. a CLI provider's model) to the equivalent model(s)
 * on an API provider, for chat-mode fallback. Returns an ORDERED list of
 * candidates — VoidAI preferred, OpenRouter as the resilience fallback (so a
 * flaky VoidAI model, e.g. its gemini, can be retried on OpenRouter). Strategy
 * per provider: strip a provider prefix, try an exact catalog match, then a
 * normalized match (effort suffix removed, dash/dot-insensitive). Empty when
 * nothing matches.
 *
 *   gpt-5.4                              -> [voidai gpt-5.4, openrouter openai/gpt-5.4]
 *   claude-sonnet-4-6                    -> [voidai claude-sonnet-4-6]
 *   antigravity/gemini-3-5-flash-medium  -> [voidai gemini-3.5-flash, openrouter google/gemini-3.5-flash]
 */
export function resolveEquivalentApiModels(rawModel: string): Array<{ provider: 'voidai' | 'openrouter'; model: string }> {
  const out: Array<{ provider: 'voidai' | 'openrouter'; model: string }> = [];
  if (!rawModel) return out;
  const bare = rawModel.includes('/') ? rawModel.split('/').pop()! : rawModel;
  const voidaiRows = listCatalog({ provider: 'voidai' }).map(r => r.model_id);
  const orRows     = listCatalog({ provider: 'openrouter' }).map(r => r.model_id);
  const push = (provider: 'voidai' | 'openrouter', model: string | undefined) => {
    if (model && !out.some(o => o.provider === provider && o.model === model)) out.push({ provider, model });
  };

  // 1. Exact id match (VoidAI preferred, then OpenRouter family-prefixed).
  if (voidaiRows.includes(bare)) push('voidai', bare);
  push('openrouter', orRows.find(m => m === bare || m.endsWith('/' + bare)));

  // 2. Normalized match: drop the effort suffix, compare separator-insensitively.
  const key = modelKey(stripEffortSuffix(bare));
  push('voidai', voidaiRows.find(m => modelKey(m) === key));
  push('openrouter', orRows.find(m => modelKey(m.split('/').pop()!) === key));

  return out;
}

export function setPriceOverride(provider: string, modelId: string, input: number | null, output: number | null): void {
  const id = `${provider}:${modelId}`;
  if (input === null && output === null) {
    // Reset → re-derive on next refresh.
    getDb().prepare(`
      UPDATE model_catalog
      SET price_overridden = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  } else {
    getDb().prepare(`
      UPDATE model_catalog
      SET price_overridden   = 1,
          cost_per_1k_input  = ?,
          cost_per_1k_output = ?,
          updated_at         = datetime('now')
      WHERE id = ?
    `).run(input, output, id);
  }
  logAudit('model_price_override', 'model_catalog', id, { input, output });
}

export function setTierOverride(provider: string, modelId: string, tier: ModelTier | null): void {
  const id = `${provider}:${modelId}`;
  if (tier === null) {
    // Reset override; auto-classify will reapply on next refresh.
    getDb().prepare(`
      UPDATE model_catalog
      SET tier_overridden = 0, tier = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(classifyTier(modelId), id);
  } else {
    getDb().prepare(`
      UPDATE model_catalog
      SET tier_overridden = 1, tier = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(tier, id);
  }
  logAudit('model_tier_override', 'model_catalog', id, { tier });
}

// ── Background refresh scheduler ────────────────────────────────────────────

let refreshTimer: NodeJS.Timeout | null = null;

export function startCatalogRefresh(): void {
  // Run immediately, then every hour.
  void runAll();
  refreshTimer = setInterval(() => { void runAll(); }, 60 * 60 * 1000);
}

export function stopCatalogRefresh(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// Drop catalog rows for providers that are no longer in MODEL_PROVIDERS (e.g.
// venice/kimi-api/opencode/gemini after being pruned). Otherwise stale rows keep
// the removed provider visible on the Providers status page and in model lists.
// MODEL_PROVIDERS values are fixed literals — safe to inline in the SQL.
function pruneRemovedProviders(): void {
  const valid = MODEL_PROVIDERS.map(p => `'${p}'`).join(', ');
  try {
    const res = getDb().prepare(`DELETE FROM model_catalog WHERE provider NOT IN (${valid})`).run();
    if (res.changes > 0) logger.info('model-catalog: pruned rows for removed providers', { removed: res.changes });
  } catch (err) {
    logger.warn('model-catalog: prune removed-providers failed', { err: (err as Error).message });
  }
}

async function runAll(): Promise<void> {
  pruneRemovedProviders();
  for (const provider of MODEL_PROVIDERS) {
    if (provider === 'voidai'  && !config.voidai.apiKey)   continue;
    if (provider === 'kimi'    && !config.claude.gateways.kimi.apiKey)    continue;
    if (provider === 'minimax' && !config.claude.gateways.minimax.apiKey) continue;
    if (provider === 'claude-interactive' && !config.claudeInteractive.enabled) continue;
    if (provider === 'ollama'  && !config.ollama.enabled)   continue;
    if (provider === 'litellm' && !config.litellm.enabled)  continue;
    if (provider === 'claude-gateway' && !config.litellm.enabled) continue;
    if (provider === 'abacus'  && !config.abacus.apiKey)    continue;
    try {
      await refreshCatalog(provider);
    } catch (err) {
      logger.warn('catalog refresh failed', { provider, err: (err as Error).message });
    }
  }
}
