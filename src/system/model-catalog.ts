import { getDb, logAudit } from '../db';
import { getClient } from '../agent/openai-client';
import { config } from '../config';
import { logger } from '../utils/logger';

// Live model catalog. Refreshed hourly from each provider's /v1/models endpoint
// (when available) or seeded from a hardcoded list. Tier is auto-classified by
// name pattern unless the user has explicitly pinned an override.

export type ModelTier = 'low' | 'mid' | 'high';
export type ModelProvider = 'voidai' | 'anthropic' | 'codex';

export interface ModelCatalogRow {
  id:                  string;
  provider:            string;
  model_id:            string;
  tier:                ModelTier;
  tier_overridden:     number;
  context_window:      number | null;
  is_available:        number;
  last_seen_at:        string | null;
  created_at:          string;
  updated_at:          string;
  cost_per_1k_input:   number | null;
  cost_per_1k_output:  number | null;
  price_overridden:    number;
}

// ── Known prices (USD per 1K tokens) ────────────────────────────────────────
// Patterns checked in order; first match wins. Update when new models ship.

interface PriceEntry { pattern: RegExp; input: number; output: number }

const KNOWN_PRICES: PriceEntry[] = [
  // Anthropic
  { pattern: /opus-4/i,         input: 15.00, output: 75.00 },
  { pattern: /opus-3/i,         input: 15.00, output: 75.00 },
  { pattern: /sonnet-4/i,       input:  3.00, output: 15.00 },
  { pattern: /sonnet-3-?7/i,    input:  3.00, output: 15.00 },
  { pattern: /sonnet-3-?5/i,    input:  3.00, output: 15.00 },
  { pattern: /sonnet/i,         input:  3.00, output: 15.00 },
  { pattern: /haiku-4/i,        input:  1.00, output:  5.00 },
  { pattern: /haiku-3-?5/i,     input:  0.80, output:  4.00 },
  { pattern: /haiku/i,          input:  0.25, output:  1.25 },
  // OpenAI
  { pattern: /^gpt-5\.1/i,      input: 10.00, output: 30.00 },
  { pattern: /^gpt-5/i,          input: 10.00, output: 30.00 },
  { pattern: /^gpt-4\.5/i,      input: 75.00, output:150.00 },
  { pattern: /gpt-4o-mini/i,    input:  0.15, output:  0.60 },
  { pattern: /gpt-4o/i,         input:  2.50, output: 10.00 },
  { pattern: /chatgpt-4o/i,     input:  2.50, output: 10.00 },
  { pattern: /gpt-4-turbo/i,    input: 10.00, output: 30.00 },
  { pattern: /gpt-4/i,          input: 30.00, output: 60.00 },
  { pattern: /gpt-3\.5/i,       input:  0.50, output:  1.50 },
  { pattern: /^o3-mini/i,        input:  3.00, output: 12.00 },
  { pattern: /^o3/i,             input: 60.00, output:240.00 },
  { pattern: /^o1-mini/i,        input:  3.00, output: 12.00 },
  { pattern: /^o1/i,             input: 15.00, output: 60.00 },
  // Google
  { pattern: /gemini-2.*flash/i, input: 0.075, output: 0.30 },
  { pattern: /gemini-1\.5-flash/i, input: 0.075, output: 0.30 },
  { pattern: /gemini-1\.5-pro/i, input: 1.25, output:  5.00 },
  { pattern: /gemini.*ultra/i,  input:  7.00, output: 21.00 },
  // DeepSeek / Qwen / Mistral / Llama families — rough approximations
  { pattern: /deepseek-v3/i,    input:  0.14, output:  0.28 },
  { pattern: /deepseek-r1/i,    input:  0.55, output:  2.19 },
  { pattern: /qwen-?2.*72b/i,    input:  0.40, output:  1.20 },
  { pattern: /llama-3.*70b/i,    input:  0.59, output:  0.79 },
  { pattern: /mistral-large/i,  input:  2.00, output:  6.00 },
];

// Tier fallbacks for completely unknown models — rough rates so budget queries
// still produce a number. Conservative high-tier estimate.
const TIER_FALLBACK: Record<ModelTier, { input: number; output: number }> = {
  high: { input: 15.00, output: 60.00 },
  mid:  { input:  3.00, output: 12.00 },
  low:  { input:  0.50, output:  1.50 },
};

