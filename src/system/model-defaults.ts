import { config } from '../config';

/**
 * Resolve the default model for `provider === 'anthropic'` agents when no explicit
 * agent model is set (new-agent seeding, chat-mode default, anthropic runtime default).
 *
 * Why this exists: the literal `'claude-sonnet-4-6'` was hardcoded in ~4 places, which
 * froze anthropic defaults one generation behind whatever the local Claude subscription
 * actually serves (James AI: subscription = Sonnet 5, app handed out Sonnet 4-6).
 *
 * Resolution order:
 *   1. `ANTHROPIC_DEFAULT_MODEL` env override — a zero-code knob for any operator.
 *   2. On a `claude-cli` backend → the floating alias `'sonnet'`. The local `claude`
 *      CLI resolves `--model sonnet` to the subscription's *current* Sonnet, so this
 *      auto-tracks future Anthropic releases and never re-freezes.
 *   3. On an `anthropic-api` backend → a concrete id (the raw API rejects aliases).
 *      Kept as the back-compat literal; operators override via ANTHROPIC_DEFAULT_MODEL.
 *
 * IMPORTANT: only the anthropic / local-Claude lane calls this. The VoidAI-lane sites
 * (config REVIEW_T2_FALLBACK, canvas voidaiClaudeEquivalent) must NOT use it — a
 * `sonnet` alias would 404 against VoidAI; `claude-sonnet-4-6` is a valid VoidAI id.
 */
export function defaultAnthropicModel(): string {
  const override = process.env.ANTHROPIC_DEFAULT_MODEL?.trim();
  if (override) return override;
  if (config.claude.backend === 'claude-cli') return 'sonnet';
  return 'claude-sonnet-4-6';
}
