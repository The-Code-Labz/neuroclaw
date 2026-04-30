import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources';
import Anthropic from '@anthropic-ai/sdk';
import { getClient } from './openai-client';
import { getAnthropicClient, prefixSystemPromptForOAuth } from './anthropic-client';
import { config } from '../config';
import {
  saveMessage, logAnalytics, createSession,
  getAgentByName, getAgentById, getAllAgents,
  getSessionMessages,
  createAgentMessage, updateAgentMessageResponse,
  type AgentRecord,
} from '../db';
import { logger } from '../utils/logger';
import { classifyRoute } from '../system/router';
import { spawnAgent, type SpawnRequest } from '../system/spawner';
import { logHive } from '../system/hive-mind';
import { getLangfuse, createChatTrace, logToolSpan, estimateTokens } from '../system/langfuse';
import {
  createBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  taskEvents,
  type BackgroundTask,
} from '../system/background-tasks';
import { decomposeTask, mergeResults, evaluateSpawn } from '../system/decomposer';
import { createTask } from '../system/task-manager';

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
  | { type: 'spawn_started'; agentName: string; taskId: string }
  | { type: 'plan';         steps: Array<{ index: number; task: string; agent: string; parallel: boolean }> }
  | { type: 'step_start';   stepIndex: number; task: string; agentName: string }
  | { type: 'step_chunk';   stepIndex: number; agentName: string; content: string }
  | { type: 'step_done';    stepIndex: number; agentName: string }
  | { type: 'merge_start' }
  | { type: 'spawn_eval';        task: string; shouldSpawn: boolean; benefit: number; reason: string }
  | { type: 'agent_message';     fromName: string; toName: string; preview: string }
  | { type: 'agent_task_assigned'; fromName: string; toName: string; title: string; taskId: string; executing: boolean };

// ── Dynamic system prompt builders ───────────────────────────────────────────

const AGENT_COMMS_GUIDANCE =
  '\n\n## Agent Communication Tools — USE THEM, DO NOT DESCRIBE THEM\n\n' +
  'You have two tools for working with other agents. CALL THEM immediately — never tell the user "you can do X" or "here is how to do X". Just do it.\n\n' +
  '`message_agent` — send a message to an agent and receive their response right now.\n' +
  '  → Use when: user asks you to "ask", "check with", "get a response from", "have X say", or "send a message to" an agent.\n\n' +
  '`assign_task_to_agent` — create a task for an agent (set execute_now=true to run it immediately).\n' +
  '  → Use when: user asks you to "assign", "delegate", "give a task to", or "have X do" something.\n\n' +
  'RULE: If the user says "send a hello", "assign that task", "have Coder do X", "ask Researcher about Y" — ' +
  'CALL THE TOOL IMMEDIATELY. Do not narrate. Do not say "here is the instruction". Just execute.\n\n' +
  '## CRITICAL — DO NOT DO THE WORK YOURSELF\n\n' +
  'When you assign or delegate a task to another agent, you MUST NOT also produce the output yourself. ' +
  'Your only job is to call the tool and report back what that agent returned. ' +
  'Do NOT write the essay, code, plan, or answer — the assigned agent will do that. ' +
  'If you catch yourself about to produce content that was meant for another agent, STOP and use the tool instead.';

const SPAWN_GUIDANCE_TEXT =
  '\n\nYou may create temporary sub-agents when:\n' +
  '- the task is complex and requires deep specialization\n' +
  '- parallel work would significantly improve performance\n' +
  'Prefer delegation before spawning. Do NOT spawn agents unnecessarily.\n\n' +
  'IMPORTANT: When you spawn a sub-agent, it runs IN THE BACKGROUND. ' +
  'Do NOT attempt to do the task yourself. Do NOT write the content the sub-agent was asked to create. ' +
  'Simply confirm that the sub-agent has been spawned and is working. ' +
  'The sub-agent\'s results will appear automatically when it finishes.';

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
    '\n\nWhen a request needs a specialist, USE `message_agent` or `assign_task_to_agent` to involve them directly. Do NOT tell the user to do it themselves.' +
    AGENT_COMMS_GUIDANCE +
    SPAWN_GUIDANCE_TEXT
  );
}

