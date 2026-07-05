import { bgChatCompletion } from '../agent/openai-client';
import { config } from '../config';
import { type AgentRecord } from '../db';
import { logger } from '../utils/logger';
import { getLangfuse, estimateTokens } from './langfuse';

// ── Metric stub ────────────────────────────────────────────────────────────
// Replace with Prometheus/StatsD counters in a follow-up when analytics are wired.
function incrementMetric(key: string): void {
  logger.info('metric', { key, ts: Date.now() });
}

// ── Partial JSON recovery ──────────────────────────────────────────────────
// See specs/decomposer-json-truncation-fix.md Fix 2.

function tryRecoverPartialDecomposition(raw: string): DecompositionResult | null {
  // Step 1: extract isComplex from the partial JSON
  const isComplexMatch = raw.match(/"isComplex"\s*:\s*(true|false)/);
  if (!isComplexMatch) return null;

  const isComplex = isComplexMatch[1] === 'true';

  // Step 2: attempt to recover steps array (may be truncated)
  let steps: TaskStep[] = [];
  try {
    const stepsMatch = raw.match(/"steps"\s*:\s*(\[[\s\S]*)/);
    if (stepsMatch) {
      // Strip trailing incomplete object before closing the array.
      const repaired = stepsMatch[1]
        .replace(/,?\s*\{[^}]*$/, '')  // remove trailing incomplete object
        .replace(/,?\s*$/, ']');       // close the array
      const parsed = JSON.parse(repaired);
      if (Array.isArray(parsed)) {
        steps = parsed;
      }
    }
  } catch {
    // steps recovery failed — isComplex is still usable
  }

  // Only return if we have enough to act on
  if (isComplex && steps.length < 2) {
    return null; // trigger second-chance retry instead
  }

  logger.warn('decomposer: parse failure recovered', {
    isComplex, stepsRecovered: steps.length, rawSnippet: raw.slice(0, 100),
  });
  return { isComplex, steps, reason: 'Recovered from truncated JSON' };
}

// ── Second-chance complexity retry ─────────────────────────────────────────
// See specs/decomposer-json-truncation-fix.md Fix 3.

async function retryComplexityCheck(userMessage: string): Promise<boolean> {
  const prompt = `Reply with only "yes" or "no". Is this task complex enough to need multiple specialized agents?\n\nTask: ${userMessage.slice(0, 500)}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const retryMaxTokens = (config as any).decomposer?.retryMaxTokens ?? 32;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (config as any).decomposer?.model ?? config.background.model;
  const callArgs = {
    model,
    messages: [
      { role: 'system' as const, content: 'You are a task classifier. Reply only "yes" or "no".' },
      { role: 'user'   as const, content: prompt },
    ],
    temperature: 0,
    max_tokens:  retryMaxTokens,
    stream:      false as const,
  };
  // VoidAI (haiku) first, OpenRouter (callArgs.model) on any error/timeout.
  const response = await bgChatCompletion(callArgs, { label: 'decomposer:complexity' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const answer = ((response as any).choices[0]?.message?.content ?? '').trim().toLowerCase();
  logger.info('decomposer: second-chance complexity check', { answer });
  return answer.startsWith('yes');
}

export interface TaskStep {
  task:     string;
  agent:    string;
  parallel: boolean;
}

export interface DecompositionResult {
  isComplex: boolean;
  steps:     TaskStep[];
  reason:    string;
}

export interface SpawnEvaluation {
  shouldSpawn:     boolean;
  reason:          string;
  expectedBenefit: number;
}

// 30s dedup cache — same message + same active team skips a redundant LLM call
const DECOMPOSE_CACHE_TTL_MS = 30_000;
interface DecomposeCacheEntry { result: DecompositionResult; expiresAt: number; }
const decomposeCache = new Map<string, DecomposeCacheEntry>();

function decomposeCacheKey(message: string, agents: AgentRecord[]): string {
  return agents.map(a => a.id).sort().join(',') + '\x00' + message;
}

function pruneDecomposeCache(): void {
  const now = Date.now();
  for (const [k, v] of decomposeCache) if (v.expiresAt <= now) decomposeCache.delete(k);
}

export async function decomposeTask(
  message: string,
  agents: AgentRecord[],
): Promise<DecompositionResult> {
  const eligible = agents.filter(a => a.status === 'active' && !a.temporary);
  if (eligible.length === 0) {
    return { isComplex: false, steps: [], reason: 'No agents available' };
  }

  pruneDecomposeCache();
  const cacheKey = decomposeCacheKey(message, eligible);
  const cached = decomposeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug('decomposer: cache hit', { isComplex: cached.result.isComplex });
    return cached.result;
  }

  const agentList = eligible.map(a => {
    const caps = (() => { try { return JSON.parse(a.capabilities || '[]') as string[]; } catch { return []; } })();
    return `- ${a.name}: ${a.description ?? 'General assistant'} [${caps.join(', ') || 'general'}]`;
  }).join('\n');

  const systemPrompt =
    'You are a task decomposition system for a multi-agent AI orchestrator.\n' +
    'Analyze the user message and decide if it requires multiple specialized agents working in sequence.\n\n' +
    'RULES:\n' +
    '- Simple, single-domain requests → isComplex: false, empty steps array\n' +
    '- Requests clearly needing 2+ distinct specializations in sequence → isComplex: true\n' +
    '- Maximum 4 steps. Fewer is better. Prefer delegation over decomposition.\n' +
    '- Only assign agents that exist exactly in the list.\n' +
    '- parallel: true only for fully independent steps (not depending on each other\'s output)\n\n' +
    'Output ONLY strict JSON with no markdown:\n' +
    '{"isComplex":false,"reason":"one-line reason","steps":[]}\n' +
    'or\n' +
    '{"isComplex":true,"reason":"why this is multi-step","steps":[{"task":"specific task","agent":"ExactName","parallel":false}]}';

  const userPrompt = `Available agents:\n${agentList}\n\nUser message: ${message}`;

  const lf = getLangfuse();
  const start = Date.now();

  try {
    const model = config.voidai.decomposerModel ?? config.background.model;
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user'   as const, content: userPrompt   },
    ];
    // 1500 (was 900): a ≤4-step JSON plan is only ~300-400 tokens, but 900 could
    // truncate a verbose plan mid-`steps`, which previously demoted the whole
    // multi-agent task to a single agent (see the re-decompose path below).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseMaxTokens = (config as any).decomposer?.maxTokens ?? 1500;

    // One decomposition attempt at a given token budget. Returns the cleaned text
    // plus the parsed result (null when the JSON didn't parse, so the caller can
    // try partial recovery on the raw text).
    const attemptDecompose = async (maxTokens: number): Promise<{ raw: string; parsed: DecompositionResult | null }> => {
      const response = await bgChatCompletion({
        model, messages, temperature: 0, max_tokens: maxTokens, stream: false,
      }, { label: 'decomposer:decompose' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawText = (response as any).choices[0]?.message?.content?.trim() ?? '';
      const clean   = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      try { return { raw: clean, parsed: JSON.parse(clean) as DecompositionResult }; }
      catch { return { raw: clean, parsed: null }; }
    };

    let { raw: cleaned, parsed } = await attemptDecompose(baseMaxTokens);

    if (!parsed) {
      // Attempt 1: partial JSON recovery from the truncated text.
      const recovered = tryRecoverPartialDecomposition(cleaned);
      if (recovered) {
        incrementMetric('decomposer.parse_failure.recovered');
        parsed = recovered;
      } else if (/"isComplex"\s*:\s*true/.test(cleaned)) {
        // The output claimed complexity but was truncated past recovery (<2
        // steps). Re-decompose ONCE at a larger budget so a genuine multi-agent
        // task isn't silently demoted to a single agent. Only when it actually
        // looked complex — a simple task has nothing worth recovering.
        incrementMetric('decomposer.parse_failure.redecompose');
        try {
          const wide = await attemptDecompose(baseMaxTokens * 2);
          parsed = wide.parsed ?? tryRecoverPartialDecomposition(wide.raw);
          if (parsed) cleaned = wide.raw;
        } catch (wideErr) {
          logger.warn('decomposer: wide re-decompose failed', { err: String(wideErr) });
        }
      }

      if (!parsed) {
        // Attempt 2: second-chance yes/no LLM call (confirms complexity even when
        // no usable step plan could be recovered).
        try {
          const isComplex = await retryComplexityCheck(message);
          incrementMetric('decomposer.parse_failure.retry_used');
          logger.warn('decomposer: second-chance retry used', { answer: isComplex ? 'yes' : 'no', rawSnippet: cleaned.slice(0, 100) });
          return { isComplex, steps: [], reason: 'Second-chance complexity check' };
        } catch (retryErr) {
          incrementMetric('decomposer.parse_failure.unrecoverable');
          logger.warn('decomposer: unrecoverable parse failure — treating as simple', {
            retryError: String(retryErr),
            rawSnippet: cleaned.slice(0, 100),
          });
          return { isComplex: false, steps: [], reason: 'Decomposition failed — unrecoverable' };
        }
      }
    }

    if (lf) {
      lf.generation({
        name:  'decomposer',
        model,
        input: messages,
        output: cleaned,
        metadata: {
          isComplex:  parsed.isComplex,
          steps:      parsed.steps?.length ?? 0,
          durationMs: Date.now() - start,
          inputTokens: estimateTokens(systemPrompt + userPrompt),
        },
      });
      lf.flushAsync().catch(() => {});
    }

    logger.info('decomposer: task decomposed', { isComplex: parsed.isComplex, steps: parsed.steps?.length, reason: parsed.reason });
    const result: DecompositionResult = {
      isComplex: !!parsed.isComplex,
      steps:     Array.isArray(parsed.steps) ? parsed.steps : [],
      reason:    parsed.reason ?? '',
    };
    decomposeCache.set(cacheKey, { result, expiresAt: Date.now() + DECOMPOSE_CACHE_TTL_MS });
    return result;
  } catch (err) {
    logger.warn('decomposer: failed, treating as simple task', err instanceof Error ? err.message : err);
    return { isComplex: false, steps: [], reason: 'Decomposition failed' };
  }
}

export async function mergeResults(
  originalMessage: string,
  stepResults: Array<{ task: string; agent: string; result: string }>,
): Promise<string> {
  const resultsText = stepResults.map((s, i) =>
    `## Step ${i + 1} — ${s.agent}\nTask: ${s.task}\n\nResult:\n${s.result.slice(0, 6000)}`,
  ).join('\n\n---\n\n');

  const systemPrompt =
    'You are a result synthesis specialist. Multiple agents have completed steps of a complex task.\n' +
    'Merge their outputs into a single, coherent, comprehensive response:\n' +
    '- Eliminate duplicates and redundancy\n' +
    '- Combine complementary insights naturally\n' +
    '- Maintain a logical, readable flow\n' +
    '- Be concise but complete\n' +
    '- Do NOT mention "Agent X said" or reference the pipeline — just present the synthesized answer directly';

  const userPrompt = `Original request: ${originalMessage}\n\n${resultsText}`;

  const lf = getLangfuse();
  const start = Date.now();

  try {
    const model    = config.voidai.decomposerModel ?? config.background.model;
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user'   as const, content: userPrompt   },
    ];

    const response = await bgChatCompletion({
      model,
      messages,
      stream:     false,
      max_tokens: 8000,
    }, { label: 'decomposer:merge' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged = (response as any).choices[0]?.message?.content?.trim() || stepResults.map(s => s.result).join('\n\n---\n\n');

    if (lf) {
      lf.generation({
        name:  'merger',
        model,
        input: messages,
        output: merged,
        metadata: {
          stepCount:  stepResults.length,
          durationMs: Date.now() - start,
          outputTokens: estimateTokens(merged),
        },
      });
      lf.flushAsync().catch(() => {});
    }

    logger.info('decomposer: results merged', { steps: stepResults.length, chars: merged.length });
    return merged;
  } catch (err) {
    logger.warn('decomposer: merge failed, concatenating', err instanceof Error ? err.message : err);
    return stepResults.map(s => `**${s.agent}:**\n${s.result}`).join('\n\n---\n\n');
  }
}

export async function evaluateSpawn(
  task: string,
  existingAgents: AgentRecord[],
  threshold = 0.7,
): Promise<SpawnEvaluation> {
  const agentList = existingAgents
    .filter(a => a.status === 'active' && !a.temporary)
    .map(a => {
      const caps = (() => { try { return JSON.parse(a.capabilities || '[]') as string[]; } catch { return []; } })();
      return `- ${a.name}: ${a.description ?? 'General'} [${caps.join(', ') || 'general'}]`;
    }).join('\n');

  const systemPrompt =
    'You are a spawn decision evaluator. Decide if a new temporary specialist agent should be created.\n' +
    'Spawn is ONLY justified when ALL of the following are true:\n' +
    '1. No existing agent has the required specialization\n' +
    '2. The task requires a very specific, narrow skill set\n' +
    `3. Expected quality improvement > ${threshold}\n\n` +
    'Output ONLY strict JSON:\n' +
    '{"shouldSpawn":bool,"reason":"one line","expectedBenefit":0.0}';

  const userPrompt = `Task: ${task}\n\nExisting agents:\n${agentList}`;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await bgChatCompletion({
      model:    config.voidai.decomposerModel ?? config.background.model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user'   as const, content: userPrompt   },
      ],
      temperature: 0,
      max_tokens:  100,
      stream:      false,
    }, { label: 'decomposer:spawn-eval' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw     = (response as any).choices[0]?.message?.content?.trim() ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed  = JSON.parse(cleaned) as SpawnEvaluation;

    const benefit     = parsed.expectedBenefit ?? 0;
    const shouldSpawn = !!parsed.shouldSpawn && benefit >= threshold;
    logger.info('decomposer: spawn evaluated', { shouldSpawn, benefit, threshold, reason: parsed.reason });
    return {
      shouldSpawn,
      reason:          parsed.reason ?? '',
      expectedBenefit: benefit,
    };
  } catch (err) {
    logger.warn('decomposer: eval failed, defaulting to no spawn', err instanceof Error ? err.message : err);
    return { shouldSpawn: false, reason: 'Evaluation failed', expectedBenefit: 0 };
  }
}
