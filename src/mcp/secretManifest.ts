/**
 * mcp/secretManifest.ts — MCP secret manifest parser (spec v3 §7.3).
 *
 *     mcp: my-server
 *     secrets:
 *       - SHARED_SUPABASE_URL
 *       - NEUROCLAW_DATABASE_URL
 *
 *     rotation:
 *       strategy: sighup    # sighup | restart | none
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/logger';
import { parseName } from '../broker/nameParser';

export type RotationStrategy = 'sighup' | 'restart' | 'none';

export interface McpSecretManifest {
  mcp: string;
  secrets: string[];
  rotation: { strategy: RotationStrategy };
  path: string;
}

const DEFAULT_ROTATION: RotationStrategy = 'sighup';

export function loadManifest(manifestPath: string): McpSecretManifest {
  const abs = path.resolve(manifestPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`mcp-manifest: file not found: ${abs}`);
  }

  let raw: string;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (err) { throw new Error(`mcp-manifest: read failed: ${(err as Error).message}`); }

  let parsed: unknown;
  try { parsed = parseYaml(raw); }
  catch (err) { throw new Error(`mcp-manifest: invalid YAML in ${abs}: ${(err as Error).message}`); }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`mcp-manifest: root must be a mapping in ${abs}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.mcp !== 'string' || !obj.mcp.trim()) {
    throw new Error(`mcp-manifest: 'mcp' must be a non-empty string in ${abs}`);
  }
  if (!Array.isArray(obj.secrets)) {
    throw new Error(`mcp-manifest: 'secrets' must be an array in ${abs}`);
  }

  const secrets: string[] = [];
  for (let i = 0; i < obj.secrets.length; i++) {
    const s = obj.secrets[i];
    if (typeof s !== 'string' || !s.trim()) {
      throw new Error(`mcp-manifest: secrets[${i}] must be a non-empty string in ${abs}`);
    }
    const name = s.trim();
    secrets.push(name);
    if (!parseName(name)) {
      logger.warn('mcp-manifest: secret name does not match SCOPE_SERVICE_TYPE', {
        mcp: obj.mcp, name, path: abs,
      });
    }
  }

  let rotation: { strategy: RotationStrategy } = { strategy: DEFAULT_ROTATION };
  if (obj.rotation !== undefined) {
    if (!obj.rotation || typeof obj.rotation !== 'object') {
      throw new Error(`mcp-manifest: 'rotation' must be a mapping in ${abs}`);
    }
    const r = obj.rotation as Record<string, unknown>;
    const strat = r.strategy;
    if (strat !== 'sighup' && strat !== 'restart' && strat !== 'none') {
      throw new Error(
        `mcp-manifest: rotation.strategy must be 'sighup'|'restart'|'none' in ${abs} (got: ${String(strat)})`,
      );
    }
    rotation = { strategy: strat };
  }

  return { mcp: obj.mcp.trim(), secrets, rotation, path: abs };
}

export function findManifestForEntrypoint(entrypoint: string): string | null {
  const dir = path.dirname(path.resolve(entrypoint));
  const base = path.basename(entrypoint, path.extname(entrypoint));
  const candidates = [path.join(dir, `${base}.secrets.yaml`), path.join(dir, 'secrets.yaml')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
