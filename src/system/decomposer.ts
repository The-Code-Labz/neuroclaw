import { getClient } from '../agent/openai-client';
import { config } from '../config';
import { type AgentRecord } from '../db';
import { logger } from '../utils/logger';
import { getLangfuse, estimateTokens } from './langfuse';

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

export async function decomposeTask(
  message: string,
  agents: AgentRecord[],
): Promise<DecompositionResult> {
  const eligible = agents.filter(a => a.status === 'active' && !a.temporary);
  if (eligible.length === 0) {
    return { isComplex: false, steps: [], reason: 'No agents available' };
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
    const model = config.voidai.model;
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user'   as const, content: userPrompt   },
    ];

    const response = await getClient().chat.completions.create({
      model,
      messages,
      temperature: 0,
      max_tokens:  350,
      stream:      false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw     = (response as any).choices[0]?.message?.content?.trim() ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed  = JSON.parse(cleaned) as DecompositionResult;

    if (lf) {
      lf.generation({
        name:  'decomposer',
        model,
        input: messages,
        output: raw,
        metadata: {
          isComplex:  parsed.isComplex,
          steps:      parsed.steps?.length ?? 0,
          durationMs: Date.now() - start,
          inputTokens: estimateTokens(systemPrompt + userPrompt),
        },
      });
      lf.flushAsync().catch(() => {});
    }

    logger.info('Task decomposed', { isComplex: parsed.isComplex, steps: parsed.steps?.length, reason: parsed.reason });
    return {
      isComplex: !!parsed.isComplex,
      steps:     Array.isArray(parsed.steps) ? parsed.steps : [],
      reason:    parsed.reason ?? '',
    };
  } catch (err) {
    logger.warn('Decomposition failed, treating as simple task', err instanceof Error ? err.message : err);
    return { isComplex: false, steps: [], reason: 'Decomposition failed' };
  }
}

export async function mergeResults(
  originalMessage: string,
  stepResults: Array<{ task: string; agent: string; result: string }>,
): Promise<string> {
  const resultsText = stepResults.map((s, i) =>
    `## Step ${i + 1} — ${s.agent}\nTask: ${s.task}\n\nResult:\n${s.result.slice(0, 2000)}`,
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
    const model    = config.voidai.model;
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user'   as const, content: userPrompt   },
    ];

    const response = await getClient().chat.completions.create({
      model,
      messages,
      stream:     false,
      max_tokens: 2000,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged = (response as any).choices[0]?.message?.content?.trim() ?? stepResults.map(s => s.result).join('\n\n---\n\n');

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

    logger.info('Results merged', { steps: stepResults.length, chars: merged.length });
    return merged;
  } catch (err) {
    logger.warn('Result merging failed, concatenating', err instanceof Error ? err.message : err);
    return stepResults.map(s => `**${s.agent}:**\n${s.result}`).join('\n\n---\n\n');
  }
}

export async function evaluateSpawn(
  task: string,
  existingAgents: AgentRecord[],
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
    '3. Expected quality improvement > 0.7\n\n' +
    'Output ONLY strict JSON:\n' +
    '{"shouldSpawn":bool,"reason":"one line","expectedBenefit":0.0}';

  const userPrompt = `Task: ${task}\n\nExisting agents:\n${agentList}`;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await getClient().chat.completions.create({
      model:    config.voidai.model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user'   as const, content: userPrompt   },
      ],
      temperature: 0,
      max_tokens:  100,
      stream:      false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw     = (response as any).choices[0]?.message?.content?.trim() ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed  = JSON.parse(cleaned) as SpawnEvaluation;

    logger.info('Spawn evaluated', { shouldSpawn: parsed.shouldSpawn, benefit: parsed.expectedBenefit, reason: parsed.reason });
    return {
      shouldSpawn:     !!parsed.shouldSpawn,
      reason:          parsed.reason ?? '',
      expectedBenefit: parsed.expectedBenefit ?? 0,
    };
  } catch (err) {
    logger.warn('Spawn evaluation failed, defaulting to no spawn', err instanceof Error ? err.message : err);
    return { shouldSpawn: false, reason: 'Evaluation failed', expectedBenefit: 0 };
  }
}
