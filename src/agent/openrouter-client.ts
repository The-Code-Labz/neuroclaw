import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: OpenAI | null = null;

// Lazy init — must stay lazy so dotenv loads before we read env vars
export function getOpenRouterClient(): OpenAI {
  // Always recreate if API key changed (e.g., after .env reload)
  const currentKey = config.openrouter.apiKey;
  
  if (!client || (client as any)._apiKey !== currentKey) {
    if (!currentKey) {
      logger.warn('OpenRouter client created without API key - set OPENROUTER_API_KEY in .env');
    }
    
    client = new OpenAI({
      apiKey:  currentKey,
      baseURL: config.openrouter.baseURL,
      defaultHeaders: {
        // OpenRouter requires these headers
        'HTTP-Referer': 'https://neuroclaw.local',
        'X-Title':      'NeuroClaw',
        // Explicitly set Authorization header in case OpenAI SDK doesn't
        ...(currentKey ? { 'Authorization': `Bearer ${currentKey}` } : {}),
      },
    });
    
    // Store key for comparison on next call
    (client as any)._apiKey = currentKey;
  }
  return client;
}

// Call when API key changes at runtime (e.g. from config-watcher)
export function resetOpenRouterClient(): void {
  client = null;
}
