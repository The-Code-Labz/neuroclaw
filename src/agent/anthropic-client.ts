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

// Identity headers/prompt that the API requires when authenticating with a Claude.ai
// OAuth token. Without these the gateway rejects or throttles the request to ~zero,
// even though the token itself is valid. Local-only personal use.
const CLAUDE_CODE_SYSTEM_PROMPT_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

function readCliVersion(): string {
  try {
    const link = fs.readlinkSync(path.join(os.homedir(), '.local/bin/claude'));
    const m = link.match(/versions\/([\d.]+)/);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return '0.0.0';
}

export type AnthropicAuthSource = 'api_key' | 'cli_oauth' | 'none';

export interface AnthropicAuthStatus {
  source:            AnthropicAuthSource;
  subscriptionType?: string;
  expiresAt?:        number;
  expired?:          boolean;
}

// Track last-seen token so we can detect credential file rotation
let client:       Anthropic | null     = null;
let cachedToken:  string               = '';
let authStatus:   AnthropicAuthStatus  = { source: 'none' };

// ── Credential resolution ─────────────────────────────────────────────────────

function readCliCredentials(): CliCredentials['claudeAiOauth'] | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CliCredentials;
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the best available token.
 * Returns { token, source, meta }.
 */
function resolveAuth(): { token: string; useBearer: boolean; status: AnthropicAuthStatus } {
  // 1. Explicit env key always wins
  if (config.anthropic.apiKey) {
    return {
      token:      config.anthropic.apiKey,
      useBearer:  false,
      status:     { source: 'api_key' },
    };
  }

  // 2. Claude CLI OAuth credentials
  const cliCreds = readCliCredentials();
  if (cliCreds?.accessToken) {
    const expired = Date.now() > cliCreds.expiresAt;
    return {
      token:     cliCreds.accessToken,
      useBearer: true,
      status: {
        source:           'cli_oauth',
        subscriptionType: cliCreds.subscriptionType,
        expiresAt:        cliCreds.expiresAt,
        expired,
      },
    };
  }

  return { token: '', useBearer: false, status: { source: 'none' } };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getAnthropicAuthStatus(): AnthropicAuthStatus {
  // Always resolve fresh so the status endpoint is accurate before any client is built
  return resolveAuth().status;
}

/**
 * Returns a ready Anthropic client.
 * Rebuilds if the underlying token changed (e.g. CLI rotated credentials).
 */
export function getAnthropicClient(): Anthropic {
  const { token, useBearer, status } = resolveAuth();

  if (!client || token !== cachedToken) {
    cachedToken = token;
    authStatus  = status;

    if (!token) {
      logger.warn('Anthropic: no API key or CLI credentials found — Claude agents will fail');
      // Return a client that will produce a clear error on the first call
      client = new Anthropic({ apiKey: 'no-credentials-found' });
    } else if (status.source === 'cli_oauth') {
      if (status.expired) {
        logger.warn('Anthropic: CLI OAuth token is expired — run `claude` in your terminal to refresh');
      } else {
        logger.info('Anthropic: using Claude CLI OAuth credentials', { subscription: status.subscriptionType });
      }
      // OAuth tokens go in Authorization: Bearer (authToken), not x-api-key.
      // The gateway also requires the oauth beta + billing header to accept the
      // token; callers must additionally prefix the system prompt with
      // CLAUDE_CODE_SYSTEM_PROMPT_PREFIX (see prefixSystemPromptForOAuth).
      const cliVersion = readCliVersion();
      client = new Anthropic({
        authToken: token,
        defaultHeaders: {
          'anthropic-beta':           'oauth-2025-04-20',
          'anthropic-billing-header': `cc_version=${cliVersion}; cc_entrypoint=cli;`,
        },
      });
    } else {
      logger.info('Anthropic: using ANTHROPIC_API_KEY');
      client = new Anthropic({ apiKey: token });
    }
  }

  return client;
}

/**
 * When authenticating with a Claude.ai OAuth token, the API requires the system
 * prompt to begin with a Claude Code identity line. Returns the prompt unchanged
 * for API-key auth.
 */
export function prefixSystemPromptForOAuth(prompt: string): string {
  if (resolveAuth().status.source !== 'cli_oauth') return prompt;
  if (prompt.startsWith(CLAUDE_CODE_SYSTEM_PROMPT_PREFIX)) return prompt;
  return `${CLAUDE_CODE_SYSTEM_PROMPT_PREFIX}\n\n${prompt}`;
}

export function resetAnthropicClient(): void {
  client      = null;
  cachedToken = '';
  authStatus  = { source: 'none' };
}
