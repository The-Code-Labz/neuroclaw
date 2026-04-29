import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources';
import { getClient } from './openai-client';
import { config } from '../config';
import {
  saveMessage, logAnalytics, createSession,
  getAgentByName, getAgentById, getAllAgents,
  type AgentRecord,
} from '../db';
import { logger } from '../utils/logger';
import { classifyRoute } from '../system/router';
import { spawnAgent, type SpawnRequest } from '../system/spawner';
import { logHive } from '../system/hive-mind';
import { getLangfuse } from '../system/langfuse';
import {
  createBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  taskEvents,
  type BackgroundTask,
} from '../system/background-tasks';

// TODO [ElevenLabs]: Stream audio output alongside text for voice-enabled agents
// TODO [memory]: Retrieve relevant memories before each message; persist key facts after responses

export interface RouteEvent {
  from:       string;
  to:         string;
  confidence: number;
  reason:     string;
  manual:     boolean;
}

export interface SpawnEvent {
  agentName: string;
  agentId:   string;
}

export type MetaEvent =
  | { type: 'route';        event: RouteEvent }
  | { type: 'spawn';        event: SpawnEvent }
  | { type: 'spawn_chunk';  agentName: string; content: string }
  | { type: 'spawn_done';   agentName: string; result: string }
  | { type: 'spawn_started'; agentName: string; taskId: string };

// ── Dynamic system prompt builders ───────────────────────────────────────────

const SPAWN_GUIDANCE_TEXT =
  '\n\nYou may create temporary sub-agents when:\n' +
  '- the task is complex and requires deep specialization\n' +
  '- parallel work would significantly improve performance\n' +
  'Prefer delegation before spawning. Do NOT spawn agents unnecessarily.';

function buildOrchestratorPrompt(allAgents: AgentRecord[]): string {
  const specialists = allAgents.filter(
    a => a.status === 'active' && a.name !== 'Alfred' && !a.temporary,
  );
  const agentLines = specialists.length > 0
    ? specialists.map(a => `- @${a.name} — ${a.description ?? a.role}`).join('\n')
    : '(none currently active)';

  return (
    'You are Alfred, a strategic AI butler and orchestrator.\n\n' +
    'You:\n' +
    '- Understand intent and route requests to the right specialist\n' +
    '- Respond clearly and think like a manager\n' +
    '- Assign tasks to agents best suited for them\n\n' +
    'Available agents (users can address them with @Name):\n' +
    agentLines +
    '\n\nWhen a request is better handled by a specialist, direct the user to address @AgentName or route via the dashboard.' +
    SPAWN_GUIDANCE_TEXT
  );
}

function buildTeamSection(currentAgentId: string, allAgents: AgentRecord[]): string {
  const peers = allAgents.filter(
    a => a.status === 'active' && a.id !== currentAgentId && !a.temporary,
  );
  if (peers.length === 0) return '';
  const lines = peers.map(a => `- @${a.name}${a.description ? ' — ' + a.description : ''}`).join('\n');
  return '\n\n---\nActive team members:\n' + lines;
}

// ── History ──────────────────────────────────────────────────────────────────

// Keyed by "sessionId::agentId" so each agent has isolated context within a session
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

// ── Tool definitions ──────────────────────────────────────────────────────────

