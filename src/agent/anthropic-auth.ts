import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config';

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

function readCliCredentials(): CliCredentials['claudeAiOauth'] | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CliCredentials;
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

export function resolveAuth(): { token: string; status: AnthropicAuthStatus } {
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
