import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import { resolveAuth, getAnthropicAuthStatus, type AnthropicAuthStatus, type AnthropicAuthSource } from './anthropic-auth';

let client:      Anthropic | null    = null;
let cachedToken: string              = '';

/**
 * Direct Anthropic SDK client. Used only when CLAUDE_BACKEND=anthropic-api.
 * Subscription OAuth tokens are NOT usable here — the API gateway rate-limits
 * non-CLI traffic. Use the claude-cli provider for subscription auth.
 */
export function getAnthropicClient(): Anthropic {
  const { token, status } = resolveAuth();

  if (!client || token !== cachedToken) {
    cachedToken = token;

    if (!token) {
      logger.warn('Anthropic: no API key found — set ANTHROPIC_API_KEY or switch CLAUDE_BACKEND to claude-cli');
      client = new Anthropic({ apiKey: 'no-credentials-found' });
    } else if (status.source === 'cli_oauth') {
      logger.warn('Anthropic: using CLI OAuth via direct API — gateway will throttle. Use CLAUDE_BACKEND=claude-cli instead.');
      client = new Anthropic({ authToken: token });
    } else {
      logger.info('Anthropic: using ANTHROPIC_API_KEY');
      client = new Anthropic({ apiKey: token });
    }
  }

  return client;
}

export function resetAnthropicClient(): void {
  client      = null;
  cachedToken = '';
}

export { getAnthropicAuthStatus, type AnthropicAuthStatus, type AnthropicAuthSource };
