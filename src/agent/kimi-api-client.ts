import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: OpenAI | null = null;
let cachedKey = '';
let cachedUrl = '';

/**
 * Kimi Code API client (OpenAI-compatible endpoint).
 *
 * Moonshot's Kimi Code exposes an OpenAI-compatible chat completions endpoint
 * at https://api.kimi.com/coding/v1 with a single stable model: kimi-for-coding.
 *
 * Agent provider === 'kimi-api' routes through this client; provider === 'kimi'
 * stays on the CLI subprocess path.
 */
export function getKimiApiClient(): OpenAI {
  const key = config.kimiApi.apiKey;
  const url = config.kimiApi.baseURL;

  if (!client || cachedKey !== key || cachedUrl !== url) {
    if (!key) {
      logger.warn('Kimi API client created without API key — set KIMI_API_KEY in .env');
    }

    client = new OpenAI({
      apiKey: key || 'no-key',
      baseURL: url,
      defaultHeaders: { 'User-Agent': 'claude-code/1.0' },
    });

    cachedKey = key;
    cachedUrl = url;
  }

  return client;
}

export function resetKimiApiClient(): void {
  client = null;
  cachedKey = '';
  cachedUrl = '';
}
