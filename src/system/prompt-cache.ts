import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

/**
 * Returns true only for providers that accept Anthropic-style cache_control
 * headers. Sending these headers to other providers can cause request errors.
 *
 * Hardcoded safe set — add a new entry here when a provider is confirmed to
 * support explicit caching.
 */
export function supportsExplicitCache(provider: string, model: string): boolean {
  if (provider === 'anthropic' && config.claude.backend === 'anthropic-api') return true;
  if (provider === 'openrouter' && model.startsWith('anthropic/')) return true;
  return false;
}

/**
 * Builds the Anthropic SDK `system` array with cache_control on the stable
 * block. The stable block (base prompt + team section + skills) rarely changes
 * within a session, so Anthropic caches it for 5 minutes after the first turn.
 *
 * Dynamic content (memory block, cross-session notes, per-turn context) is
 * placed in a second block with no cache_control — it changes every turn.
 *
 * If dynamicContext is empty or whitespace-only, returns a single-element array.
 */
export function buildCachedSystemBlocks(
  stablePrompt: string,
  dynamicContext: string,
): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type:          'text',
      text:          stablePrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (dynamicContext.trim()) {
    blocks.push({ type: 'text', text: dynamicContext });
  }
  return blocks;
}
