import OpenAI from 'openai';
import { config } from '../config';

let client: OpenAI | null = null;
let cachedUrl: string | null = null;

// Lazy init — proxy URL can change at runtime via .env reload.
// No API key needed: the proxy accepts any bearer token and attaches
// real xAI credentials from ~/.hermes/auth.json.
export function getHermesProxyClient(): OpenAI {
  const url = config.hermes.proxyUrl;
  if (!client || cachedUrl !== url) {
    client = new OpenAI({ apiKey: 'hermes-proxy', baseURL: url });
    cachedUrl = url;
  }
  return client;
}

export function resetHermesProxyClient(): void {
  client = null;
  cachedUrl = null;
}
