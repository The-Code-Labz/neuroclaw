// src/agent/subagent-clients.ts
// OpenAI-compatible clients for the native sub-agent routes:
//   - Kimi for Coding (Moonshot) — code tasks
//   - MiniMax (direct)           — prose / general tasks
// Both reuse the existing main-agent keys (KIMI_ANTHROPIC_KEY / MINIMAX_ANTHROPIC_KEY).
// Lazily constructed and rebuilt when the key changes (config hot-reload).
import OpenAI from 'openai';
import { config } from '../config';

let kimiClient: OpenAI | null = null;
let minimaxClient: OpenAI | null = null;

export function getSubAgentKimiClient(): OpenAI {
  const { apiKey, baseURL, userAgent } = config.subAgent.kimi;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!kimiClient || (kimiClient as any)._key !== apiKey) {
    // Kimi's /coding endpoint only serves recognized coding agents — the
    // User-Agent override is what unlocks it (a plain SDK UA gets 403).
    kimiClient = new OpenAI({ apiKey, baseURL, defaultHeaders: { 'User-Agent': userAgent } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (kimiClient as any)._key = apiKey;
  }
  return kimiClient;
}

export function getSubAgentMinimaxClient(): OpenAI {
  const { apiKey, baseURL } = config.subAgent.minimax;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!minimaxClient || (minimaxClient as any)._key !== apiKey) {
    minimaxClient = new OpenAI({ apiKey, baseURL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (minimaxClient as any)._key = apiKey;
  }
  return minimaxClient;
}

export function resetSubAgentClients(): void {
  kimiClient = null;
  minimaxClient = null;
}
