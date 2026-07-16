import OpenAI from 'openai';
import { config } from '../config';

let client:              OpenAI | null = null;
let bgClient:            OpenAI | null = null;
let bgOpenRouterClient:  OpenAI | null = null;
let skillForgeClient:    OpenAI | null = null;

// ── VoidAI outage detection ────────────────────────────────────────────────
// When a background call hits a VoidAI server/network error, mark it as down
// for 60 s so subsequent background calls skip straight to OpenRouter.
const voidaiDownUntil = { until: 0 };
const VOIDAI_DOWN_TTL_MS = 60_000;

export function isVoidaiDown(): boolean { return Date.now() < voidaiDownUntil.until; }

export function markVoidaiDown(): void {
  voidaiDownUntil.until = Date.now() + VOIDAI_DOWN_TTL_MS;
}

/** True for server-side or network failures (not auth/quota errors). */
export function isVoidaiError(err: unknown): boolean {
  const msg    = err instanceof Error ? err.message : String(err);
  const status = (err as any)?.status ?? (err as any)?.httpStatus ?? 0;
  return status === 502 || status === 503 || status === 504 ||
    msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed')  || msg.includes('socket hang up') ||
    msg.includes('network socket') || msg.includes('connection refused');
}

// Read a positive-integer env var, falling back when unset or invalid.
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Lazy init — must stay lazy so dotenv loads before we read env vars
export function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey:  config.voidai.apiKey,
      baseURL: config.voidai.baseURL,
      // The SDK default timeout is 600000ms (10 min) — longer than the 3-min
      // stale-run sweeper window. A stalled VoidAI call with no timeout hangs
      // the turn forever and jams its whole session queue. A finite timeout
      // makes a hung call throw, so the turn errors out and the session frees.
      timeout:    envInt('LLM_TIMEOUT_MS', 120000),
      maxRetries: envInt('LLM_MAX_RETRIES', 1),
    });
  }
  return client;
}

// Dedicated OpenRouter background client (the fallback tier).
function getOpenRouterBgClient(): OpenAI {
  if (!bgOpenRouterClient) {
    bgOpenRouterClient = new OpenAI({
      apiKey:         config.openrouter.apiKey,
      baseURL:        config.openrouter.baseURL,
      defaultHeaders: { 'HTTP-Referer': 'https://neuroclaw.io', 'X-Title': 'NeuroClaw' },
    });
  }
  return bgOpenRouterClient;
}

// Dedicated VoidAI background client (the VoidAI-first primary tier).
// Background tasks (decomposer, dream-cycle, etc.)
// Routes to OpenRouter when BG_PROVIDER=openrouter (default), VoidAI otherwise.
// NOTE: prefer bgChatCompletion() for chat calls — it adds the VoidAI-first
// fallback. getBgClient() remains for embeddings and other non-chat callers.
export function getBgClient(): OpenAI {
  if (config.background.provider === 'openrouter' && config.openrouter.apiKey) {
    return getOpenRouterBgClient();
  }
  if (!bgClient) {
    bgClient = new OpenAI({ apiKey: config.voidai.bgApiKey, baseURL: config.voidai.baseURL });
  }
  return bgClient;
}

// Dedicated VoidAI background client for the default bg chat lane (gpt-4.1-nano).
// Distinct from getBgClient() which flips on BG_PROVIDER — this one is always
// VoidAI, since bgChatCompletion routes providers itself.
function getVoidaiBgClient(): OpenAI {
  if (!bgClient) {
    bgClient = new OpenAI({
      apiKey:     config.voidai.bgApiKey,
      baseURL:    config.voidai.baseURL,
      timeout:    envInt('LLM_TIMEOUT_MS', 120000),
      maxRetries: envInt('LLM_MAX_RETRIES', 1),
    });
  }
  return bgClient;
}

export interface BgChatOpts {
  /**
   * Route this call to OpenRouter google/gemini-2.5-flash-lite instead of the
   * default VoidAI gpt-4.1-nano. Set true ONLY for nuanced-inference callers
   * (memory-extractor, user-profiler) where gemini's reasoning edge matters.
   */
  preferGemini?: boolean;
  /** Override the OpenRouter/gemini model (only used on the preferGemini lane). */
  openrouterModel?: string;
  /** Override the default VoidAI model (defaults to config.background.voidaiModel, gpt-4.1-nano). */
  voidaiModel?: string;
  /** Optional label for logging. */
  label?: string;
}

/**
 * Background chat completion — split-provider routing (per user 2026-07-07).
 *
 *  - DEFAULT lane → VoidAI `gpt-4.1-nano`. Non-reasoning, cheap, on the flat
 *    VoidAI plan; handles the 7 "wash" bg tasks (session-namer, decomposer,
 *    dream-cycle, context-compactor, skill-forge, holdout-reviewer, doc-notebooks).
 *  - GEMINI lane  → OpenRouter `google/gemini-2.5-flash-lite`, taken ONLY when the
 *    caller passes { preferGemini: true } (memory-extractor, user-profiler) —
 *    the two tasks where gemini's reasoning edge and memory-quality compounding
 *    justify OpenRouter's per-token cost.
 *
 * No cross-provider fallback: each caller has exactly one lane. The caller's
 * args.model is ignored; the lane's configured model always wins (override via
 * opts.openrouterModel / opts.voidaiModel).
 */
export async function bgChatCompletion(
  args: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  opts: BgChatOpts = {},
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  if (opts.preferGemini) {
    const model = opts.openrouterModel || config.background.geminiModel;
    return await getOpenRouterBgClient().chat.completions.create({
      ...args,
      model,
      stream: false,
    });
  }
  const model = opts.voidaiModel || config.background.voidaiModel;
  return await getVoidaiBgClient().chat.completions.create({
    ...args,
    model,
    stream: false,
  });
}

// Skill-forge — uses its own dedicated SKILL_FORGE_API_KEY from broker
export function getSkillForgeClient(): OpenAI {
  if (!skillForgeClient) {
    const key = config.voidai.skillForgeApiKey || config.voidai.bgApiKey;
    skillForgeClient = new OpenAI({ apiKey: key, baseURL: config.voidai.baseURL });
  }
  return skillForgeClient;
}

// Call when API key changes at runtime (e.g. from config-watcher)
export function resetClient(): void {
  client             = null;
  bgClient           = null;
  bgOpenRouterClient = null;
  skillForgeClient   = null;
}

/**
 * Returns the model string to use when falling back from VoidAI to OpenRouter.
 * Prefers the explicit BG_MODEL env var (already an OpenRouter model name);
 * falls back to a sensible default if neither BG_MODEL nor OPENROUTER_MODEL is set.
 */
export function voidaiFallbackModel(): string {
  return config.background.model || config.openrouter.model || 'google/gemini-3.1-flash-lite';
}
