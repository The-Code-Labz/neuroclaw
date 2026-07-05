// Vision preprocessor — takes an image URL/data and returns a text
// description via VISION_MODEL. Used by:
//   - chatStream paths whose agent has vision_mode='preprocess' (or 'auto'
//     resolved to preprocess because the agent's model doesn't support vision)
//   - Codex CLI / Claude CLI paths where native multi-modal is patchy
//
// We share the existing OpenAI client (so VoidAI is the default backend),
// but VISION_PROVIDER + VISION_MODEL can override. The output is a single
// concise text description capped at VISION_MAX_DESCRIPTION_CHARS.

import { config } from '../config';
import { logger } from '../utils/logger';
import { getHermesProxyClient } from '../agent/hermes-proxy-client';
import { getOpenRouterClient } from '../agent/openrouter-client';
import { logHive } from '../system/hive-mind';
import { shrinkDataUriIfLarge } from './image-utils';

export interface ImageAttachment {
  /** Public URL or data: URI. data: URIs work for VoidAI/OpenAI vision endpoints. */
  url:       string;
  /** Optional MIME type for routing. Defaults inferred from extension when absent. */
  mime_type?: string;
  /** Optional friendly name (e.g. Discord attachment filename) — surfaced in the
   *  preprocess description so the agent knows what file the user sent. */
  name?:     string;
}

export interface DescribeOptions {
  /** The user's actual question/prompt. Threaded into the vision describer so
   *  the description focuses on what the user cares about (e.g. "extract the
   *  visible text" vs "describe colors and composition"). */
  userPrompt?: string;
  /** Per-call provider override (the agent's vision_provider). When absent,
   *  falls back to the global config.vision.provider. 'openrouter' = Gemini
   *  pipeline, 'hermes' = Grok pipeline, 'voidai' = legacy gpt-4o. */
  provider?: string;
  /** Per-call model override. When absent, resolved per-provider. */
  model?: string;
  /** Agent name — telemetry only (vision_describe hive event). */
  agentName?: string;
  /** Resolved vision mode — telemetry only. */
  mode?: string;
}

/**
 * Describe an image as text. Returns a string suitable for inlining into
 * the agent's user message. On failure returns a short placeholder so the
 * agent at least sees "an image was attached but couldn't be processed"
 * instead of pretending nothing happened.
 */