export function priceFor(modelId: string, tier: ModelTier): { input: number; output: number; source: 'known' | 'tier' } {
  for (const e of KNOWN_PRICES) {
    if (e.pattern.test(modelId)) return { input: e.input, output: e.output, source: 'known' };
  }
  const fb = TIER_FALLBACK[tier];
  return { input: fb.input, output: fb.output, source: 'tier' };
}

// ── Tier classifier ─────────────────────────────────────────────────────────

const HIGH_PATTERNS = [
  /opus/i,
  /\bo[1-9]\b/i,
  /^o[1-9]/i,
  /gpt-5/i,
  /gpt-4\.5/i,
  /\bultra\b/i,
  /405b/i,
  /llama-3.*70b/i,
  /llama-4/i,
  /gemini-.*ultra/i,
  /\bsonar-pro\b/i,
  /reasoner/i,
];

const LOW_PATTERNS = [
  /haiku/i,
  /-mini/i,
  /-nano/i,
  /gpt-3\.5/i,
  /gpt-4o-mini/i,
  /\bflash\b/i,
  /flash-lite/i,
  /1b\b/i,
  /3b\b/i,
  /7b\b/i,
  /8b\b/i,
  /\bphi-/i,
  /tiny/i,
  /\bsmall\b/i,
];

export function classifyTier(modelId: string): ModelTier {
  // LOW patterns checked first so size-suffixed cheaper variants (e.g.
  // gpt-5-mini, claude-haiku-4-5) don't get caught by their base-model HIGH
  // regex (e.g. /gpt-5/, /opus/).
  for (const p of LOW_PATTERNS)  if (p.test(modelId)) return 'low';
  for (const p of HIGH_PATTERNS) if (p.test(modelId)) return 'high';
  return 'mid';
}

// ── Refresh ─────────────────────────────────────────────────────────────────

export async function refreshCatalog(provider: ModelProvider = 'voidai'): Promise<{ added: number; updated: number; missing: number }> {
  if (provider === 'voidai')    return refreshVoidAi();
  if (provider === 'anthropic') return refreshAnthropic();
  if (provider === 'codex')     return refreshCodex();
  return { added: 0, updated: 0, missing: 0 };
}

async function refreshVoidAi(): Promise<{ added: number; updated: number; missing: number }> {
  const db = getDb();
  let modelIds: string[] = [];
  try {
    // VoidAI is OpenAI-compatible — /v1/models is the standard list endpoint.
    // The OpenAI SDK exposes it as client.models.list().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await getClient().models.list();
    const data = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelIds = data.map((m: any) => String(m?.id ?? m?.model ?? '')).filter(Boolean);
  } catch (err) {
    logger.warn('model-catalog: VoidAI /v1/models failed', { error: (err as Error).message });
    return { added: 0, updated: 0, missing: 0 };
  }

  return upsertSeen('voidai', modelIds);
}

async function refreshAnthropic(): Promise<{ added: number; updated: number; missing: number }> {
  // Anthropic doesn't expose a public list endpoint as of writing; seed
  // from the latest known models.
  const ids = [
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-7-sonnet-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
  ];
  return upsertSeen('anthropic', ids);
}

async function refreshCodex(): Promise<{ added: number; updated: number; missing: number }> {
  // Codex CLI / ChatGPT subscription doesn't expose a public list endpoint.
  // Codex's backend tightly restricts which models route through ChatGPT-account
  // auth — only the "modern Codex models" enum (gpt-5.x family) is accepted.
  // Everything else (gpt-5, gpt-5-codex, o3, gpt-4o, gpt-4.1, etc.) returns
  //   "The '<model>' model is not supported when using Codex with a ChatGPT account."
  // Verified against this account May 2026; matches OpenClaw's
  // isModernCodexModel() allowlist in extensions/codex/provider.ts.
  const ids = [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.2',
  ];
  return upsertSeen('codex', ids);
}

