// Borderline LLM escalation classifier.
// Only fires when the heuristic score lands in the configured grey zone.
// One JSON-mode call to a cheap (low-tier) classifier model.

import { config } from '../config';
import { logger } from '../utils/logger';
import { logHive } from './hive-mind';
import { getClient } from '../agent/openai-client';
import { listCatalog, type ModelTier } from './model-catalog';
import type { TriageDecision } from './model-triage';

const SYSTEM_PROMPT = `You classify the complexity tier of a task for an AI agent system.

Output ONE JSON object with these fields:
{
  "tier": "low" | "mid" | "high",
  "confidence": number,    // 0-1
  "reasoning": string      // one sentence
}

Tier definitions:
- low  = single-step, simple Q&A, summarize, lookup, casual reply.
- mid  = multi-step task, code edit in 1-2 files, structured output, moderate planning.
- high = deep reasoning, architecture / refactor across many files, multi-step debugging,
         long-form synthesis, novel problem solving, extended chain-of-thought needed.

Be honest. Bias toward 'low' or 'mid' unless you genuinely need a frontier model.

Respond with ONLY the JSON object — no prose, no code fences.`;

function pickClassifierModel(): string | null {
  if (config.triage.llmModel) return config.triage.llmModel;
  // Cheapest deterministic low-tier model from the catalog.
  const lows = listCatalog({ provider: 'voidai', tier: 'low' });
  if (lows.length === 0) return null;
  return lows[0].model_id;
}

export interface LlmTriageResult {
  tier:       ModelTier;
  confidence: number;
  reasoning:  string;
  modelUsed:  string;
}

/**
 * Should we ask the LLM? Only when the heuristic score is in the grey zone
 * AND the LLM classifier is enabled AND we have a model to use.
 */
export function shouldEscalateToLlm(decision: TriageDecision): boolean {
  if (!config.triage.llmEnabled) return false;
  const lo = config.triage.borderLow;
  const hi = config.triage.borderHigh;
  return decision.score >= lo && decision.score <= hi;
}

export async function llmClassify(text: string, agentId?: string | null): Promise<LlmTriageResult | null> {
  const model = pickClassifierModel();
  if (!model) {
    logger.warn('triage-llm: no low-tier model available, skipping LLM escalation');
    return null;
  }
  try {
    const resp = await getClient().chat.completions.create({
      model,
      max_tokens: 120,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: text.slice(0, 4000) },
      ],
    });
    const raw = resp.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw);
    if (!['low', 'mid', 'high'].includes(parsed.tier)) return null;
    const result: LlmTriageResult = {
      tier:       parsed.tier as ModelTier,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reasoning:  String(parsed.reasoning ?? '').slice(0, 200),
      modelUsed:  model,
    };
    try {
      logHive('triage_llm_used', `LLM-tier=${result.tier} (${result.confidence.toFixed(2)}) — ${result.reasoning}`, agentId ?? undefined, { model, ...result });
    } catch { /* best-effort */ }
    return result;
  } catch (err) {
    logger.warn('triage-llm: classifier call failed', { error: (err as Error).message });
    return null;
  }
}
