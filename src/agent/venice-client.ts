import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: OpenAI | null = null;

// Lazy init — must stay lazy so dotenv loads before we read env vars.
// Recreates the client when the API key changes at runtime (e.g. after a
// .env reload), so no config-watcher wiring is needed.
export function getVeniceClient(): OpenAI {
  const currentKey = config.venice.apiKey;
  if (!client || (client as any)._apiKey !== currentKey) {
    if (!currentKey) {
      logger.warn('Venice client created without API key - set VENICE_API_KEY in .env');
    }
    client = new OpenAI({ apiKey: currentKey, baseURL: config.venice.baseURL });
    (client as any)._apiKey = currentKey;
  }
  return client;
}

// Call when API key changes at runtime (e.g. from config-watcher)
export function resetVeniceClient(): void {
  client = null;
}