function buildTeamSection(currentAgentId: string, allAgents: AgentRecord[]): string {
  const peers = allAgents.filter(
    a => a.status === 'active' && a.id !== currentAgentId && !a.temporary,
  );
  if (peers.length === 0) return '';
  const lines = peers.map(a => `- @${a.name}${a.description ? ' — ' + a.description : ''}`).join('\n');
  return (
    '\n\n---\nActive team members (use `message_agent` to contact them directly):\n' + lines +
    '\nDo NOT tell the user to contact agents themselves — call the tool and do it for them.'
  );
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
    // Try to restore from DB if this is an existing session
    const dbMessages = getSessionMessages(sessionId);
    if (dbMessages.length > 0) {
      const restored: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
      ];
      for (const m of dbMessages) {
        if (m.role === 'user' || m.role === 'assistant') {
          restored.push({ role: m.role, content: m.content });
        }
      }
      sessionHistories.set(key, restored);
      logger.debug('Restored session history from DB', { sessionId, messages: dbMessages.length });
    } else {
      sessionHistories.set(key, [{ role: 'system', content: systemPrompt }]);
    }
  }
  return sessionHistories.get(key)!;
}

// Anthropic history — keyed the same way as OpenAI history
const sessionHistoriesAnthropic = new Map<string, Anthropic.MessageParam[]>();

