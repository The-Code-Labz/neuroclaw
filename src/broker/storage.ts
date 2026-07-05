/**
 * broker/storage.ts — pluggable storage adapter (spec v3 §4).
 *
 * v1 ships with `EnvManagerAdapter` that proxies to `system/env-manager.ts`
 * so the broker is immediately usable on top of the existing `.env` file.
 * A future `InfisicalAdapter` can drop in by implementing the same interface
 * — no route changes required.
 *
 * Tags / notes live in a tiny JSON sidecar (`.env.broker-meta.json`) so the
 * env file itself stays clean and dotenv-compatible.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import {
  getEnvVariables,
  getRawEnvValue,
  updateEnvVariables,
  deleteEnvVariable,
} from '../system/env-manager';

export interface StoredSecret {
  name: string;
  tags: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretStorage {
  list(): Promise<StoredSecret[]>;
  getValue(name: string): Promise<string | null>;
  create(name: string, value: string, opts?: { tags?: string[]; notes?: string }): Promise<void>;
  update(name: string, opts: { value?: string; tags?: string[]; notes?: string }): Promise<void>;
  delete(name: string): Promise<void>;
  rotate(name: string, newValue?: string): Promise<void>;
}

const META_PATH = path.resolve(process.cwd(), '.env.broker-meta.json');

interface MetaEntry { tags: string[]; notes: string; createdAt: string; updatedAt: string; }
type MetaFile = Record<string, MetaEntry>;

function readMeta(): MetaFile {
  try {
    if (!fs.existsSync(META_PATH)) return {};
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8')) as MetaFile;
  } catch (err) {
    logger.warn('broker-storage: failed to read meta sidecar', { err: (err as Error).message });
    return {};
  }
}

function writeMeta(meta: MetaFile): void {
  try {
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), { mode: 0o600 });
  } catch (err) {
    logger.error('broker-storage: failed to write meta sidecar', { err: (err as Error).message });
  }
}

const nowIso = () => new Date().toISOString();

export class EnvManagerAdapter implements SecretStorage {
  async list(): Promise<StoredSecret[]> {
    const meta = readMeta();
    const all = getEnvVariables(false);
    return all.map((v) => {
      const m = meta[v.key];
      return {
        name: v.key,
        tags: m?.tags ?? (v.isSecret ? ['secret'] : []),
        notes: m?.notes ?? v.description ?? '',
        createdAt: m?.createdAt ?? '',
        updatedAt: m?.updatedAt ?? '',
      };
    });
  }

  async getValue(name: string): Promise<string | null> {
    return getRawEnvValue(name);
  }

  async create(name: string, value: string, opts: { tags?: string[]; notes?: string } = {}): Promise<void> {
    if (getRawEnvValue(name) !== null) throw new Error(`secret_already_exists: ${name}`);
    const res = updateEnvVariables({ [name]: value }, { backup: true, skipSecretValidation: true });
    if (!res.success) throw new Error(`storage_write_failed: ${res.errors.join('; ')}`);
    const meta = readMeta();
    meta[name] = { tags: opts.tags ?? [], notes: opts.notes ?? '', createdAt: nowIso(), updatedAt: nowIso() };
    writeMeta(meta);
  }

  async update(name: string, opts: { value?: string; tags?: string[]; notes?: string }): Promise<void> {
    if (opts.value !== undefined) {
      const res = updateEnvVariables({ [name]: opts.value }, { backup: true, skipSecretValidation: true });
      if (!res.success) throw new Error(`storage_write_failed: ${res.errors.join('; ')}`);
    }
    const meta = readMeta();
    const cur = meta[name] ?? { tags: [], notes: '', createdAt: nowIso(), updatedAt: nowIso() };
    if (opts.tags !== undefined) cur.tags = opts.tags;
    if (opts.notes !== undefined) cur.notes = opts.notes;
    cur.updatedAt = nowIso();
    meta[name] = cur;
    writeMeta(meta);
  }

  async delete(name: string): Promise<void> {
    const res = deleteEnvVariable(name);
    if (!res.success) throw new Error(`storage_delete_failed: ${res.errors.join('; ')}`);
    const meta = readMeta();
    delete meta[name];
    writeMeta(meta);
  }

  async rotate(name: string, newValue?: string): Promise<void> {
    if (newValue !== undefined) {
      await this.update(name, { value: newValue });
    } else {
      const meta = readMeta();
      const cur = meta[name] ?? { tags: [], notes: '', createdAt: nowIso(), updatedAt: nowIso() };
      cur.updatedAt = nowIso();
      meta[name] = cur;
      writeMeta(meta);
    }
  }
}

let _storage: SecretStorage = new EnvManagerAdapter();
export function setStorage(s: SecretStorage): void { _storage = s; }
export function getStorage(): SecretStorage { return _storage; }
