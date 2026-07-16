// src/system/subagent-providers-store.ts
//
// Per-family live override store for sub-agent provider selection (Layer 4).
//
// The sub-agent runner routes code tasks to one provider family (kimi) and prose
// tasks to another (minimax), with a dynamic fallback chain built from whichever
// families are ENABLED. Three independent knobs, each layered the same way —
// dashboard override (if set) wins, otherwise fall back to the env default:
//
//   enabled  — "is family X usable at all?" (also gated by key presence — an
//              empty key 401s every request, so a keyless family is never
//              usable no matter what this says).
//   model    — which model string to send.
//   baseURL  — which OpenAI-compatible endpoint the family's existing key
//              authenticates against (lets an operator repoint kimi/minimax
//              at a proxy/mirror without touching .env).
//
// The dashboard lets an operator change any of these LIVE from Settings ›
// Sub-Agents without editing .env or restarting — the runner/client factories
// call resolveFamilyEnabled()/resolveFamilyModel()/resolveFamilyBaseURL() on
// every task, and this module caches the DB rows in memory (invalidated on
// write) so it stays cheap.
//
// This is the single source of truth for "how do I reach family X?" — the
// runner, the client factories, and the API route all read it, so there's no
// second place for the logic to drift.

import { getDb } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

export type SubAgentFamily = 'kimi' | 'minimax';
export const SUB_AGENT_FAMILIES: SubAgentFamily[] = ['kimi', 'minimax'];

interface FamilyConfig {
  label:      string;
  role:       string;   // human-facing "what this family is for"
  model:      string;   // env default model
  baseURL:    string;   // env default base URL
  apiKey:     string;
  envDefault: boolean;   // config.subAgent.<family>.enabled
}

function familyConfig(family: string): FamilyConfig | null {
  if (family === 'kimi') {
    return {
      label:      'Kimi',
      role:       'code tasks (primary)',
      model:      config.subAgent.kimi.model,
      baseURL:    config.subAgent.kimi.baseURL,
      apiKey:     config.subAgent.kimi.apiKey,
      envDefault: config.subAgent.kimi.enabled,
    };
  }
  if (family === 'minimax') {
    return {
      label:      'MiniMax',
      role:       'prose / general tasks (primary)',
      model:      config.subAgent.minimax.model,
      baseURL:    config.subAgent.minimax.baseURL,
      apiKey:     config.subAgent.minimax.apiKey,
      envDefault: config.subAgent.minimax.enabled,
    };
  }
  return null;
}

interface FamilyOverrideRow {
  enabled?:  boolean;
  model?:    string;
  baseURL?:  string;
}

// ── In-memory override cache (lazy-loaded, invalidated on write) ───────────
let cache: Map<string, FamilyOverrideRow> | null = null;

function ensureLoaded(): Map<string, FamilyOverrideRow> {
  if (cache) return cache;
  const c = new Map<string, FamilyOverrideRow>();
  try {
    const rows = getDb()
      .prepare('SELECT family, enabled, model, base_url FROM subagent_providers')
      .all() as Array<{ family: string; enabled: number; model: string | null; base_url: string | null }>;
    for (const r of rows) {
      c.set(r.family, {
        enabled: !!r.enabled,
        model:   r.model    || undefined,
        baseURL: r.base_url || undefined,
      });
    }
  } catch (e) {
    // Table may not exist yet on a very early call — treat as "no overrides".
    logger.warn('subagent-providers-store: override load failed', { error: String(e) });
  }
  cache = c;
  return cache;
}

