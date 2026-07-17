/**
 * broker/bootstrap.ts — initialise the broker at process start.
 *
 * Loads the HMAC key (v1: from `NC_BROKER_HMAC_KEY` env var, base64-encoded;
 * later: from OS keyring per spec §6.1). Auto-generates a key on first run
 * and warns the operator to persist it.
 *
 * Also selects the storage adapter from `NC_BROKER_STORAGE`:
 *   - 'env-manager' (default) — secrets live in .env
 *   - 'infisical'             — self-hosted Infisical (see docker-compose.yml)
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { initTokenKey, isTokenKeyInitialised } from './agentToken';
import { setStorage, getStorage } from './storage';
import { resetClient } from '../agent/openai-client';

const ENV_KEY = 'NC_BROKER_HMAC_KEY';
const KEY_FILE = path.resolve(process.cwd(), '.nc-broker-hmac-key');

let _storageBackend: 'env-manager' | 'infisical' = 'env-manager';
let _storageInitialised = false;
let _initPromise: Promise<{ backend: 'env-manager' | 'infisical' }> | null = null;

/** Which storage backend is currently mounted (after initBrokerStorage). */
export function getStorageBackend(): 'env-manager' | 'infisical' {
  return _storageBackend;
}

/**
 * Initialise the storage adapter from env. Logs (and falls back to env-manager)
 * if the requested backend can't be brought up. Idempotent.
 */
export function initBrokerStorage(): Promise<{ backend: 'env-manager' | 'infisical' }> {
  if (_storageInitialised) return Promise.resolve({ backend: _storageBackend });
  if (_initPromise) return _initPromise;
  _initPromise = _doInitBrokerStorage().finally(() => { _initPromise = null; });
  return _initPromise;
}

async function _doInitBrokerStorage(): Promise<{ backend: 'env-manager' | 'infisical' }> {
  if (_storageInitialised) return { backend: _storageBackend };
  // NOTE: do NOT set _storageInitialised = true here — set it only after the
  // async adapter is fully mounted so concurrent callers don't race past an
  // uninitialized storage adapter.

  const want = (process.env.NC_BROKER_STORAGE ?? 'env-manager').trim().toLowerCase();
  if (want !== 'infisical') {
    _storageBackend = 'env-manager';
    _storageInitialised = true;
    logger.info('broker: storage backend = env-manager (.env)');
    return { backend: 'env-manager' };
  }

  try {
    const { InfisicalAdapter } = await import('./storage-infisical');
    const siteUrl = process.env.NC_BROKER_INFISICAL_SITE_URL ?? 'http://127.0.0.1:8222';
    if (siteUrl.startsWith('http://') && !/^http:\/\/(127\.|localhost|::1|\[::1\])/.test(siteUrl)) {
      logger.warn('broker: NC_BROKER_INFISICAL_SITE_URL uses plain http:// for a non-loopback host — use https:// in production', { siteUrl });
    }
    const clientId = (process.env.NC_BROKER_INFISICAL_CLIENT_ID ?? '').trim();
    const clientSecret = (process.env.NC_BROKER_INFISICAL_CLIENT_SECRET ?? '').trim();
    const projectId = (process.env.NC_BROKER_INFISICAL_PROJECT_ID ?? '').trim();
    const environment = (process.env.NC_BROKER_INFISICAL_ENVIRONMENT ?? 'prod').trim();
    const secretPath = (process.env.NC_BROKER_INFISICAL_PATH ?? '/').trim();

    if (!clientId || !clientSecret || !projectId) {
      throw new Error(
        'missing NC_BROKER_INFISICAL_CLIENT_ID / _CLIENT_SECRET / _PROJECT_ID in .env',
      );
    }

    const adapter = new InfisicalAdapter({
      siteUrl, clientId, clientSecret, projectId, environment, secretPath,
    });

    // Best-effort health probe — log but don't fail boot. The first real
    // request will surface the auth error properly to the caller.
    adapter.ping().then((r) => {
      if (r.ok) {
        logger.info('broker: storage backend = infisical (connected)', {
          siteUrl, environment, secretCount: r.secretCount,
        });
      } else {
        logger.error('broker: Infisical health probe failed', { error: r.error });
      }
    }).catch((err) => {
      logger.error('broker: Infisical health probe threw', { err: err.message });
    });

    setStorage(adapter);
    _storageBackend = 'infisical';
    _storageInitialised = true;  // mark AFTER adapter is fully mounted
    return { backend: 'infisical' };
  } catch (err) {
    // Fail closed — do NOT silently fall back to env-manager when the operator
    // explicitly requested Infisical. Falling back would silently expose whatever
    // secrets happen to be in .env to all broker consumers.
    logger.error(
      'broker: NC_BROKER_STORAGE=infisical but adapter failed to mount — ' +
        'broker storage is CLOSED until server restarts with a working Infisical config',
      { err: (err as Error).message },
    );
    const errMsg = `Infisical adapter failed: ${(err as Error).message}`;
    setStorage({
      list:   () => Promise.reject(new Error(errMsg)),
      getValue: () => Promise.reject(new Error(errMsg)),
      create: () => Promise.reject(new Error(errMsg)),
      update: () => Promise.reject(new Error(errMsg)),
      delete: () => Promise.reject(new Error(errMsg)),
      rotate: () => Promise.reject(new Error(errMsg)),
    });
    _storageBackend = 'infisical';
    _storageInitialised = true;  // mark AFTER storage (even the fail-closed stub) is mounted
    return { backend: 'infisical' };
  }
}