function getOrCreateAnthropicHistory(
  sessionId: string,
  agentId?: string,
): Anthropic.MessageParam[] {
  const key = historyKey(sessionId, agentId);
  if (!sessionHistoriesAnthropic.has(key)) {
    const dbMessages = getSessionMessages(sessionId);
    const restored: Anthropic.MessageParam[] = [];
    for (const m of dbMessages) {
      if (m.role === 'user') restored.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') restored.push({ role: 'assistant', content: m.content });
    }
    sessionHistoriesAnthropic.set(key, restored);
  }
  return sessionHistoriesAnthropic.get(key)!;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

function buildTools(agent: AgentRecord | undefined): ChatCompletionTool[] {
  if (!agent || agent.status !== 'active') return [];

  const tools: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name:        'message_agent',
        description: 'Send a direct message to another agent and receive their response synchronously',
        parameters: {
          type:       'object',
          properties: {
            to:      { type: 'string', description: 'Name of the agent to message' },
            message: { type: 'string', description: 'The message to send' },
            context: { type: 'string', description: 'Optional background context for the message' },
          },
          required: ['to', 'message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name:        'assign_task_to_agent',
        description: 'Create a task and assign it to a specific agent; optionally execute it immediately',
        parameters: {
          type:       'object',
          properties: {
            to:          { type: 'string',  description: 'Name of the agent to assign the task to' },
            title:       { type: 'string',  description: 'Short task title' },
            description: { type: 'string',  description: 'Detailed task description' },
            priority:    { type: 'number',  description: 'Priority 0-100 (default 50)' },
            execute_now: { type: 'boolean', description: 'If true, run the task immediately and return the result' },
          },
          required: ['to', 'title'],
        },
      },
    },
  ];

  if (config.spawning.enabled && (agent.spawn_depth ?? 0) < 3) {
    tools.push({
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
    });
  }

  return tools;
}

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  argsStr: string,
  parentAgentId: string | undefined,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
  sessionId?: string,
): Promise<string> {
  // ── message_agent ──────────────────────────────────────────────────────────
  if (name === 'message_agent') {
    let args: { to: string; message: string; context?: string };
    try { args = JSON.parse(argsStr); } catch { return JSON.stringify({ error: 'Invalid message_agent arguments' }); }

    const sender     = parentAgentId ? getAgentById(parentAgentId) : undefined;
    const recipient  = getAgentByName(args.to);

    if (!recipient || recipient.status !== 'active') {
      return JSON.stringify({ error: `Agent "${args.to}" not found or inactive` });
    }
    if (!sender) {
      return JSON.stringify({ error: 'Sender agent not found' });
    }

    const fullMessage = args.context
      ? `[Context: ${args.context}]\n\n${args.message}`
      : args.message;

    const msgRecord = createAgentMessage(sender.id, sender.name, recipient.id, recipient.name, args.message, sessionId);

    await onMeta?.({ type: 'agent_message', fromName: sender.name, toName: recipient.name, preview: args.message.slice(0, 80) });
    logHive('agent_message_sent', `${sender.name} → ${recipient.name}: "${args.message.slice(0, 60)}"`, sender.id, { toAgentId: recipient.id, preview: args.message.slice(0, 80) });

    // Run the target agent synchronously to get a response
    const commSessId = createSession(recipient.id, `Comms: ${sender.name} → ${recipient.name}`);
    let response = '';
    try {
      await chatStream(fullMessage, commSessId, (chunk) => { response += chunk; }, recipient.system_prompt ?? '', recipient.id);
      updateAgentMessageResponse(msgRecord.id, response, 'responded');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateAgentMessageResponse(msgRecord.id, errMsg, 'failed');
      return JSON.stringify({ error: `Agent "${args.to}" failed to respond: ${errMsg}` });
    }

    return JSON.stringify({ from: recipient.name, response });
  }

  // ── assign_task_to_agent ───────────────────────────────────────────────────
  if (name === 'assign_task_to_agent') {
    let args: { to: string; title: string; description?: string; priority?: number; execute_now?: boolean };
    try { args = JSON.parse(argsStr); } catch { return JSON.stringify({ error: 'Invalid assign_task_to_agent arguments' }); }

    const sender    = parentAgentId ? getAgentById(parentAgentId) : undefined;
    const recipient = getAgentByName(args.to);

    if (!recipient || recipient.status !== 'active') {
      return JSON.stringify({ error: `Agent "${args.to}" not found or inactive` });
    }

    const task = await createTask(args.title, args.description, sessionId, recipient.id, args.priority ?? 50);

    await onMeta?.({ type: 'agent_task_assigned', fromName: sender?.name ?? 'system', toName: recipient.name, title: args.title, taskId: task.id, executing: !!args.execute_now });
    logHive('agent_task_assigned', `${sender?.name ?? 'system'} assigned task "${args.title}" to ${recipient.name}`, recipient.id, { taskId: task.id, executeNow: !!args.execute_now });

    // Notify the tasks watch SSE so the dashboard refreshes immediately
    taskEvents.emit('task_created', { taskId: task.id, title: task.title, toName: recipient.name, fromName: sender?.name ?? 'system', status: task.status });

    if (args.execute_now) {
      const taskSessId = createSession(recipient.id, `Task: ${args.title.slice(0, 50)}`);
      let result = '';
      try {
        const taskMsg = args.description ? `${args.title}\n\n${args.description}` : args.title;
        await chatStream(taskMsg, taskSessId, (chunk) => { result += chunk; }, recipient.system_prompt ?? '', recipient.id);
        updateAgentMessageResponse(task.id, result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ task_id: task.id, assigned_to: recipient.name, status: 'failed', error: errMsg });
      }
      return JSON.stringify({ task_id: task.id, assigned_to: recipient.name, status: 'completed', result });
    }

    return JSON.stringify({ task_id: task.id, assigned_to: recipient.name, status: 'queued', title: args.title });
  }

  // ── spawn_agent ────────────────────────────────────────────────────────────
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

  // Intelligent spawn evaluation — only spawn if no existing agent can do the job well
  if (config.spawning.enabled) {
    const existing   = getAllAgents().filter(a => a.status === 'active' && !a.temporary);
    const evaluation = await evaluateSpawn(args.taskDescription ?? args.description, existing);

    await onMeta?.({ type: 'spawn_eval', task: args.name, shouldSpawn: evaluation.shouldSpawn, benefit: evaluation.expectedBenefit, reason: evaluation.reason });
    logHive('spawn_evaluated', `Spawn evaluation for "${args.name}": ${evaluation.shouldSpawn ? 'APPROVED' : 'DENIED'} (benefit ${evaluation.expectedBenefit}) — ${evaluation.reason}`, parentAgentId, evaluation);

    if (!evaluation.shouldSpawn) {
      return JSON.stringify({
        spawn_blocked: true,
        reason: evaluation.reason,
        suggestion: 'Use an existing agent instead. Available: ' + existing.map(a => a.name).join(', '),
      });
    }
  }

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
      note: `Sub-agent "${result.agent.name}" is now working on the task in the background. ` +
            `DO NOT write the essay/content/output yourself — the sub-agent will produce it. ` +
            `Just tell the user that ${result.agent.name} is working on it and they can continue chatting. ` +
            `Keep your response to 1-2 sentences maximum.`,
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
async function chatStreamOpenAI(
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
  const trace = createChatTrace(sessionId, agentId, agentRecord?.name, userMessage);

  while (continueLoop && iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    continueLoop = false;

    const genStart = Date.now();
    // Estimate input tokens from history
    const inputTokens = history.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
    const generation = trace?.generation({
      name:      `completion-${iteration}`,
      model:     config.voidai.model,
      input:     history,
      startTime: new Date(genStart),
      metadata:  { inputTokens, iteration },
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
      generation?.end({ output: '[tool_calls]' });

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
        const toolStart = Date.now();
        const result = await executeTool(tc.function.name, tc.function.arguments, agentId, onMeta, sessionId);
        logToolSpan(trace, tc.function.name, tc.function.arguments, result, Date.now() - toolStart);
        const toolMsg: ChatCompletionToolMessageParam = {
          role:         'tool',
          tool_call_id: tc.id,
          content:      result,
        };
        history.push(toolMsg);
      }

      continueLoop = true; // get the LLM's synthesis of the tool results

    } else if (textAccum) {
      const outputTokens = estimateTokens(textAccum);
      generation?.end({ output: textAccum, metadata: { outputTokens } });
      history.push({ role: 'assistant', content: textAccum });
      saveMessage(sessionId, 'assistant', textAccum, agentId);
      logAnalytics('message_sent', { role: 'assistant', length: textAccum.length, agentId, outputTokens }, sessionId);
      logger.debug('Agent responded', { agentId, chars: textAccum.length });
    } else {
      generation?.end({});
    }
  }

  // Finalize trace with output
  if (trace) {
    const lastAssistant = history.filter(m => m.role === 'assistant').pop();
    trace.update({
      output: typeof lastAssistant?.content === 'string' ? lastAssistant.content : undefined,
      metadata: { iterations: iteration },
    });
  }

  // Non-blocking flush — don't await in hot path
  lf?.flushAsync().catch(() => {});
}

