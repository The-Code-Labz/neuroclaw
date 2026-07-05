import OpenAI from 'openai';
import { config } from '../config';

let client: OpenAI | null = null;

export function getOllamaClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey:  'ollama',
      baseURL: config.ollama.baseURL,
    });
  }
  return client;
}

export function resetOllamaClient(): void {
  client = null;
}
