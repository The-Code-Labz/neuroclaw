import { getAllAgents, createAgentMessage, type AgentRecord } from '../db';
import { logHive } from './hive-mind';
import { logger } from '../utils/logger';

export function broadcastIntroduction(newAgent: AgentRecord): void {
  const targets = getAllAgents().filter(
    a => a.status === 'active' && a.id !== newAgent.id && a.name !== 'Alfred',
  );

  if (targets.length === 0) return;

  const content =
    `New team member: ${newAgent.name}\n` +
    `Role: ${newAgent.role}\n` +
    `Description: ${newAgent.description ?? 'No description provided.'}\n` +
    `They are now available for delegation and collaboration.`;

  const ids: string[] = [];
  for (const target of targets) {
    try {
      const msg = createAgentMessage(null, 'Herald', target.id, target.name, content);
      ids.push(msg.id);
    } catch (err) {
      logger.warn('herald: failed to message agent', {
        toAgent: target.name,
        err: (err as Error).message,
      });
    }
  }

  logHive(
    'agent_introduced',
    `herald: Queued intro for "${newAgent.name}" to ${ids.length} agent inbox(es)`,
    newAgent.id,
    { newAgentId: newAgent.id, inboxCount: ids.length },
  );

  logger.info('herald: intro queued to agent inboxes', { newAgent: newAgent.name, inboxes: ids.length });
}