/**
 * Central registry of every broker-managed env-var secret.
 *
 * brokerNames: broker secret name candidates tried in order (first non-empty match wins).
 * envVar:      the process.env key that receives the injected value.
 *
 * Startup rule:  env wins — skip if the var is already set in .env.
 * Rotation rule: always overwrite — the broker is the source of truth after a rotation.
 *
 * To add a new secret: append an entry here. resolveAllSecretsFromBroker() and
 * handleSecretRotation() both use this table — no other changes needed.
 */
export interface SecretRegistryEntry {
  brokerNames: string[];
  envVar: string;
}

export const SECRET_REGISTRY: SecretRegistryEntry[] = [
  // ── Core AI providers ────────────────────────────────────────────────────
  { brokerNames: ['SHARED_VOIDAI_API_KEY',           'NEUROCLAW_VOIDAI_API_KEY'],           envVar: 'VOIDAI_API_KEY' },
  { brokerNames: ['SHARED_VOIDAI_BG_KEY',            'NEUROCLAW_VOIDAI_BG_KEY'],            envVar: 'VOIDAI_BG_API_KEY' },
  { brokerNames: ['SHARED_SKILL_FORGE_API_KEY',     'NEUROCLAW_SKILL_FORGE_API_KEY'],     envVar: 'SKILL_FORGE_API_KEY' },
  { brokerNames: ['SHARED_ANTHROPIC_API_KEY',        'NEUROCLAW_ANTHROPIC_API_KEY'],        envVar: 'ANTHROPIC_API_KEY' },
  { brokerNames: ['SHARED_OPENROUTER_API_KEY',       'NEUROCLAW_OPENROUTER_API_KEY'],       envVar: 'OPENROUTER_API_KEY' },
  { brokerNames: ['SHARED_VENICE_API_KEY',           'NEUROCLAW_VENICE_API_KEY'],           envVar: 'VENICE_API_KEY' },
  { brokerNames: ['SHARED_VENICE_SESSION_TOKEN',     'NEUROCLAW_VENICE_SESSION_TOKEN'],     envVar: 'VENICE_SESSION_TOKEN' },
  { brokerNames: ['SHARED_KIMI_API_KEY',             'NEUROCLAW_KIMI_API_KEY'],             envVar: 'KIMI_API_KEY' },
  { brokerNames: ['SHARED_XAI_API_KEY',              'NEUROCLAW_XAI_API_KEY'],              envVar: 'XAI_API_KEY' },
  // Reserved: opencode uses local binary auth; this key is injected for future API-key mode.
  { brokerNames: ['SHARED_OPENCODE_CLI_KEY',         'NEUROCLAW_OPENCODE_CLI_KEY'],         envVar: 'OPENCODE_CLI_KEY' },
  { brokerNames: ['SHARED_POLLINATIONS_API_KEY',     'NEUROCLAW_POLLINATIONS_API_KEY'],     envVar: 'POLLINATIONS_API_KEY' },

  // ── Observability ────────────────────────────────────────────────────────
  { brokerNames: ['SHARED_LANGFUSE_SECRET_KEY',      'NEUROCLAW_LANGFUSE_SECRET_KEY'],      envVar: 'LANGFUSE_SECRET_KEY' },
  { brokerNames: ['SHARED_LANGFUSE_PUBLIC_KEY',      'NEUROCLAW_LANGFUSE_PUBLIC_KEY'],      envVar: 'LANGFUSE_PUBLIC_KEY' },

  // ── Audio / speech ───────────────────────────────────────────────────────
  { brokerNames: ['SHARED_DEEPGRAM_API_KEY',         'NEUROCLAW_DEEPGRAM_API_KEY'],         envVar: 'DEEPGRAM_API_KEY' },
  { brokerNames: ['SHARED_ELEVENLABS_API_KEY',       'NEUROCLAW_ELEVENLABS_API_KEY'],       envVar: 'ELEVENLABS_API_KEY' },
  { brokerNames: ['SHARED_KOKORO_API_KEY',           'NEUROCLAW_KOKORO_API_KEY'],           envVar: 'KOKORO_API_KEY' },

  // ── Integrations ─────────────────────────────────────────────────────────
  { brokerNames: ['SHARED_DISCORD_BOT_TOKEN',        'NEUROCLAW_DISCORD_BOT_TOKEN'],        envVar: 'DISCORD_BOT_TOKEN' },
  { brokerNames: ['SHARED_BROWSERLESS_TOKEN',        'NEUROCLAW_BROWSERLESS_TOKEN'],        envVar: 'BROWSERLESS_TOKEN' },
  { brokerNames: ['SHARED_COMPOSIO_API_KEY',         'NEUROCLAW_COMPOSIO_API_KEY'],         envVar: 'COMPOSIO_API_KEY' },
  { brokerNames: ['SHARED_N8N_API_KEY',              'NEUROCLAW_N8N_API_KEY',  'LIESE_N8N_API_KEY'],   envVar: 'N8N_API_KEY' },
  { brokerNames: ['SHARED_N8N_URL',                  'NEUROCLAW_N8N_URL'],                  envVar: 'N8N_BASE_URL' },
  { brokerNames: ['SHARED_KESTRA_API_KEY',           'NEUROCLAW_KESTRA_API_KEY'],           envVar: 'KESTRA_API_KEY' },

  // ── Real-time A/V ─────────────────────────────────────────────────────────
  { brokerNames: ['SHARED_LIVEKIT_API_KEY',          'NEUROCLAW_LIVEKIT_API_KEY'],          envVar: 'LIVEKIT_API_KEY' },
  { brokerNames: ['SHARED_LIVEKIT_API_SECRET',       'NEUROCLAW_LIVEKIT_API_SECRET'],       envVar: 'LIVEKIT_API_SECRET' },

  // ── Session tokens (browser auth flows) ──────────────────────────────────
  { brokerNames: ['SHARED_PERPLEXITY_SESSION_TOKEN', 'NEUROCLAW_PERPLEXITY_SESSION_TOKEN'], envVar: 'PERPLEXITY_SESSION_TOKEN' },
  { brokerNames: ['SHARED_PERPLEXITY_CSRF_TOKEN',    'NEUROCLAW_PERPLEXITY_CSRF_TOKEN'],    envVar: 'PERPLEXITY_CSRF_TOKEN' },

  // ── Dashboard ────────────────────────────────────────────────────────────
  { brokerNames: ['SHARED_DASHBOARD_TOKEN',          'NEUROCLAW_DASHBOARD_TOKEN'],          envVar: 'DASHBOARD_TOKEN' },

  // ── Supabase (memory + native KB backends) — NOTE: the broker secret is
  // spelled SUPABASE_SERVICE_ROLE_KEY but the app reads SUPABASE_SERVICE_KEY.
  // Value parity with .env verified (same 180-char service_role JWT). env wins
  // at boot, so this is additive: it lets a SUPABASE_SERVICE_ROLE_KEY rotation
  // propagate via the webhook and enables a future .env strip. (SUPABASE_URL is
  // not in Infisical, so it intentionally stays .env-only.)
  { brokerNames: ['SUPABASE_SERVICE_ROLE_KEY', 'SHARED_SUPABASE_SERVICE_ROLE_KEY'], envVar: 'SUPABASE_SERVICE_KEY' },

  // ── Inngest (durable job queue) — NOTE: Infisical keys are spelled INGEST_* ─
  { brokerNames: ['INGEST_EVENT_KEY',   'SHARED_INGEST_EVENT_KEY'],   envVar: 'INNGEST_EVENT_KEY' },
  { brokerNames: ['INGEST_SIGNING_KEY', 'SHARED_INGEST_SIGNING_KEY'], envVar: 'INNGEST_SIGNING_KEY' },

  // ── Cloudflare R2 (Media gallery object storage). S3-compatible; the endpoint
  // is derived from the account id (https://<account>.r2.cloudflarestorage.com),
  // so no separate endpoint secret is needed. Values are .trim()'d on inject,
  // which also strips the trailing newline the bucket name was pasted with.
  { brokerNames: ['R2_ACCOUNT_ID',        'SHARED_R2_ACCOUNT_ID'],        envVar: 'R2_ACCOUNT_ID' },
  { brokerNames: ['R2_ACCESS_KEY_ID',     'SHARED_R2_ACCESS_KEY_ID'],     envVar: 'R2_ACCESS_KEY_ID' },
  { brokerNames: ['R2_SECRET_ACCESS_KEY', 'SHARED_R2_SECRET_ACCESS_KEY'], envVar: 'R2_SECRET_ACCESS_KEY' },
  { brokerNames: ['R2_BUCKET_NAME',       'SHARED_R2_BUCKET_NAME'],       envVar: 'R2_BUCKET_NAME' },

  // ── MinIO (NeuroArchive — long-term reusable asset store). Self-hosted,
  // S3-compatible. Requires forcePathStyle:true (MinIO, unlike R2/AWS, needs
  // path-style addressing unless a wildcard DNS/virtual-host setup exists).
  { brokerNames: ['MINIO_ENDPOINT',    'SHARED_MINIO_ENDPOINT'],    envVar: 'MINIO_ENDPOINT' },
  { brokerNames: ['MINIO_ACCESS_KEY',  'SHARED_MINIO_ACCESS_KEY'],  envVar: 'MINIO_ACCESS_KEY' },
  { brokerNames: ['MINIO_SECRET_KEY',  'SHARED_MINIO_SECRET_KEY'],  envVar: 'MINIO_SECRET_KEY' },
  { brokerNames: ['MINIO_BUCKET_NAME', 'SHARED_MINIO_BUCKET_NAME'], envVar: 'MINIO_BUCKET_NAME' },

  // ── Media job providers (async image/video/music). Keys live in the broker
  // only; hydrated into process.env at boot so config.kie/config.fal read them
  // like any other provider. Never written to .env.
  { brokerNames: ['KIE_API_KEY', 'SHARED_KIE_API_KEY'], envVar: 'KIE_API_KEY' },
  { brokerNames: ['FAL_API_KEY', 'SHARED_FAL_API_KEY'], envVar: 'FAL_API_KEY' },
  // fal balance (usage panel) is ADMIN-key gated — a SEPARATE key from the queue
  // key above. Optional; when present the fal.ai usage panel lights up.
  { brokerNames: ['FAL_ADMIN_API_KEY', 'SHARED_FAL_ADMIN_API_KEY', 'SHARED_FAL_ADMIN_KEY'], envVar: 'FAL_ADMIN_API_KEY' },

  // ── Canva MCP (official, per-user OAuth 2.1 + PKCE — see mcp/canva-oauth.ts).
  // CLIENT_ID/SECRET are static (from DCR self-registration against
  // https://mcp.canva.com/register, one-time, done by an operator). The
  // ACCESS/REFRESH/EXPIRES entries are LIVE credentials written back to the
  // broker by canva-oauth.ts after the operator completes the browser
  // consent flow (and on every subsequent refresh) — the broker stays the
  // source of truth across restarts, same contract as every other secret
  // here, just with a non-human writer.
  { brokerNames: ['CANVA_CLIENT_ID',          'SHARED_CANVA_CLIENT_ID'],          envVar: 'CANVA_CLIENT_ID' },
  { brokerNames: ['CANVA_CLIENT_SECRET',      'SHARED_CANVA_CLIENT_SECRET'],      envVar: 'CANVA_CLIENT_SECRET' },
  { brokerNames: ['CANVA_ACCESS_TOKEN',       'SHARED_CANVA_ACCESS_TOKEN'],       envVar: 'CANVA_ACCESS_TOKEN' },
  { brokerNames: ['CANVA_REFRESH_TOKEN',      'SHARED_CANVA_REFRESH_TOKEN'],      envVar: 'CANVA_REFRESH_TOKEN' },
  { brokerNames: ['CANVA_TOKEN_EXPIRES_AT',   'SHARED_CANVA_TOKEN_EXPIRES_AT'],   envVar: 'CANVA_TOKEN_EXPIRES_AT' },
  // Marks which CLIENT_ID was registered via loopback DCR (see
  // mcp/canva-oauth.ts isLoopbackClientRegistered()) — rehydrated at boot so
  // the invariant survives a restart, same as the creds above.
  { brokerNames: ['CANVA_LOOPBACK_CLIENT_ID', 'SHARED_CANVA_LOOPBACK_CLIENT_ID'], envVar: 'CANVA_LOOPBACK_CLIENT_ID' },
];

