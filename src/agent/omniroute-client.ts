import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: OpenAI | null = null;

// Lazy init — must stay lazy so dotenv loads before we read env vars.
// Recreates the client when the API key changes at runtime (e.g. after a
// .env reload), so no config-watcher wiring is needed.
//
// OmniRoute is a self-hosted, OpenAI-compatible AI gateway (default
// http://localhost:20128/v1). It fans one endpoint out to 200+ upstream
// providers with auto-fallback + RTK/Caveman compression. Like Ollama it is
// a LOCAL service: an API key is optional (REQUIRE_API_KEY defaults false in
// the gateway), so a missing key is not an error — an offline gateway simply
// fails at chat time. We pass a placeholder key when none is set because the
// OpenAI SDK requires a non-empty apiKey string.
export function getOmniRouteClient(): OpenAI {
  const currentKey = config.omniroute.apiKey;
  if (!client || (client as any)._apiKey !== currentKey) {
    client = new OpenAI({
      apiKey:  currentKey || 'omniroute-no-key',
      baseURL: config.omniroute.baseURL,
    });
    (client as any)._apiKey = currentKey;
    logger.info('OmniRoute client initialised', { baseURL: config.omniroute.baseURL, keyed: !!currentKey });
  }
  return client;
}

// Call when the API key / base URL changes at runtime (e.g. from config-watcher)
export function resetOmniRouteClient(): void {
  client = null;
}
