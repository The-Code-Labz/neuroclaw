/**
 * broker/storage-infisical.ts — Infisical-backed SecretStorage (spec v3 §4).
 *
 * Drop-in replacement for `EnvManagerAdapter`. Selected via the env switch
 * `NC_BROKER_STORAGE=infisical` (see bootstrap.ts).
 *
 * Auth model: Universal Auth machine identity (client_id + client_secret).
 * Tokens auto-renew every `RENEW_INTERVAL_MS`; if renew fails we fall back to
 * a fresh login on the next call.
 *
 * Notes:
 *   - All secrets live in environment "prod" at path "/" by default. Override
 *     with NC_BROKER_INFISICAL_ENVIRONMENT and NC_BROKER_INFISICAL_PATH.
 *   - Tags are stored as `metadata.tags = "tag1,tag2"` on each Infisical
 *     secret. Infisical's tag system requires preregistration on the project
 *     side which we can't bootstrap automatically — metadata strings work
 *     everywhere out of the box.
 *   - Notes round-trip via `secretComment`.
 *   - `rotate()` without a value just bumps `metadata.lastRotatedAt` so the
 *     dashboard rotation timestamp updates without changing the value.
 */
import { InfisicalSDK } from '@infisical/sdk';
import { logger } from '../utils/logger';
import type { SecretStorage, StoredSecret } from './storage';

const RENEW_INTERVAL_MS = 9 * 60 * 1000; // re-login every 9 minutes (tokens last 10)

export interface InfisicalAdapterOptions {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment?: string;
  secretPath?: string;
}

export class InfisicalAdapter implements SecretStorage {
  private sdk: InfisicalSDK;
  private opts: Required<InfisicalAdapterOptions>;
  private lastLogin = 0;

  constructor(opts: InfisicalAdapterOptions) {
    if (!opts.siteUrl) throw new Error('InfisicalAdapter: siteUrl required');
    if (!opts.clientId) throw new Error('InfisicalAdapter: clientId required');
    if (!opts.clientSecret) throw new Error('InfisicalAdapter: clientSecret required');
    if (!opts.projectId) throw new Error('InfisicalAdapter: projectId required');

    this.opts = {
      siteUrl: opts.siteUrl,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      projectId: opts.projectId,
      environment: opts.environment ?? 'prod',
      secretPath: opts.secretPath ?? '/',
    };
    this.sdk = new InfisicalSDK({ siteUrl: this.opts.siteUrl });
  }

  /** Authenticate or refresh the SDK access token. Idempotent / cheap. */
  private async ensureAuth(): Promise<void> {
    const age = Date.now() - this.lastLogin;
    if (this.lastLogin === 0 || age > RENEW_INTERVAL_MS) {
      try {
        await this.sdk.auth().universalAuth.login({
          clientId: this.opts.clientId,
          clientSecret: this.opts.clientSecret,
        });
        this.lastLogin = Date.now();
      } catch (err) {
        throw new Error(`infisical_auth_failed: ${(err as Error).message}`);
      }
    }
  }