/**
 * Resolve all registry secrets from broker at startup.
 * Skips any entry whose env var is already set in .env (env wins — don't clobber).
 * Must be called after initBrokerStorage().
 */
export async function resolveAllSecretsFromBroker(): Promise<void> {
  for (const { brokerNames, envVar } of SECRET_REGISTRY) {
    if (process.env[envVar]?.trim()) continue;
    for (const name of brokerNames) {
      try {
        const val = await getStorage().getValue(name);
        if (val?.trim()) {
          process.env[envVar] = val.trim();
          logger.info(`broker: resolved ${envVar} from ${name}`);
          break;
        }
      } catch (err) {
        logger.warn(`broker: error reading ${name}`, { err: (err as Error).message });
      }
    }
  }
}

/**
 * Re-inject a known env-var-backed secret after a rotation webhook fires.
 * Always overwrites process.env — broker is the source of truth after rotation.
 * Resets cached OpenAI clients when VoidAI-backed keys change so the next call
 * picks up the new key (the OpenAI SDK caches the key at construction time).
 * Returns true if the secret name was recognised and successfully re-injected.
 */

// Keys whose rotation must invalidate the cached OpenAI client instances.
const OPENAI_CLIENT_KEYS = new Set(['VOIDAI_API_KEY', 'VOIDAI_BG_API_KEY', 'SKILL_FORGE_API_KEY']);

