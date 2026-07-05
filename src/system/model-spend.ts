// model_spend tracking — one row per LLM call.
// Used by the budget guard in pickModelAsync and the future spend panel.

import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { logger } from '../utils/logger';
import { classifyTier } from './model-catalog';

export interface SpendInput {
  provider:      string;
  model_id:      string;
  tier?:         string;
  input_tokens:  number;
  output_tokens: number;
  /** Provider-reported prompt-cache hits (subset of input_tokens). WS1 metric. */
  cached_input_tokens?: number;
  agent_id?:     string | null;
  session_id?:   string | null;
}

export function logSpend(input: SpendInput): void {
  try {
    const tier = input.tier ?? classifyTier(input.model_id);
    getDb().prepare(`
      INSERT INTO model_spend
        (id, provider, model_id, tier, input_tokens, output_tokens, cached_input_tokens, agent_id, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.provider,
      input.model_id,
      tier,
      input.input_tokens,
      input.output_tokens,
      input.cached_input_tokens ?? 0,
      input.agent_id ?? null,
      input.session_id ?? null,
    );
  } catch (err) {
    logger.warn('model-spend: insert failed', { error: (err as Error).message });
  }
}

export interface SpendTotals {
  total_tokens:  number;
  input_tokens:  number;
  output_tokens: number;
  call_count:    number;
}

export function spendForSession(sessionId: string): SpendTotals {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
      COALESCE(SUM(input_tokens), 0)  as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COUNT(*) as call_count
    FROM model_spend WHERE session_id = ?
  `).get(sessionId) as SpendTotals;
  return row;
}

export function spendLastHour(): SpendTotals {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
      COALESCE(SUM(input_tokens), 0)  as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COUNT(*) as call_count
    FROM model_spend WHERE created_at > datetime('now', '-1 hour')
  `).get() as SpendTotals;
  return row;
}

export interface SpendBreakdown {
  tier:         string;
  total_tokens: number;
  call_count:   number;
  est_cost_usd: number;
}

export function spendByTierLastHour(): SpendBreakdown[] {
  return getDb().prepare(`
    SELECT s.tier,
           COALESCE(SUM(s.input_tokens + s.output_tokens), 0) as total_tokens,
           COUNT(*) as call_count,
           COALESCE(SUM(
             (s.input_tokens  / 1000.0) * COALESCE(c.cost_per_1k_input,  0) +
             (s.output_tokens / 1000.0) * COALESCE(c.cost_per_1k_output, 0)
           ), 0) as est_cost_usd
    FROM model_spend s
    LEFT JOIN model_catalog c
      ON c.provider = s.provider AND c.model_id = s.model_id
    WHERE s.created_at > datetime('now', '-1 hour')
    GROUP BY s.tier
    ORDER BY est_cost_usd DESC, total_tokens DESC
  `).all() as SpendBreakdown[];
}

export interface SpendByModel {
  provider:     string;
  model_id:     string;
  tier:         string;
  total_tokens: number;
  call_count:   number;
  est_cost_usd: number;
}

export interface ProviderUsageRow {
  provider:     string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  call_count:   number;
  est_cost_usd: number;
}

export interface ProviderAgentRow {
  provider:   string;
  agent_id:   string | null;
  agent_name: string;
  total_tokens: number;
  call_count:   number;
}

export function spendByModelLastHour(limit = 20): SpendByModel[] {
  return getDb().prepare(`
    SELECT s.provider, s.model_id, s.tier,
           COALESCE(SUM(s.input_tokens + s.output_tokens), 0) as total_tokens,
           COUNT(*) as call_count,
           COALESCE(SUM(
             (s.input_tokens  / 1000.0) * COALESCE(c.cost_per_1k_input,  0) +
             (s.output_tokens / 1000.0) * COALESCE(c.cost_per_1k_output, 0)
           ), 0) as est_cost_usd
    FROM model_spend s
    LEFT JOIN model_catalog c
      ON c.provider = s.provider AND c.model_id = s.model_id
    WHERE s.created_at > datetime('now', '-1 hour')
    GROUP BY s.provider, s.model_id, s.tier
    ORDER BY est_cost_usd DESC, total_tokens DESC
    LIMIT ?
  `).all(limit) as SpendByModel[];
}

export interface SpendCostTotals extends SpendTotals {
  est_cost_usd: number;
}

export function spendForSessionWithCost(sessionId: string): SpendCostTotals {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(s.input_tokens + s.output_tokens), 0) as total_tokens,
      COALESCE(SUM(s.input_tokens), 0)  as input_tokens,
      COALESCE(SUM(s.output_tokens), 0) as output_tokens,
      COUNT(*) as call_count,
      COALESCE(SUM(
        (s.input_tokens  / 1000.0) * COALESCE(c.cost_per_1k_input,  0) +
        (s.output_tokens / 1000.0) * COALESCE(c.cost_per_1k_output, 0)
      ), 0) as est_cost_usd
    FROM model_spend s
    LEFT JOIN model_catalog c
      ON c.provider = s.provider AND c.model_id = s.model_id
    WHERE s.session_id = ?
  `).get(sessionId) as SpendCostTotals;
  return row;
}

export function spendLastHourWithCost(): SpendCostTotals {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(s.input_tokens + s.output_tokens), 0) as total_tokens,
      COALESCE(SUM(s.input_tokens), 0)  as input_tokens,
      COALESCE(SUM(s.output_tokens), 0) as output_tokens,
      COUNT(*) as call_count,
      COALESCE(SUM(
        (s.input_tokens  / 1000.0) * COALESCE(c.cost_per_1k_input,  0) +
        (s.output_tokens / 1000.0) * COALESCE(c.cost_per_1k_output, 0)
      ), 0) as est_cost_usd
    FROM model_spend s
    LEFT JOIN model_catalog c
      ON c.provider = s.provider AND c.model_id = s.model_id
    WHERE s.created_at > datetime('now', '-1 hour')
  `).get() as SpendCostTotals;
  return row;
}

export function spendByProvider(hours: number): ProviderUsageRow[] {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return getDb().prepare(`
    SELECT
      s.provider,
      COALESCE(SUM(s.input_tokens + s.output_tokens), 0) AS total_tokens,
      COALESCE(SUM(s.input_tokens),  0) AS input_tokens,
      COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
      COUNT(*) AS call_count,
      COALESCE(SUM(
        (s.input_tokens  / 1000.0) * COALESCE(c.cost_per_1k_input,  0) +
        (s.output_tokens / 1000.0) * COALESCE(c.cost_per_1k_output, 0)
      ), 0) AS est_cost_usd
    FROM model_spend s
    LEFT JOIN model_catalog c
      ON c.provider = s.provider AND c.model_id = s.model_id
    WHERE s.created_at > ?
    GROUP BY s.provider
    ORDER BY total_tokens DESC
  `).all(cutoff) as ProviderUsageRow[];
}

export function spendByProviderAndAgent(hours: number): ProviderAgentRow[] {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return getDb().prepare(`
    SELECT
      s.provider,
      s.agent_id,
      COALESCE(a.name, 'unknown') AS agent_name,
      COALESCE(SUM(s.input_tokens + s.output_tokens), 0) AS total_tokens,
      COUNT(*) AS call_count
    FROM model_spend s
    LEFT JOIN agents a ON a.id = s.agent_id
    WHERE s.created_at > ?
    GROUP BY s.provider, s.agent_id
    ORDER BY s.provider, total_tokens DESC
  `).all(cutoff) as ProviderAgentRow[];
}
