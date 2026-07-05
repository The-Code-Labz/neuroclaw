import OpenAI from 'openai';
import { Agent } from 'undici';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: OpenAI | null = null;

// The heartbeat Ollama endpoint sits behind Traefik serving a Cloudflare-origin
// cert that Node's default CA bundle can't chain, so the TLS handshake fails
// with a network-level "Connection error." and every heartbeat reports fail.
// We relax cert verification ONLY for this client, and ONLY for requests whose
// hostname matches the configured base URL — never globally (no
// NODE_TLS_REJECT_UNAUTHORIZED, which would weaken TLS for every provider).
let _insecureDispatcher: Agent | null = null;
function getInsecureDispatcher(): Agent {
  if (!_insecureDispatcher) {
    _insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return _insecureDispatcher;
}

function hostOf(u: string): string {
  try { return new URL(u).hostname; } catch { return ''; }
}

// Lazy init — must stay lazy so dotenv loads before we read env vars.
// Recreates the client when the API key changes at runtime (e.g. after a
// .env reload), so no config-watcher wiring is needed.
export function getHeartbeatOllamaClient(): OpenAI {
  const currentKey = config.heartbeatOllama.apiKey;
  const currentBaseURL = config.heartbeatOllama.baseURL;
  if (
    !client ||
    (client as any)._apiKey !== currentKey ||
    (client as any)._baseURL !== currentBaseURL
  ) {
    if (!currentKey) {
      logger.warn('Heartbeat Ollama client created without API key — set HEARTBEAT_OLLAMA_API_KEY in .env');
    }
    const trustedHost = hostOf(currentBaseURL);
    client = new OpenAI({
      apiKey:  currentKey,
      baseURL: currentBaseURL,
      // Skip cert verification for the internal heartbeat host only (self-signed
      // Traefik/Cloudflare-origin cert). Any other host falls through to normal
      // verified fetch, so this can't silently relax TLS elsewhere.
      fetch: (url: any, init?: any) => {
        const reqHost = hostOf(typeof url === 'string' ? url : (url?.url ?? String(url)));
        if (trustedHost && reqHost === trustedHost) {
          return fetch(url, { ...(init ?? {}), dispatcher: getInsecureDispatcher() } as any);
        }
        return fetch(url, init);
      },
    });
    (client as any)._apiKey = currentKey;
    (client as any)._baseURL = currentBaseURL;
  }
  return client;
}

// Call when API key changes at runtime (e.g. from config-watcher)
export function resetHeartbeatOllamaClient(): void {
  client = null;
}