export async function handleSecretRotation(secretName: string): Promise<boolean> {
  const entry = SECRET_REGISTRY.find((e) => e.brokerNames.includes(secretName));
  if (!entry) return false;

  try {
    const val = await getStorage().getValue(secretName);
    if (val?.trim()) {
      process.env[entry.envVar] = val.trim();
      logger.info(`broker: rotated ${entry.envVar} from ${secretName}`);
      if (OPENAI_CLIENT_KEYS.has(entry.envVar)) {
        resetClient();
        logger.info('broker: OpenAI client cache cleared after VoidAI key rotation');
      }
      if (entry.envVar === 'INNGEST_EVENT_KEY' || entry.envVar === 'INNGEST_SIGNING_KEY') {
        // The Inngest client snapshots env at construction; re-sync so the rotated
        // key takes effect without a restart (see refreshInngestEnv()).
        void import('../system/inngest-client').then(({ refreshInngestEnv }) => refreshInngestEnv());
        logger.info('broker: Inngest client env re-synced after key rotation');
      }
      if (entry.envVar === 'SUPABASE_SERVICE_KEY') {
        // The Supabase client (memory + KB backends) caches the service key at
        // construction; drop it so the next getSupabase() re-mints with the new
        // key — otherwise rotation silently breaks Supabase auth until restart.
        void import('../db/supabase').then(({ resetSupabase }) => resetSupabase());
        logger.info('broker: Supabase client reset after service key rotation');
      }
      return true;
    }
    logger.warn(`broker: ${secretName} rotated but value is empty — ${entry.envVar} unchanged`);
  } catch (err) {
    logger.warn(`broker: error re-reading ${secretName} during rotation`, { err: (err as Error).message });
  }
  return false;
}

