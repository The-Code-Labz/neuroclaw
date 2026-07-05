import { getOrCreateSessionByExternalId, getAllAgents, getAgentById } from '../db';
import { chatStream } from '../agent/alfred';

const ROOM_SESSION_EXTERNAL_ID = 'room::neuroroom';
const MAX_MENTION_DEPTH = 3;

export function getRoomSessionId(): string {
  const agents = getAllAgents();
  const orchestrator = agents.find(a => a.role === 'orchestrator');
  return getOrCreateSessionByExternalId(
    ROOM_SESSION_EXTERNAL_ID,
    orchestrator?.id ?? agents[0]?.id ?? 'unknown',
    'Neuro Room',
    'room',
  );
}

export function detectMentions(text: string, agentNames: { id: string; name: string }[]): string[] {
  return agentNames
    .filter(a => new RegExp(`@${a.name}\\b`, 'i').test(text))
    .map(a => a.id);
}

export interface RoomEvent {
  type:        'agent_start' | 'chunk' | 'agent_done' | 'room_done' | 'error';
  agentId?:    string;
  agentName?:  string;
  content?:    string;
  mentionedBy?: string;
  error?:      string;
}

export async function sendToRoom(opts: {
  message:        string;
  targetAgentIds: string[];
  roomSessionId:  string;
  onEvent:        (evt: RoomEvent) => void | Promise<void>;
  mentionDepth?:  number;
  mentionedBy?:   string;
}): Promise<void> {
  const { message, targetAgentIds, roomSessionId, onEvent, mentionDepth = 0, mentionedBy } = opts;

  const allAgents = getAllAgents().filter(a => a.status === 'active' && !a.temporary);

  const agentIds = targetAgentIds.includes('all')
    ? allAgents
        .slice()
        .sort((a, b) => (a.role === 'orchestrator' ? -1 : b.role === 'orchestrator' ? 1 : 0))
        .map(a => a.id)
    : targetAgentIds.filter(id => allAgents.some(a => a.id === id));

  let roomContext = '';

  for (const agentId of agentIds) {
    const agent = getAgentById(agentId);
    if (!agent) continue;

    await onEvent({ type: 'agent_start', agentId, agentName: agent.name, mentionedBy });

    const systemPrompt = agent.system_prompt ?? 'You are a helpful AI assistant.';
    const extraCtx = roomContext
      ? `\n\n---\nThis is the Neuro Room — a shared group conversation. Other agents have already responded to this message:\n${roomContext}`
      : undefined;

    let fullResponse = '';
    try {
      await chatStream(
        message,
        roomSessionId,
        async (chunk: string) => {
          fullResponse += chunk;
          await onEvent({ type: 'chunk', agentId, agentName: agent.name, content: chunk });
        },
        systemPrompt,
        agentId,
        undefined,
        undefined,
        extraCtx,
      );
    } catch (err) {
      await onEvent({ type: 'error', agentId, agentName: agent.name, error: (err as Error).message });
      continue;
    }

    await onEvent({ type: 'agent_done', agentId, agentName: agent.name });

    roomContext += `\n\n**${agent.name}**: ${fullResponse}`;

    if (mentionDepth < MAX_MENTION_DEPTH) {
      const mentionedIds = detectMentions(fullResponse, allAgents.map(a => ({ id: a.id, name: a.name })))
        .filter(id => id !== agentId && !agentIds.includes(id));

      for (const mentionedId of mentionedIds) {
        await sendToRoom({
          message:        fullResponse,
          targetAgentIds: [mentionedId],
          roomSessionId,
          onEvent,
          mentionDepth:   mentionDepth + 1,
          mentionedBy:    agent.name,
        });
      }
    }
  }

  if (mentionDepth === 0) await onEvent({ type: 'room_done' });
}
