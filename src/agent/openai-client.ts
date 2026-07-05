import OpenAI from 'openai';
import { config } from '../config';

let client:              OpenAI | null = null;
let bgClient:            OpenAI | null = null;
let bgOpenRouterClient:  OpenAI | null = null;
let bgVoidaiClient:      OpenAI | null = null;
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
// Bounded timeout so VoidAI's high-variance gemini routing can't hang a turn —
// a timeout throws and bgChatCompletion() degrades to OpenRouter.
function getVoidaiBgClient(): OpenAI {
  if (!bgVoidaiClient) {
    bgVoidaiClient = new OpenAI({
      apiKey:     config.voidai.bgApiKey,
      baseURL:    config.voidai.baseURL,
      timeout:    config.background.voidaiTimeoutMs,
      maxRetries: 0,
    });
  }
  return bgVoidaiClient;
}

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

export interface BgChatOpts {
  /** Model to use on the VoidAI attempt. Defaults to BG_VOIDAI_MODEL. */
  voidaiModel?: string;
  /** Model for the OpenRouter backup. Defaults to config.background.model (BG_MODEL, gemini-3.5-flash). */
  openrouterModel?: string;
  /**
   * Force OpenRouter-primary (skip the VoidAI attempt) for latency-critical
   * callers like the per-message router classifier. Defaults to the global
   * config.background.voidaiFirst toggle.
   */
  voidaiFirst?: boolean;
  /** Optional label for fallback logging. */
  label?: string;
}

/**
 * Background chat completion with VoidAI-first → OpenRouter fallback.
 *
 * Tries a fast VoidAI model first (claude-haiku-4-5 by default — ~1-2s), then
 * falls back to the OpenRouter background model on ANY error or timeout — VoidAI
 * is an aggregator with high-variance latency, so graceful degradation (not just
 * on 5xx) is the point. Network/5xx errors additionally trip the 60s circuit
 * breaker so subsequent calls skip VoidAI entirely.
 *
 * Honors the global BG_VOIDAI_FIRST kill switch and the per-call voidaiFirst opt.
 */
export async function bgChatCompletion(
  args: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  opts: BgChatOpts = {},
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const voidaiFirst    = opts.voidaiFirst ?? config.background.voidaiFirst;
  // OpenRouter backup model: the single configured background backup
  // (config.background.model = gemini-3.5-flash) unless a caller overrides via
  // opts.openrouterModel (e.g. holdout-reviewer pins claude-sonnet-4). The
  // caller's args.model is NOT used for the backup tier — both tiers pick their
  // own model, so the backup stays uniform across every background task.
  const openrouterModel = opts.openrouterModel || config.background.model;

  if (voidaiFirst && config.voidai.bgApiKey && !isVoidaiDown()) {
    const voidaiModel = opts.voidaiModel || config.background.voidaiModel;
    // VoidAI reasoning models (e.g. gemini) burn the token budget before
    // answering, so floor max_tokens and cap reasoning so small-budget callers
    // still get non-empty content. These adjustments apply ONLY to the VoidAI
    // attempt (harmless no-ops for haiku); the OpenRouter fallback below uses the
    // caller's original args verbatim.
    const voidaiArgs: Record<string, unknown> = {
      ...args,
      model: voidaiModel,
      stream: false,
      max_tokens: Math.max(args.max_tokens ?? 0, config.background.voidaiMinTokens),
    };
    if (config.background.voidaiReasoningEffort) {
      voidaiArgs.reasoning_effort = config.background.voidaiReasoningEffort;
    }
    try {
      return await getVoidaiBgClient().chat.completions.create(
        voidaiArgs as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      );
    } catch (err) {
      // Trip the circuit breaker only for infra failures so we don't hammer a
      // genuinely-down VoidAI; but fall back to OpenRouter on ANY error.
      if (isVoidaiError(err)) markVoidaiDown();
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[bg] VoidAI ${voidaiModel} failed${opts.label ? ` (${opts.label})` : ''}, falling back to OpenRouter ${openrouterModel}: ${reason}`);
    }
  }

  return await getOpenRouterBgClient().chat.completions.create({ ...args, model: openrouterModel, stream: false });
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
  bgVoidaiClient     = null;
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