function upsertSeen(provider: string, modelIds: string[]): { added: number; updated: number; missing: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const seen = new Set(modelIds);
  let added = 0;
  let updated = 0;

  const insert = db.prepare(`
    INSERT INTO model_catalog (id, provider, model_id, tier, tier_overridden, is_available, last_seen_at,
                               cost_per_1k_input, cost_per_1k_output)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      is_available       = 1,
      last_seen_at       = excluded.last_seen_at,
      updated_at         = datetime('now'),
      tier               = CASE WHEN tier_overridden = 1 THEN tier ELSE excluded.tier END,
      cost_per_1k_input  = CASE WHEN price_overridden = 1 THEN cost_per_1k_input  ELSE excluded.cost_per_1k_input  END,
      cost_per_1k_output = CASE WHEN price_overridden = 1 THEN cost_per_1k_output ELSE excluded.cost_per_1k_output END
  `);
  for (const modelId of modelIds) {
    const id = `${provider}:${modelId}`;
    const tier = classifyTier(modelId);
    const price = priceFor(modelId, tier);
    const before = db.prepare('SELECT id FROM model_catalog WHERE id = ?').get(id);
    insert.run(id, provider, modelId, tier, now, price.input, price.output);
    if (before) updated++; else added++;
  }

  // Mark anything else for this provider as missing.
  const provRows = db.prepare('SELECT id, model_id FROM model_catalog WHERE provider = ?').all(provider) as { id: string; model_id: string }[];
  let missing = 0;
  const markMissing = db.prepare(`UPDATE model_catalog SET is_available = 0, updated_at = datetime('now') WHERE id = ?`);
  for (const row of provRows) {
    if (!seen.has(row.model_id)) {
      markMissing.run(row.id);
      missing++;
    }
  }

  logAudit('model_catalog_refresh', 'model_catalog', undefined, { provider, added, updated, missing, total_seen: modelIds.length });
  logger.info('model-catalog: refresh complete', { provider, added, updated, missing, total: modelIds.length });
  return { added, updated, missing };
}

// ── Public read API ─────────────────────────────────────────────────────────

export interface ListCatalogOpts {
  provider?:     string;
  tier?:         ModelTier;
  includeUnavailable?: boolean;
}

export function listCatalog(opts: ListCatalogOpts = {}): ModelCatalogRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.provider) { where.push('provider = ?'); args.push(opts.provider); }
  if (opts.tier)     { where.push('tier = ?');     args.push(opts.tier); }
  if (!opts.includeUnavailable) where.push('is_available = 1');
  const sql = `
    SELECT * FROM model_catalog
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY provider ASC, tier ASC, model_id ASC
  `;
  return getDb().prepare(sql).all(...args) as ModelCatalogRow[];
}

export function setPriceOverride(provider: string, modelId: string, input: number | null, output: number | null): void {
  const id = `${provider}:${modelId}`;
  if (input === null && output === null) {
    // Reset → re-derive on next refresh.
    getDb().prepare(`
      UPDATE model_catalog
      SET price_overridden = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  } else {
    getDb().prepare(`
      UPDATE model_catalog
      SET price_overridden   = 1,
          cost_per_1k_input  = ?,
          cost_per_1k_output = ?,
          updated_at         = datetime('now')
      WHERE id = ?
    `).run(input, output, id);
  }
  logAudit('model_price_override', 'model_catalog', id, { input, output });
}

export function setTierOverride(provider: string, modelId: string, tier: ModelTier | null): void {
  const id = `${provider}:${modelId}`;
  if (tier === null) {
    // Reset override; auto-classify will reapply on next refresh.
    getDb().prepare(`
      UPDATE model_catalog
      SET tier_overridden = 0, tier = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(classifyTier(modelId), id);
  } else {
    getDb().prepare(`
      UPDATE model_catalog
      SET tier_overridden = 1, tier = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(tier, id);
  }
  logAudit('model_tier_override', 'model_catalog', id, { tier });
}

// ── Background refresh scheduler ────────────────────────────────────────────

let refreshTimer: NodeJS.Timeout | null = null;

export function startCatalogRefresh(): void {
  // Run immediately, then every hour.
  void runAll();
  refreshTimer = setInterval(() => { void runAll(); }, 60 * 60 * 1000);
}

export function stopCatalogRefresh(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function runAll(): Promise<void> {
  if (config.voidai.apiKey) {
    try { await refreshCatalog('voidai'); } catch (err) { logger.warn('catalog refresh failed', { provider: 'voidai', err: (err as Error).message }); }
  }
  // Anthropic + Codex are seeded lists — refresh just keeps timestamps current.
  try { await refreshCatalog('anthropic'); } catch (err) { logger.warn('catalog refresh failed', { provider: 'anthropic', err: (err as Error).message }); }
  try { await refreshCatalog('codex');     } catch (err) { logger.warn('catalog refresh failed', { provider: 'codex',     err: (err as Error).message }); }
}