  /** One-shot health probe — pings the API and returns project metadata or null. */
  async ping(): Promise<{ ok: true; secretCount: number } | { ok: false; error: string }> {
    try {
      await this.ensureAuth();
      const res = await this.sdk.secrets().listSecrets({
        projectId: this.opts.projectId,
        environment: this.opts.environment,
        secretPath: this.opts.secretPath,
        viewSecretValue: false,
      });
      return { ok: true, secretCount: res.secrets?.length ?? 0 };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async list(): Promise<StoredSecret[]> {
    await this.ensureAuth();
    const res = await this.sdk.secrets().listSecrets({
      projectId: this.opts.projectId,
      environment: this.opts.environment,
      secretPath: this.opts.secretPath,
      viewSecretValue: false,
    });
    return (res.secrets ?? []).map((s) => parseRowMeta(s));
  }

  async getValue(name: string): Promise<string | null> {
    await this.ensureAuth();
    try {
      const sec = await this.sdk.secrets().getSecret({
        projectId: this.opts.projectId,
        environment: this.opts.environment,
        secretPath: this.opts.secretPath,
        secretName: name,
        viewSecretValue: true,
      });
      if (sec?.secretValue == null) {
        logger.warn('broker(infisical): getSecret returned without a value', {
          name, env: this.opts.environment, path: this.opts.secretPath,
          secKeys: sec ? Object.keys(sec as object) : null,
        });
      }
      return sec?.secretValue ?? null;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const treatedAsNotFound = /not.?found|404/i.test(msg);
      logger.warn('broker(infisical): getSecret threw', {
        name, env: this.opts.environment, treatedAsNotFound, msg,
      });
      if (treatedAsNotFound) return null;
      throw err;
    }
  }

  async create(
    name: string,
    value: string,
    opts: { tags?: string[]; notes?: string } = {},
  ): Promise<void> {
    await this.ensureAuth();
    try {
      await this.sdk.secrets().createSecret(name, {
        projectId: this.opts.projectId,
        environment: this.opts.environment,
        secretPath: this.opts.secretPath,
        secretValue: value,
        secretComment: opts.notes ?? '',
        metadata: encodeMeta({ tags: opts.tags ?? [], createdAt: nowIso() }),
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/exist|duplicate|conflict/i.test(msg)) {
        throw new Error(`secret_already_exists: ${name}`);
      }
      throw new Error(`storage_write_failed: ${msg}`);
    }
  }

  async update(
    name: string,
    upd: { value?: string; tags?: string[]; notes?: string },
  ): Promise<void> {
    await this.ensureAuth();
    // Read current secret first so we can preserve unchanged metadata fields
    // (Infisical replaces metadata wholesale on updateSecret).
    let current: StoredSecret | null = null;
    try {
      const sec = await this.sdk.secrets().getSecret({
        projectId: this.opts.projectId,
        environment: this.opts.environment,
        secretPath: this.opts.secretPath,
        secretName: name,
        viewSecretValue: false,
      });
      current = parseRowMeta(sec);
    } catch {
      throw new Error(`secret_not_found: ${name}`);
    }

    const tags = upd.tags ?? current?.tags ?? [];
    const notes = upd.notes ?? current?.notes ?? '';
    const meta = encodeMeta({
      tags,
      createdAt: current?.createdAt || nowIso(),
      lastRotatedAt: nowIso(),
    });

    const payload: Record<string, unknown> = {
      projectId: this.opts.projectId,
      environment: this.opts.environment,
      secretPath: this.opts.secretPath,
      secretComment: notes,
      metadata: meta,
    };
    if (typeof upd.value === 'string') payload.secretValue = upd.value;

    try {
      // Cast: the SDK's UpdateSecretOptions is exact-typed but we want to pass
      // metadata which is part of BaseSecretOptions. Cast through unknown to
      // keep TS happy without dropping strict mode.
      await this.sdk.secrets().updateSecret(name, payload as Parameters<InfisicalSDK['secrets']>[number] extends never ? never : Parameters<ReturnType<InfisicalSDK['secrets']>['updateSecret']>[1]);
    } catch (err) {
      throw new Error(`storage_write_failed: ${(err as Error).message}`);
    }
  }

  async delete(name: string): Promise<void> {
    await this.ensureAuth();
    try {
      await this.sdk.secrets().deleteSecret(name, {
        projectId: this.opts.projectId,
        environment: this.opts.environment,
        secretPath: this.opts.secretPath,
      });
    } catch (err) {
      throw new Error(`storage_delete_failed: ${(err as Error).message}`);
    }
  }

  async rotate(name: string, newValue?: string): Promise<void> {
    if (newValue !== undefined) {
      await this.update(name, { value: newValue });
      return;
    }
    // Metadata-only rotation: bump lastRotatedAt without touching the value.
    await this.update(name, {});
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Metadata helpers
// ────────────────────────────────────────────────────────────────────────────

interface SecretMeta {
  tags: string[];
  createdAt: string;
  lastRotatedAt?: string;
}

/**
 * Encode SecretMeta as the flat string-map Infisical accepts.
 * (Infisical metadata is `Record<string, string>`; arrays must be serialised.)
 */
function encodeMeta(meta: SecretMeta): Record<string, string> {
  const out: Record<string, string> = {
    tags: meta.tags.join(','),
    createdAt: meta.createdAt,
  };
  if (meta.lastRotatedAt) out.lastRotatedAt = meta.lastRotatedAt;
  return out;
}

interface InfisicalSecretLike {
  secretKey?: string;
  secretValue?: string;
  secretComment?: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  metadata?: Record<string, unknown> | null;
}

function parseRowMeta(s: InfisicalSecretLike): StoredSecret {
  const meta = (s.metadata ?? {}) as Record<string, unknown>;
  const tagStr = typeof meta.tags === 'string' ? meta.tags : '';
  const tags = tagStr ? tagStr.split(',').filter(Boolean) : [];
  const createdMeta = typeof meta.createdAt === 'string' ? meta.createdAt : '';
  const rotatedMeta = typeof meta.lastRotatedAt === 'string' ? meta.lastRotatedAt : '';

  return {
    name: s.secretKey ?? '',
    tags,
    notes: s.secretComment ?? '',
    createdAt: createdMeta || toIso(s.createdAt),
    updatedAt: rotatedMeta || toIso(s.updatedAt) || toIso(s.createdAt),
  };
}

function toIso(v: string | Date | undefined): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  return v;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Silence unused-import warnings in case `logger` is dead-code-eliminated.
void logger;
