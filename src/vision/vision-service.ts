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
import { getClient as getOpenAi } from '../agent/openai-client';

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
}

/**
 * Describe an image as text. Returns a string suitable for inlining into
 * the agent's user message. On failure returns a short placeholder so the
 * agent at least sees "an image was attached but couldn't be processed"
 * instead of pretending nothing happened.
 */
export async function describeImage(att: ImageAttachment, opts: DescribeOptions = {}): Promise<string> {
  const model = config.vision.model;
  // Build the user-side instruction. If we know the user's actual question,
  // pass it through so the describer prioritizes the right aspects (e.g.
  // OCR text vs visual layout vs UI state).
  const focusLine = opts.userPrompt && opts.userPrompt.trim().length > 0
    ? `The user is asking: "${opts.userPrompt.trim().slice(0, 600)}"\nWrite a description optimized for answering that question. Transcribe any visible text verbatim where relevant.`
    : 'Describe this image, transcribing any visible text verbatim.';
  try {
    // We use the OpenAI client even for non-OpenAI providers because most
    // OpenAI-compatible endpoints (including VoidAI) accept the image_url
    // content-block format. If VISION_PROVIDER is set to 'anthropic' we'd
    // route through the Anthropic SDK instead — left as a v1.8 enhancement.
    const resp = await getOpenAi().chat.completions.create({
      model,
      // 800 tokens was too tight for text-heavy screenshots (Discord/IDE/web UIs);
      // 2000 lines up with the post-call slice cap so we don't truncate mid-sentence.
      max_tokens: 2000,
      temperature: 0.2,
      messages: [
        { role: 'system', content: config.vision.prompt },
        {
          role:    'user',
          content: [
            { type: 'text', text: `${att.name ? `Filename: ${att.name}\n` : ''}${focusLine}` },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { type: 'image_url', image_url: { url: att.url } } as any,
          ],
        },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? '';
    return String(text).slice(0, config.vision.maxChars).trim() || '(empty description)';
  } catch (err) {
    logger.warn('vision-service: describeImage failed', { url: att.url.slice(0, 60), model, err: (err as Error).message });
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

  // Codex via subscription has flaky multi-modal support — keep it on
  // preprocess by default. Returning false here makes 'auto' resolve to
  // preprocess; users can override per-agent with vision_mode='native'.
  if (p === 'codex') return false;

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