function buildTools(agent: AgentRecord | undefined): ChatCompletionTool[] {
  if (!config.spawning.enabled) return [];
  if (!agent || agent.status !== 'active') return [];
  if ((agent.spawn_depth ?? 0) >= 3) return [];

  return [{
    type: 'function',
    function: {
      name:        'spawn_agent',
      description: 'Create a temporary specialized agent to handle a complex or parallel task',
      parameters: {
        type:       'object',
        properties: {
          name:            { type: 'string', description: 'Unique name for the temporary agent' },
          role:            { type: 'string', description: 'Agent role, e.g. specialist, analyst' },
          description:     { type: 'string', description: 'One-line description of what this agent does' },
          capabilities:    { type: 'array', items: { type: 'string' }, description: 'List of capability tags' },
          systemPrompt:    { type: 'string', description: 'Full system prompt for the agent' },
          taskDescription: { type: 'string', description: 'The specific task for the agent to execute immediately' },
        },
        required: ['name', 'role', 'description', 'systemPrompt', 'taskDescription'],
      },
    },
  }];
}

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  argsStr: string,
  parentAgentId: string | undefined,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
): Promise<string> {
  if (name !== 'spawn_agent') {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  let args: SpawnRequest & { taskDescription?: string };
  try {
    args = JSON.parse(argsStr) as typeof args;
  } catch {
    return JSON.stringify({ error: 'Invalid spawn_agent arguments' });
  }

  if (!parentAgentId) return JSON.stringify({ error: 'No parent agent ID for spawn' });

  const result = spawnAgent({ ...args, parentAgentId });
  if (!result.ok || !result.agent) {
    return JSON.stringify({ error: result.reason ?? 'Spawn failed' });
  }

  await onMeta?.({ type: 'spawn', event: { agentName: result.agent.name, agentId: result.agent.id } });

  // Run the spawned agent's task in the background (non-blocking)
  if (args.taskDescription) {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const spawnSessionId = createSession(result.agent.id, `Spawn: ${result.agent.name}`);
    
    // Create background task tracking
    createBackgroundTask(taskId, result.agent.id, result.agent.name, spawnSessionId);
    
    // Notify that background task started
    await onMeta?.({ type: 'spawn_started', agentName: result.agent.name, taskId });

    // Fire and forget — run in background
    (async () => {
      let subResponse = '';
      try {
        await chatStream(
          args.taskDescription!,
          spawnSessionId,
          (chunk) => { subResponse += chunk; },
          result.agent!.system_prompt ?? '',
          result.agent!.id,
        );
        // Mark complete and auto-deactivate the temp agent
        completeBackgroundTask(taskId, subResponse, true);
        logger.info('Background sub-agent completed', { taskId, agentName: result.agent!.name, chars: subResponse.length });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failBackgroundTask(taskId, errMsg);
        logger.error('Background sub-agent failed', { taskId, agentName: result.agent!.name, error: errMsg });
      }
    })();

    // Return immediately so main agent can continue
    return JSON.stringify({
      spawned: result.agent.name,
      status: 'running_in_background',
      taskId,
      note: `Sub-agent "${result.agent.name}" is now working on the task in the background. The user can continue chatting. You'll be notified when it completes. Do not wait — proceed with the conversation.`,
    });
  }

  return JSON.stringify({ spawned: result.agent.name, agentId: result.agent.id });
}

// ── Core streaming function ───────────────────────────────────────────────────

/**
 * Streams a conversation turn. Handles tool calls (spawn_agent) transparently.
 *
 * @param onMeta  Optional callback for structured events (route, spawn) to relay via SSE.
 */
export async function chatStream(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  systemPrompt: string,
  agentId?: string,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
): Promise<void> {
  const history = getOrCreateHistory(sessionId, systemPrompt, agentId);
  history.push({ role: 'user', content: userMessage });
  saveMessage(sessionId, 'user', userMessage);
  logAnalytics('message_sent', { role: 'user', length: userMessage.length }, sessionId);

  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  const tools = buildTools(agentRecord);

  // Refresh team awareness so every agent sees the current live roster
  const allAgents = getAllAgents();
  if (agentRecord?.name === 'Alfred') {
    history[0] = { role: 'system', content: buildOrchestratorPrompt(allAgents) };
  } else if (agentRecord) {
    const base = agentRecord.system_prompt ?? systemPrompt;
    history[0] = { role: 'system', content: base + buildTeamSection(agentRecord.id, allAgents) };
  }

  const MAX_TOOL_ITERATIONS = 5;
  let iteration = 0;
  let continueLoop = true;

  const lf = getLangfuse();
  const trace = lf?.trace({
    name:     'chat',
    id:       `${sessionId}-${Date.now()}`,
    userId:   agentId,
    metadata: { agentName: agentRecord?.name, sessionId },
  });

  while (continueLoop && iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    continueLoop = false;

    const genStart = Date.now();
    const generation = trace?.generation({
      name:      `completion-${iteration}`,
      model:     config.voidai.model,
      input:     history,
      startTime: new Date(genStart),
    });

    const stream = await getClient().chat.completions.create({
      model:    config.voidai.model,
      messages: history,
      stream:   true,
      ...(tools.length > 0 ? { tools } : {}),
    });

    let textAccum = '';
    // Accumulate tool call chunks: index → { id, name, args }
    const toolAcc: Record<number, { id: string; name: string; args: string }> = {};
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      const textDelta = choice?.delta?.content ?? '';
      if (textDelta) {
        await onChunk(textDelta);
        textAccum += textDelta;
      }

      const toolDeltas = choice?.delta?.tool_calls;
      if (toolDeltas) {
        for (const td of toolDeltas) {
          const idx = td.index ?? 0;
          if (!toolAcc[idx]) toolAcc[idx] = { id: '', name: '', args: '' };
          if (td.id)                toolAcc[idx].id   = td.id;
          if (td.function?.name)    toolAcc[idx].name  += td.function.name;
          if (td.function?.arguments) toolAcc[idx].args += td.function.arguments;
        }
      }
    }

    if (finishReason === 'tool_calls' && Object.keys(toolAcc).length > 0) {
      generation?.end({ output: '[tool_calls]', endTime: new Date() });

      const toolCalls = Object.values(toolAcc).map(tc => ({
        id:       tc.id || randomId(),
        type:     'function' as const,
        function: { name: tc.name, arguments: tc.args },
      }));

      // Add assistant tool-call message to history
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role:       'assistant',
        content:    null,
        tool_calls: toolCalls,
      };
      history.push(assistantMsg);

      // Execute each tool and add results
      for (const tc of toolCalls) {
        logger.info('Executing tool call', { name: tc.function.name });
        const result = await executeTool(tc.function.name, tc.function.arguments, agentId, onMeta);
        const toolMsg: ChatCompletionToolMessageParam = {
          role:         'tool',
          tool_call_id: tc.id,
          content:      result,
        };
        history.push(toolMsg);
      }

      continueLoop = true; // get the LLM's synthesis of the tool results

    } else if (textAccum) {
      generation?.end({ output: textAccum, endTime: new Date() });
      history.push({ role: 'assistant', content: textAccum });
      saveMessage(sessionId, 'assistant', textAccum, agentId);
      logAnalytics('message_sent', { role: 'assistant', length: textAccum.length, agentId }, sessionId);
      logger.debug('Agent responded', { agentId, chars: textAccum.length });
    } else {
      generation?.end({ endTime: new Date() });
    }
  }

  // Non-blocking flush — don't await in hot path
  lf?.flushAsync().catch(() => {});
}