function upsertOverride(family: string, patch: Partial<{ enabled: number; model: string | null; base_url: string | null }>): void {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  // Insert the row with sane defaults if it doesn't exist yet, then apply the
  // patch on conflict — lets each of enabled/model/baseURL be set independently
  // without clobbering the others.
  getDb()
    .prepare(
      `INSERT INTO subagent_providers (family, enabled, model, base_url, updated_at)
       VALUES (@family, COALESCE(@enabled, 1), @model, @base_url, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(family) DO UPDATE SET
         enabled    = COALESCE(@enabled, subagent_providers.enabled),
         model      = CASE WHEN @modelSet    = 1 THEN @model    ELSE subagent_providers.model    END,
         base_url   = CASE WHEN @baseUrlSet  = 1 THEN @base_url ELSE subagent_providers.base_url END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    )
    .run({
      family,
      enabled:    'enabled' in patch ? patch.enabled : null,
      model:      'model' in patch ? patch.model : null,
      base_url:   'base_url' in patch ? patch.base_url : null,
      modelSet:   'model' in patch ? 1 : 0,
      baseUrlSet: 'base_url' in patch ? 1 : 0,
    });
}

/**
 * The dashboard enable/disable override for a family, or `undefined` if none
 * has been set (in which case the env/key-presence default applies).
 */
export function getFamilyOverride(family: string): boolean | undefined {
  const c = ensureLoaded();
  return c.get(family)?.enabled;
}

/**
 * Canonical "is this family usable for routing?" — the single source of truth.
 * Usable only if a key is present AND (dashboard override ?? env default) is on.
 */
export function resolveFamilyEnabled(family: string): boolean {
  const fc = familyConfig(family);
  if (!fc) return false;
  if (!fc.apiKey) return false;              // no key ⇒ never usable
  const override = getFamilyOverride(family);
  return override !== undefined ? override : fc.envDefault;
}

/**
 * Canonical "which model does this family use?" — dashboard override, else
 * the env default (config.subAgent.<family>.model).
 */
export function resolveFamilyModel(family: string): string {
  const fc = familyConfig(family);
  if (!fc) throw new Error(`unknown sub-agent family: ${family}`);
  const override = ensureLoaded().get(family)?.model;
  return override || fc.model;
}

/**
 * Canonical "which endpoint does this family authenticate against?" —
 * dashboard override, else the env default (config.subAgent.<family>.baseURL).
 */
export function resolveFamilyBaseURL(family: string): string {
  const fc = familyConfig(family);
  if (!fc) throw new Error(`unknown sub-agent family: ${family}`);
  const override = ensureLoaded().get(family)?.baseURL;
  return override || fc.baseURL;
}

/**
 * Persist a live enable/disable for a family and update the cache immediately,
 * so the very next sub-agent task respects it (no restart). Enabling a family
 * with no API key is rejected — it would just 401.
 */
export function setFamilyEnabled(family: string, enabled: boolean): void {
  const fc = familyConfig(family);
  if (!fc) throw new Error(`unknown sub-agent family: ${family}`);
  if (enabled && !fc.apiKey) {
    throw new Error(`cannot enable "${family}" — no API key configured for this family`);
  }
  upsertOverride(family, { enabled: enabled ? 1 : 0 });
  const c = ensureLoaded();
  c.set(family, { ...c.get(family), enabled });
  logger.info('subagent-providers-store: family toggled', { family, enabled });
}

/**
 * Persist a live model override for a family (or clear it with `null`/empty
 * string) and update the cache immediately — no restart required.
 */
export function setFamilyModel(family: string, model: string | null): void {
  const fc = familyConfig(family);
  if (!fc) throw new Error(`unknown sub-agent family: ${family}`);
  const normalized = model?.trim() || null;
  upsertOverride(family, { model: normalized });
  const c = ensureLoaded();
  const row = { ...c.get(family) };
  if (normalized) row.model = normalized; else delete row.model;
  c.set(family, row);
  logger.info('subagent-providers-store: model override set', { family, model: normalized });
}

/**
 * Persist a live base-URL override for a family (or clear it with `null`/empty
 * string) and update the cache immediately — no restart required. Does not
 * touch the API key; the family's existing key is reused against the new URL.
 */
export function setFamilyBaseURL(family: string, baseURL: string | null): void {
  const fc = familyConfig(family);
  if (!fc) throw new Error(`unknown sub-agent family: ${family}`);
  const normalized = baseURL?.trim() || null;
  if (normalized) {
    try { new URL(normalized); }
    catch { throw new Error(`invalid base URL: ${normalized}`); }
  }
  upsertOverride(family, { base_url: normalized });
  const c = ensureLoaded();
  const row = { ...c.get(family) };
  if (normalized) row.baseURL = normalized; else delete row.baseURL;
  c.set(family, row);
  logger.info('subagent-providers-store: baseURL override set', { family, baseURL: normalized });
}

/**
 * Full status for every known family — for the Settings › Sub-Agents panel.
 * Never leaks the key itself, only whether one is present.
 */
export function listSubAgentProviderStatus() {
  return SUB_AGENT_FAMILIES.map((family) => {
    const fc = familyConfig(family)!;
    const row = ensureLoaded().get(family);
    return {
      family,
      label:           fc.label,
      role:            fc.role,
      keyPresent:      !!fc.apiKey,
      envDefault:      fc.envDefault,
      enabledOverride: row?.enabled === undefined ? null : row.enabled,
      enabled:         resolveFamilyEnabled(family),
      modelDefault:    fc.model,
      modelOverride:   row?.model ?? null,
      baseURLDefault:  fc.baseURL,
      baseURLOverride: row?.baseURL ?? null,
    };
  });
}
