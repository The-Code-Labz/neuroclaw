import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

interface CliCredentials {
  claudeAiOauth: {
    accessToken:      string;
    refreshToken:     string;
    expiresAt:        number;
    subscriptionType: string;
    rateLimitTier:    string;
  };
}

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

export type AnthropicAuthSource = 'api_key' | 'cli_oauth' | 'none';

export interface AnthropicAuthStatus {
  source:            AnthropicAuthSource;
  subscriptionType?: string;
  expiresAt?:        number;
  expired?:          boolean;
}

let client:      Anthropic | null    = null;
let cachedToken: string              = '';
let authStatus:  AnthropicAuthStatus = { source: 'none' };

function readCliCredentials(): CliCredentials['claudeAiOauth'] | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CliCredentials;
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function resolveAuth(): { token: string; status: AnthropicAuthStatus } {
  if (config.anthropic.apiKey) {
    return { token: config.anthropic.apiKey, status: { source: 'api_key' } };
  }
  const cliCreds = readCliCredentials();
  if (cliCreds?.accessToken) {
    const expired = Date.now() > cliCreds.expiresAt;
    return {
      token: cliCreds.accessToken,
      status: {
        source:           'cli_oauth',
        subscriptionType: cliCreds.subscriptionType,
        expiresAt:        cliCreds.expiresAt,
        expired,
      },
    };
  }
  return { token: '', status: { source: 'none' } };
}

export function getAnthropicAuthStatus(): AnthropicAuthStatus {
  return resolveAuth().status;
}

/**
 * Direct Anthropic SDK client. Used only when CLAUDE_BACKEND=anthropic-api.
 * Subscription OAuth tokens are NOT usable here — the API gateway rate-limits
 * non-CLI traffic. Use the claude-cli provider for subscription auth.
 */
export function getAnthropicClient(): Anthropic {
  const { token, status } = resolveAuth();

  if (!client || token !== cachedToken) {
    cachedToken = token;
    authStatus  = status;

    if (!token) {
      logger.warn('Anthropic: no API key found — set ANTHROPIC_API_KEY or switch CLAUDE_BACKEND to claude-cli');
      client = new Anthropic({ apiKey: 'no-credentials-found' });
    } else if (status.source === 'cli_oauth') {
      logger.warn('Anthropic: using CLI OAuth via direct API — gateway will throttle. Use CLAUDE_BACKEND=claude-cli instead.');
      client = new Anthropic({ authToken: token });
    } else {
      logger.info('Anthropic: using ANTHROPIC_API_KEY');
      client = new Anthropic({ apiKey: token });
    }
  }

  return client;
}

export function resetAnthropicClient(): void {
  client      = null;
  cachedToken = '';
  authStatus  = { source: 'none' };
}
