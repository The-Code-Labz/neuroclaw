import OpenAI from 'openai';
import { config } from '../config';

let client: OpenAI | null = null;

// Lazy init — must stay lazy so dotenv loads before we read env vars
export function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey:  config.voidai.apiKey,
      baseURL: config.voidai.baseURL,
    });
  }
  return client;
}

// Call when API key changes at runtime (e.g. from config-watcher)
export function resetClient(): void {
  client = null;
}