// ── Agent resolution (async — may call classifier) ────────────────────────────

export async function resolveAgent(
  rawMessage: string,
  fallbackAgentId?: string,
): Promise<{ agent: AgentRecord; message: string; routeEvent?: RouteEvent }> {
  // 1. @mention routing (highest priority)
  const mention = rawMessage.match(/^@(\S+)\s+([\s\S]*)/);
  if (mention) {
    const [, mentionName, rest] = mention;
    const found = getAgentByName(mentionName);
    if (found && found.status === 'active') {
      logHive('manual_delegation', `User delegated to ${found.name} via @mention`, found.id, { preview: rest.trim().slice(0, 80) });
      return {
        agent:      found,
        message:    rest.trim(),
        routeEvent: { from: 'user', to: found.name, confidence: 1.0, reason: '@mention', manual: true },
      };
    }
  }

  // 2. LLM auto-classifier (if enabled)
  if (config.routing.enabled) {
    const candidates = getAllAgents().filter(a => a.status === 'active' && a.name !== 'Alfred');
    const decision   = await classifyRoute(rawMessage, candidates);
    if (decision) {
      logHive(
        'auto_route',
        `Auto-routed to ${decision.agent.name} (${Math.round(decision.confidence * 100)}%) — ${decision.reason}`,
        decision.agent.id,
        { confidence: decision.confidence, reason: decision.reason },
      );
      return {
        agent:      decision.agent,
        message:    rawMessage,
        routeEvent: { from: 'alfred', to: decision.agent.name, confidence: decision.confidence, reason: decision.reason, manual: false },
      };
    }
    logHive('route_fallback', 'Auto-routing: no confident match, falling back to Alfred', undefined, { preview: rawMessage.slice(0, 80) });
  }

  // 3. Explicit agentId from caller
  if (fallbackAgentId) {
    const agent = getAgentById(fallbackAgentId);
    if (agent && agent.status === 'active') return { agent, message: rawMessage };
  }

  // 4. Alfred as final fallback
  const alfred = getAgentByName('Alfred');
  if (!alfred) throw new Error('Alfred not found — DB seed may have failed');
  return { agent: alfred, message: rawMessage };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

export async function chat(userMessage: string, sessionId: string): Promise<void> {
  const alfred = getAgentByName('Alfred');
  const systemPrompt = alfred?.system_prompt ?? 'You are Alfred, a strategic AI butler.';

  process.stdout.write('\nAlfred: ');
  await chatStream(userMessage, sessionId, (chunk) => {
    process.stdout.write(chunk);
  }, systemPrompt, alfred?.id);
  process.stdout.write('\n\n');
}

export function clearHistory(sessionId: string, agentId?: string): void {
  if (agentId) {
    sessionHistories.delete(historyKey(sessionId, agentId));
  } else {
    for (const key of sessionHistories.keys()) {
      if (key.startsWith(sessionId)) sessionHistories.delete(key);
    }
  }
}

function randomId(): string {
  return `tc_${Math.random().toString(36).slice(2, 10)}`;
}
