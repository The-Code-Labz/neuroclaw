import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: OpenAI | null = null;

// Lazy init — must stay lazy so dotenv loads before we read env vars.
// LiteLLM exposes an OpenAI-compatible proxy, so we reuse the same SDK.
export function getLiteLlmClient(): OpenAI {
  const currentKey = config.litellm.apiKey;
  if (!client || (client as any)._apiKey !== currentKey) {
    if (!currentKey) {
      logger.warn('LiteLLM client created without API key — set LITELLM_API_KEY in .env');
    }
    client = new OpenAI({ apiKey: currentKey, baseURL: config.litellm.baseURL });
    (client as any)._apiKey = currentKey;
  }
  return client;
}

// Call when API key changes at runtime (e.g. from config-watcher)
export function resetLiteLlmClient(): void {
  client = null;
}
