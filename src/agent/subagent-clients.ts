// src/agent/subagent-clients.ts
// OpenAI-compatible clients for the native sub-agent routes:
//   - Kimi for Coding (Moonshot) — code tasks
//   - MiniMax (direct)           — prose / general tasks
// Both reuse the existing main-agent keys (KIMI_ANTHROPIC_KEY / MINIMAX_ANTHROPIC_KEY).
// Lazily constructed and rebuilt when the key changes (config hot-reload).
import OpenAI from 'openai';
import { config } from '../config';
import { resolveFamilyBaseURL } from '../system/subagent-providers-store';

let kimiClient: OpenAI | null = null;
let minimaxClient: OpenAI | null = null;

/**
 * Thrown when a sub-agent family is selected but has no key configured. The
 * runner treats this as a skip-and-failover, not a fatal error — it should
 * never fire in practice because routes are pre-filtered by isFamilyEnabled(),
 * but the guard makes the misconfiguration explicit instead of a silent 401.
 */
export class SubAgentFamilyUnconfiguredError extends Error {
  constructor(public readonly family: string) {
    super(`sub-agent ${family} family is not configured (no API key)`);
    this.name = 'SubAgentFamilyUnconfiguredError';
  }
}

export function getSubAgentKimiClient(): OpenAI {
  const { apiKey, userAgent } = config.subAgent.kimi;
  // baseURL is resolved through the store so a live dashboard endpoint override
  // (Settings › Sub-Agents) repoints the family with no restart. Key unchanged.
  const baseURL = resolveFamilyBaseURL('kimi');
  if (!apiKey) throw new SubAgentFamilyUnconfiguredError('kimi');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!kimiClient || (kimiClient as any)._key !== apiKey || (kimiClient as any)._baseURL !== baseURL) {
    // Kimi's /coding endpoint only serves recognized coding agents — the
    // User-Agent override is what unlocks it (a plain SDK UA gets 403).
    kimiClient = new OpenAI({ apiKey, baseURL, defaultHeaders: { 'User-Agent': userAgent } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (kimiClient as any)._key = apiKey;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (kimiClient as any)._baseURL = baseURL;
  }
  return kimiClient;
}

export function getSubAgentMinimaxClient(): OpenAI {
  const { apiKey } = config.subAgent.minimax;
  const baseURL = resolveFamilyBaseURL('minimax');
  if (!apiKey) throw new SubAgentFamilyUnconfiguredError('minimax');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!minimaxClient || (minimaxClient as any)._key !== apiKey || (minimaxClient as any)._baseURL !== baseURL) {
    minimaxClient = new OpenAI({ apiKey, baseURL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (minimaxClient as any)._key = apiKey;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (minimaxClient as any)._baseURL = baseURL;
  }
  return minimaxClient;
}

export function resetSubAgentClients(): void {
  kimiClient = null;
  minimaxClient = null;
}
