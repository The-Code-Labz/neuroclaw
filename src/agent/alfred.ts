import type { ChatCompletionMessageParam } from 'openai/resources';
import { getClient } from './openai-client';
import { config } from '../config';
import { saveMessage, logAnalytics, getAgentByName, getAgentById, type AgentRecord } from '../db';
import { logger } from '../utils/logger';

// TODO [tool calling]: Add function definitions for web search, file I/O, calendar, task creation
// TODO [auto-delegation]: Two-pass routing — let Alfred respond with DELEGATE:AgentName:task, re-route
// TODO [memory]: Retrieve relevant memories before each message; persist key facts after responses
// TODO [ElevenLabs]: Stream audio output alongside text for voice-enabled agents

// Per-agent conversation histories keyed as "sessionId::agentId"
const sessionHistories = new Map<string, ChatCompletionMessageParam[]>();

function historyKey(sessionId: string, agentId?: string): string {
  return agentId ? `${sessionId}::${agentId}` : sessionId;
}

function getOrCreateHistory(
  sessionId: string,
  systemPrompt: string,
  agentId?: string,
): ChatCompletionMessageParam[] {
  const key = historyKey(sessionId, agentId);
  if (!sessionHistories.has(key)) {
    sessionHistories.set(key, [{ role: 'system', content: systemPrompt }]);
  }
  return sessionHistories.get(key)!;
}

/**
 * Core streaming function shared by CLI and dashboard.
 * Streams tokens via onChunk, persists to DB, and maintains per-agent session history.
 *
 * @param agentId  When provided, history is isolated per agent within a session and
 *                 the assistant message is tagged with that agent in the DB.
 */
export async function chatStream(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  systemPrompt: string,
  agentId?: string,
): Promise<void> {
  const history = getOrCreateHistory(sessionId, systemPrompt, agentId);
  history.push({ role: 'user', content: userMessage });
  saveMessage(sessionId, 'user', userMessage);
  logAnalytics('message_sent', { role: 'user', length: userMessage.length }, sessionId);

  const stream = await getClient().chat.completions.create({
    model:    config.voidai.model,
    messages: history,
    stream:   true,
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? '';
    if (delta) {
      await onChunk(delta);
      fullResponse += delta;
    }
  }

  history.push({ role: 'assistant', content: fullResponse });
  saveMessage(sessionId, 'assistant', fullResponse, agentId);
  logAnalytics('message_sent', { role: 'assistant', length: fullResponse.length, agentId }, sessionId);
  logger.debug('Agent responded', { agentId, chars: fullResponse.length });
}

/**
 * Resolves the target agent from a raw message, handling @mention routing.
 * Returns the resolved agent and the (possibly stripped) message to send it.
 *
 * Priority: @mention > explicit agentId argument > Alfred fallback.
 */
export function resolveAgent(
  rawMessage: string,
  fallbackAgentId?: string,
): { agent: AgentRecord; message: string } | null {
  // @AgentName <rest of message>
  const mention = rawMessage.match(/^@(\S+)\s+([\s\S]*)/);
  if (mention) {
    const [, name, rest] = mention;
    const found = getAgentByName(name);
    if (found && found.status === 'active') {
      return { agent: found, message: rest.trim() };
    }
  }

  if (fallbackAgentId) {
    const agent = getAgentById(fallbackAgentId);
    if (agent && agent.status === 'active') {
      return { agent, message: rawMessage };
    }
  }

  // Alfred as last resort
  const alfred = getAgentByName('Alfred');
  return alfred ? { agent: alfred, message: rawMessage } : null;
}

/** CLI entry point — streams to stdout. */
export async function chat(userMessage: string, sessionId: string): Promise<void> {
  const alfred = getAgentByName('Alfred');
  const systemPrompt = alfred?.system_prompt ?? 'You are Alfred, a strategic AI butler.';
  const agentId = alfred?.id;

  process.stdout.write('\nAlfred: ');
  await chatStream(userMessage, sessionId, (chunk) => {
    process.stdout.write(chunk);
  }, systemPrompt, agentId);
  process.stdout.write('\n\n');
}

export function clearHistory(sessionId: string, agentId?: string): void {
  if (agentId) {
    sessionHistories.delete(historyKey(sessionId, agentId));
  } else {
    // Clear all histories for this session
    for (const key of sessionHistories.keys()) {
      if (key.startsWith(sessionId)) sessionHistories.delete(key);
    }
  }
}
