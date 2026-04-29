import { getClient } from '../agent/openai-client';
import { config } from '../config';
import { type AgentRecord } from '../db';
import { logger } from '../utils/logger';

export interface RouteDecision {
  agent:      AgentRecord;
  confidence: number;
  reason:     string;
}

/**
 * Calls the LLM to classify which agent best fits the message.
 * Returns null if routing is disabled, confidence is below threshold, or parsing fails.
 */
export async function classifyRoute(
  message: string,
  candidates: AgentRecord[],
): Promise<RouteDecision | null> {
  if (!config.routing.enabled || candidates.length === 0) return null;

  const agentList = candidates.map(a => {
    const caps = (() => { try { return JSON.parse(a.capabilities || '[]') as string[]; } catch { return []; } })();
    return `- ${a.name}: ${a.description ?? 'No description'} [capabilities: ${caps.join(', ') || 'general'}]`;
  }).join('\n');

  const systemPrompt =
    'You are a message routing classifier.\n' +
    'Given a user message and a list of agents, decide which agent is best suited to handle it.\n' +
    'Output ONLY strict JSON with no markdown, no code fences:\n' +
    '{"agentName":"<exact agent name>","confidence":<0.0-1.0>,"reason":"<one-line reason>"}';

  const userPrompt = `Agents:\n${agentList}\n\nUser message: ${message}`;

  try {
    const response = await getClient().chat.completions.create({
      model:       config.routing.model ?? config.voidai.model,
      messages:    [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0,
      max_tokens:  120,
      stream:      false,
    });

    const raw = (response as { choices: Array<{ message: { content: string | null } }> })
      .choices[0]?.message?.content?.trim() ?? '';

    // Strip possible markdown code fences from models that ignore instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as { agentName: string; confidence: number; reason: string };

    const matched = candidates.find(a => a.name.toLowerCase() === (parsed.agentName ?? '').toLowerCase());
    if (!matched) {
      logger.debug('Router: agent name not in candidates', { agentName: parsed.agentName });
      return null;
    }

    if (parsed.confidence < config.routing.minConfidence) {
      logger.debug('Router: confidence below threshold', { confidence: parsed.confidence, threshold: config.routing.minConfidence });
      return null;
    }

    logger.info('Router: classified', { to: matched.name, confidence: parsed.confidence, reason: parsed.reason });
    return { agent: matched, confidence: parsed.confidence, reason: parsed.reason };
  } catch (err) {
    logger.warn('Router: classification failed, falling back to Alfred', err instanceof Error ? err.message : err);
    return null;
  }
}