export async function resolveN8nConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  if (!process.env.N8N_API_KEY?.trim()) {
    const candidates = ['N8N_API_KEY', 'SHARED_N8N_API_KEY'];
    for (const name of candidates) {
      try {
        const val = await getStorage().getValue(name);
        if (val?.trim()) {
          process.env.N8N_API_KEY = val.trim();
          logger.info(`broker: resolved N8N API key from ${name}`);
          break;
        }
      } catch (err) {
        logger.warn('broker: error reading N8N API key candidate', { name, err: (err as Error).message });
      }
    }
  }
  return {
    baseUrl: process.env.N8N_BASE_URL?.trim() || 'http://localhost:5678',
    apiKey:  process.env.N8N_API_KEY?.trim()  || '',
  };
}

export function initBrokerHmacKey(): { source: 'env' | 'file' | 'generated' } {
  if (isTokenKeyInitialised()) return { source: 'env' };

  const envVal = process.env[ENV_KEY];
  if (envVal && envVal.trim()) {
    try {
      const buf = Buffer.from(envVal.trim(), 'base64');
      if (buf.length !== 32) throw new Error(`expected 32 raw bytes (base64), got ${buf.length}`);
      initTokenKey(buf);
      logger.info('broker: HMAC key loaded from env');
      return { source: 'env' };
    } catch (err) {
      logger.error('broker: NC_BROKER_HMAC_KEY env var is malformed; falling back to key file', {
        err: (err as Error).message,
      });
    }
  }

  if (fs.existsSync(KEY_FILE)) {
    try {
      const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 32) {
        initTokenKey(buf);
        logger.info('broker: HMAC key loaded from .nc-broker-hmac-key');
        return { source: 'file' };
      }
      logger.warn('broker: .nc-broker-hmac-key wrong length, regenerating');
    } catch (err) {
      logger.warn('broker: failed to read .nc-broker-hmac-key, regenerating', {
        err: (err as Error).message,
      });
    }
  }

  const newKey = randomBytes(32);
  const b64 = newKey.toString('base64');
  try {
    fs.writeFileSync(KEY_FILE, b64 + '\n', { mode: 0o600 });
  } catch (err) {
    logger.error('broker: failed to persist generated HMAC key', { err: (err as Error).message });
  }
  initTokenKey(newKey);
  logger.warn(
    'broker: generated a new HMAC key at .nc-broker-hmac-key — ' +
      'copy this to NC_BROKER_HMAC_KEY in .env and into 1Password to persist across rebuilds',
  );
  return { source: 'generated' };
}
