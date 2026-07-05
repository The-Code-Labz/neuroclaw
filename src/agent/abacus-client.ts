import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: OpenAI | null = null;

// Lazy init — must stay lazy so dotenv loads before we read env vars.
// Recreates the client when the API key changes at runtime (e.g. after a
// .env reload), so no config-watcher wiring is needed.
//
// Abacus AI exposes an OpenAI-compatible router (RouteLLM) at
// https://routellm.abacus.ai/v1. We use it primarily for its media models,
// pulled via the standard /v1/models endpoint.
export function getAbacusClient(): OpenAI {
  const currentKey = config.abacus.apiKey;
  if (!client || (client as any)._apiKey !== currentKey) {
    if (!currentKey) {
      logger.warn('Abacus client created without API key - set ABACUS_API_KEY in .env');
    }
    client = new OpenAI({ apiKey: currentKey, baseURL: config.abacus.baseURL });
    (client as any)._apiKey = currentKey;
  }
  return client;
}

// Call when API key changes at runtime (e.g. from config-watcher)
export function resetAbacusClient(): void {
  client = null;
}