export async function describeImage(att: ImageAttachment, opts: DescribeOptions = {}): Promise<string> {
  // Resolve the effective provider for THIS call. The per-call override (the
  // agent's vision_provider) wins; otherwise fall back to the global default.
  const provider = opts.provider ?? config.vision.provider;
  if (provider !== 'openrouter' && provider !== 'hermes') {
    logger.warn('vision-service: unknown vision provider, falling back to openrouter/gemini', { provider });
  }
  // Per-provider model resolution. Hermes (grok via the xAI proxy) uses its own
  // model — used for the allowlist agents whose images Gemini refuses. Everything
  // else describes via OpenRouter/Gemini, the universal describer.
  const model =
    opts.model ??
    (provider === 'hermes' ? config.vision.hermesModel : config.vision.openrouterModel);
  const startedAt = Date.now();
  // Build the user-side instruction. If we know the user's actual question,
  // pass it through so the describer prioritizes the right aspects (e.g.
  // OCR text vs visual layout vs UI state).
  const focusLine = opts.userPrompt && opts.userPrompt.trim().length > 0
    ? `The user is asking: "${opts.userPrompt.trim().slice(0, 600)}"\nWrite a description optimized for answering that question. Transcribe any visible text verbatim where relevant.`
    : 'Describe this image, transcribing any visible text verbatim.';
  try {
    // Downscale oversized inline images before sending. The hermes/xAI proxy
    // rejects request bodies over 1 MiB; a large base64 data URI overflows it
    // with a 413. shrinkDataUriIfLarge resizes + recompresses anything over the
    // cap (and is a no-op for small images and remote URLs).
    const imageUrl = await shrinkDataUriIfLarge(att.url);
    // Route to the correct OpenAI-compatible client. Hermes uses its own proxy
    // client; everything else uses the OpenRouter (Gemini) client.
    const llm = provider === 'hermes' ? getHermesProxyClient() : getOpenRouterClient();
    const resp = await llm.chat.completions.create({
      model,
      // 6000 tokens lets the model emit exhaustive descriptions for
      // text-heavy screenshots (Discord/IDE/web UIs) before the post-call
      // slice cap (VISION_MAX_DESCRIPTION_CHARS) cuts off any overflow.
      max_tokens: 6000,
      temperature: 0.2,
      messages: [
        { role: 'system', content: config.vision.prompt },
        {
          role:    'user',
          content: [
            { type: 'text', text: `${att.name ? `Filename: ${att.name}\n` : ''}${focusLine}` },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { type: 'image_url', image_url: { url: imageUrl } } as any,
          ],
        },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? '';
    try {
      logHive('vision_describe', `${provider}/${model}`, undefined, {
        agentName: opts.agentName ?? null, provider, model,
        mode: opts.mode ?? null, latencyMs: Date.now() - startedAt, ok: true,
      });
    } catch { /* telemetry is best-effort — never break the vision path */ }
    return String(text).slice(0, config.vision.maxChars).trim() || '(empty description)';
  } catch (err) {
    logger.warn('vision-service: describeImage failed', { url: att.url.slice(0, 60), provider, model, err: (err as Error).message });
    try {
      logHive('vision_describe', `${provider}/${model} (failed)`, undefined, {
        agentName: opts.agentName ?? null, provider, model,
        mode: opts.mode ?? null, latencyMs: Date.now() - startedAt, ok: false,
      });
    } catch { /* telemetry is best-effort */ }
    return `(failed to describe image${att.name ? ` "${att.name}"` : ''}: ${(err as Error).message.slice(0, 120)})`;
  }
}

/** Describe a list of attachments concurrently. Results preserve input order. */
export async function describeImages(atts: ImageAttachment[], opts: DescribeOptions = {}): Promise<string[]> {
  if (!atts || atts.length === 0) return [];
  return Promise.all(atts.map(a => describeImage(a, opts)));
}

/**
 * Heuristic capability detection — does this (provider, model) combination
 * natively accept image inputs? Default conservative: when uncertain, return
 * false so 'auto' mode falls back to the always-works preprocess path.
 *
 * Update this list as new vision-capable models roll out.
 */
export function modelSupportsVision(provider: string | null | undefined, model: string | null | undefined): boolean {
  const m = (model ?? '').toLowerCase();
  const p = (provider ?? '').toLowerCase();

  // OpenAI-family vision: gpt-4o (and -mini), gpt-4-vision, gpt-4-turbo (current),
  // gpt-5 family. Excludes 3.5-turbo and old text-only davinci.
  if (p === 'openai' || p === 'voidai' || p === '') {
    if (/^gpt-(4o|4\.1|4\.5|5(\.\d+)?)/.test(m)) return true;
    if (/gpt-4-vision/.test(m))                  return true;
    if (/^gemini-(1\.5|2|2\.5|3)/.test(m))       return true;
    if (/^claude-(3|3\.5|3\.7|4)/.test(m))       return true;
    return false;
  }

  // Anthropic API path — Claude 3+ supports images natively. Even though we
  // ROUTE Anthropic through preprocess by default per project preference,
  // this returns true so callers that want native can opt in via vision_mode='native'.
  if (p === 'anthropic') {
    return /^claude-(3|3\.5|3\.7|4|sonnet-4|opus-4|haiku-4)/.test(m);
  }

  // Hermes / xAI proxy — Grok natively supports multi-modal.
  if (p === 'hermes') {
    return /^grok-4/.test(m);
  }

  // CLI providers have flaky multi-modal support in headless mode — keep them on
  // preprocess by default. Returning false here makes 'auto' resolve to
  // preprocess; users can override per-agent with vision_mode='native'.
  if (p === 'codex') return false;
  if (p === 'gemini') return false;

  // Gemini API (OpenAI-compatible endpoint) supports native vision for
  // compatible models via image_url blocks.
  if (p === 'gemini-api') {
    return /^gemini-(1\.5|2|2\.5|3)/.test(m);
  }

  return false;
}

export type VisionMode = 'auto' | 'native' | 'preprocess';

/**
 * Resolve the effective vision mode for an agent. Encapsulates the 'auto'
 * decision so chat paths don't each need to repeat the heuristic.
 */
export function resolveVisionMode(
  agent: { provider?: string | null; model?: string | null; vision_mode?: string | null } | null | undefined,
): 'native' | 'preprocess' {
  const declared = (agent?.vision_mode ?? 'auto') as VisionMode;
  if (declared === 'native')     return 'native';
  if (declared === 'preprocess') return 'preprocess';
  // auto: prefer native when supported, else preprocess
  return modelSupportsVision(agent?.provider ?? null, agent?.model ?? null) ? 'native' : 'preprocess';
}