// ── Anthropic streaming ───────────────────────────────────────────────────────

async function chatStreamAnthropic(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  systemPrompt: string,
  agentId?: string,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
): Promise<void> {
  const history = getOrCreateAnthropicHistory(sessionId, agentId);
  history.push({ role: 'user', content: userMessage });
  saveMessage(sessionId, 'user', userMessage);
  logAnalytics('message_sent', { role: 'user', length: userMessage.length }, sessionId);

  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  const openAiTools = buildTools(agentRecord);
  const anthropicTools: Anthropic.Messages.Tool[] = openAiTools.map(t => ({
    name:         t.function.name,
    description:  t.function.description ?? '',
    input_schema: t.function.parameters as Anthropic.Messages.Tool.InputSchema,
  }));

  // Refresh dynamic system prompt (same logic as OpenAI path)
  const allAgents = getAllAgents();
  let activeSystemPrompt = systemPrompt;
  if (agentRecord?.name === 'Alfred') {
    activeSystemPrompt = buildOrchestratorPrompt(allAgents);
  } else if (agentRecord) {
    activeSystemPrompt = (agentRecord.system_prompt ?? systemPrompt) + buildTeamSection(agentRecord.id, allAgents);
  }

  const model = agentRecord?.model ?? 'claude-sonnet-4-6';
  const lf     = getLangfuse();
  const trace  = createChatTrace(sessionId, agentId, agentRecord?.name, userMessage);

  const MAX_TOOL_ITERATIONS = 5;
  let iteration    = 0;
  let continueLoop = true;

  while (continueLoop && iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    continueLoop = false;

    const genStart  = Date.now();
    const inputText = history.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('');
    const generation = trace?.generation({
      name:      `completion-${iteration}`,
      model,
      input:     history,
      startTime: new Date(genStart),
      metadata:  { inputTokens: estimateTokens(inputText), iteration },
    });

    const stream = getAnthropicClient().messages.stream({
      model,
      max_tokens: 8096,
      system: prefixSystemPromptForOAuth(activeSystemPrompt),
      messages: history,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    });

    let textAccum = '';
    const toolBlocks = new Map<number, { id: string; name: string; inputAcc: string }>();
    let stopReason: string | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, inputAcc: '' });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          await onChunk(event.delta.text);
          textAccum += event.delta.text;
        } else if (event.delta.type === 'input_json_delta') {
          const tb = toolBlocks.get(event.index);
          if (tb) tb.inputAcc += event.delta.partial_json;
        }
      } else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? null;
      }
    }

    if (stopReason === 'tool_use' && toolBlocks.size > 0) {
      generation?.end({ output: '[tool_use]' });

      // Assistant message with text + tool_use content blocks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assistantContent: any[] = [];
      if (textAccum) assistantContent.push({ type: 'text', text: textAccum });
      for (const [, tb] of toolBlocks) {
        assistantContent.push({
          type:  'tool_use',
          id:    tb.id,
          name:  tb.name,
          input: (() => { try { return JSON.parse(tb.inputAcc || '{}'); } catch { return {}; } })(),
        });
      }
      history.push({ role: 'assistant', content: assistantContent as Anthropic.Messages.ContentBlockParam[] });

      // Execute tools and build tool_result user message
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const [, tb] of toolBlocks) {
        logger.info('Executing tool call (Anthropic)', { name: tb.name });
        const toolStart = Date.now();
        const result = await executeTool(tb.name, tb.inputAcc, agentId, onMeta, sessionId);
        logToolSpan(trace, tb.name, tb.inputAcc, result, Date.now() - toolStart);
        toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: result });
      }
      history.push({ role: 'user', content: toolResults });
      continueLoop = true;

    } else if (textAccum) {
      const outputTokens = estimateTokens(textAccum);
      generation?.end({ output: textAccum, metadata: { outputTokens } });
      history.push({ role: 'assistant', content: textAccum });
      saveMessage(sessionId, 'assistant', textAccum, agentId);
      logAnalytics('message_sent', { role: 'assistant', length: textAccum.length, agentId, outputTokens }, sessionId);
      logger.debug('Anthropic agent responded', { agentId, chars: textAccum.length });
    } else {
      generation?.end({});
    }
  }

  if (trace) {
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
    const output = typeof lastAssistant?.content === 'string' ? lastAssistant.content : undefined;
    trace.update({ output, metadata: { iterations: iteration } });
  }

  lf?.flushAsync().catch(() => {});
}

// ── Public chatStream dispatcher ─────────────────────────────────────────────

/**
 * Routes to the correct streaming implementation based on agent provider.
 */
export async function chatStream(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  systemPrompt: string,
  agentId?: string,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
): Promise<void> {
  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  if (agentRecord?.provider === 'anthropic') {
    return chatStreamAnthropic(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta);
  }
  return chatStreamOpenAI(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta);
}

// ── Multi-agent orchestration ─────────────────────────────────────────────────

/**
 * Orchestrates a potentially complex task across multiple agents.
 * - Simple messages → single chatStream call (Alfred handles)
 * - Complex messages → decompose → execute steps → merge results
 */
export async function orchestrateMultiAgent(
  rawMessage: string,
  sessionIdIn: string | undefined,
  onChunk: (chunk: string) => void | Promise<void>,
  alfredId: string,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
): Promise<string> {
  const alfred = getAgentById(alfredId);
  if (!alfred) throw new Error('Alfred not found');

  const allAgents   = getAllAgents();
  const sessionId   = sessionIdIn ?? createSession(alfredId, rawMessage.slice(0, 60));

  // Decompose: decide if this is a single-agent or multi-agent task
  const decomp = await decomposeTask(rawMessage, allAgents);

  logHive(
    'task_decomposed',
    decomp.isComplex
      ? `Multi-agent plan: ${decomp.steps.length} steps — ${decomp.reason}`
      : `Single-agent task — ${decomp.reason}`,
    alfredId,
    { isComplex: decomp.isComplex, steps: decomp.steps },
  );

  // Simple path — Alfred handles directly
  if (!decomp.isComplex || decomp.steps.length < 2) {
    await chatStream(rawMessage, sessionId, onChunk, alfred.system_prompt ?? '', alfredId, onMeta);
    return sessionId;
  }

  // Multi-agent path
  await onMeta?.({
    type:  'plan',
    steps: decomp.steps.map((s, i) => ({ index: i, task: s.task, agent: s.agent, parallel: s.parallel })),
  });

  // Save the user message once to the parent session
  saveMessage(sessionId, 'user', rawMessage);

  const stepResults: Array<{ task: string; agent: string; result: string }> = [];

  for (let i = 0; i < decomp.steps.length; i++) {
    const step      = decomp.steps[i];
    const stepAgent = getAgentByName(step.agent) ?? alfred;

    await onMeta?.({ type: 'step_start', stepIndex: i, task: step.task, agentName: stepAgent.name });

    let stepResult  = '';
    const stepSess  = createSession(stepAgent.id, `Step ${i + 1}: ${step.task.slice(0, 50)}`);

    // Build task message with context from prior steps
    const context = stepResults.length > 0
      ? `Context from previous steps:\n${stepResults.map(r => `${r.agent}: ${r.result.slice(0, 600)}`).join('\n\n')}\n\n---\n\nYour task: ${step.task}`
      : step.task;

    await chatStream(
      context,
      stepSess,
      async (chunk) => {
        stepResult += chunk;
        await onMeta?.({ type: 'step_chunk', stepIndex: i, agentName: stepAgent.name, content: chunk });
      },
      stepAgent.system_prompt ?? '',
      stepAgent.id,
    );

    stepResults.push({ task: step.task, agent: stepAgent.name, result: stepResult });
    await onMeta?.({ type: 'step_done', stepIndex: i, agentName: stepAgent.name });

    logHive(
      'multi_agent_step',
      `Step ${i + 1}/${decomp.steps.length}: "${step.task.slice(0, 60)}" by ${stepAgent.name}`,
      stepAgent.id,
      { stepIndex: i, chars: stepResult.length },
    );
  }

  // Merge all step results into a final cohesive response
  await onMeta?.({ type: 'merge_start' });
  logHive('result_merged', `Merging ${stepResults.length} agent results`, alfredId, { steps: stepResults.length });

  const merged = await mergeResults(rawMessage, stepResults);

  // Stream the merged result as regular chunks
  await onChunk(merged);

  // Persist final response on the parent session
  saveMessage(sessionId, 'assistant', merged, alfredId);
  logAnalytics('message_sent', { role: 'assistant', length: merged.length, agentId: alfredId, multiAgent: true }, sessionId);

  return sessionId;
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
    sessionHistoriesAnthropic.delete(historyKey(sessionId, agentId));
  } else {
    for (const key of sessionHistories.keys()) {
      if (key.startsWith(sessionId)) sessionHistories.delete(key);
    }
    for (const key of sessionHistoriesAnthropic.keys()) {
      if (key.startsWith(sessionId)) sessionHistoriesAnthropic.delete(key);
    }
  }
}

function randomId(): string {
  return `tc_${Math.random().toString(36).slice(2, 10)}`;
}
