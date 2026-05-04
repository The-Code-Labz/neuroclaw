import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources';
import Anthropic from '@anthropic-ai/sdk';
import { getClient } from './openai-client';
import { getAnthropicClient } from './anthropic-client';
import {
  streamClaudeCliChat,
  ClaudeCliRateLimitError,
  ClaudeCliAuthError,
} from '../providers/claude-cli';
import { ingestExchangeAsync } from '../memory/memory-pipeline';
import { prewarmAgentAsync } from '../system/heartbeat';
import { buildMemoryContextBlock } from '../memory/memory-tools';
import { buildSkillsBlock, parseAgentSkills, resolveEffectiveSkillNames } from '../skills/skill-loader';
import { pickModel } from '../system/model-triage';
import { logSpend } from '../system/model-spend';
import {
  maybeCompactHistory,
  type HistoryTurn,
} from '../memory/context-compactor';
import { config } from '../config';
import {
  saveMessage, logAnalytics, createSession,
  getAgentByName, getAgentById, getAllAgents,
  getSessionMessages,
  type AgentRecord,
} from '../db';
import { logger } from '../utils/logger';
import { classifyRoute } from '../system/router';
import { logHive } from '../system/hive-mind';
import { getLangfuse, createChatTrace, logToolSpan, estimateTokens } from '../system/langfuse';
import { type BackgroundTask } from '../system/background-tasks';
import { decomposeTask, mergeResults } from '../system/decomposer';
import { buildOpenAiTools, dispatchOpenAiTool } from '../tools/adapters/openai';
import { buildComposioOpenAiTools, dispatchComposioTool, isComposioTool } from '../tools/adapters/composio';
import type { ToolContext } from '../tools/context';

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
    SPAWN_GUIDANCE_TEXT +
    buildMemorySection()
  );
}

/**
 * Resolve the concrete model for an agent at chat time. Honors:
 *   - model_tier === 'pinned' (or unset) → agent.model
 *   - model_tier === 'auto'              → triage on the user's message
 *   - model_tier === 'low'|'mid'|'high'  → cheapest available in that tier
 * Returns the agent's pinned model as a final fallback.
 */
function resolveAgentModel(agent: AgentRecord | undefined, taskText: string, providerHint?: string): string {
  const fallback = agent?.model ?? config.voidai.model;
  if (!agent) return fallback;
  const tier = agent.model_tier ?? 'pinned';
  if (tier === 'pinned') return fallback;
  const provider = providerHint ?? agent.provider ?? 'voidai';
  const result = pickModel({
    text:        taskText,
    provider,
    agentTier:   tier,
    pinnedModel: fallback,
  });
  return result.model ?? fallback;
}

function buildMemorySection(): string {
  if (!config.mcp.enabled) return '';
  return (
    '\n\n---\nMemory awareness:\n' +
    '- Before answering: consider calling `search_memory` (or `retrieve_relevant_memory`) when the user references prior work, asks "do you remember", or seems to expect continuity.\n' +
    '- After answering: if the exchange contains a decision, a procedure, a preference, or an insight worth keeping, call `write_vault_note` with the distilled lesson — never the raw chat.\n' +
    '- Prefer reusing an existing procedure over re-deriving it. If you find one in `search_memory` results, cite it back to the user.\n' +
    '- For long sessions, call `save_session_summary` before context fills up. You can also use `compact_context` to replace stale turns with a summary.\n' +
    '- The auto-extractor already runs after every assistant turn — do not duplicate that work; only call `write_vault_note` for something the auto-extractor would miss (e.g. a user-stated preference, an insight you yourself derived).'
  );
}

function buildTeamSection(currentAgentId: string, allAgents: AgentRecord[]): string {
  const peers = allAgents.filter(
    a => a.status === 'active' && a.id !== currentAgentId && !a.temporary,
  );
  const teamSection = peers.length > 0
    ? '\n\n---\nActive team members (use `message_agent` to contact them directly):\n' +
      peers.map(a => `- @${a.name}${a.description ? ' — ' + a.description : ''}`).join('\n') +
      '\nDo NOT tell the user to contact agents themselves — call the tool and do it for them.'
    : '';
  return teamSection + buildMemorySection();
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
  attachments?: ChatImageAttachment[],
  extraSystemContext?: string,
): Promise<void> {
  const history = getOrCreateHistory(sessionId, systemPrompt, agentId);
  const _agentRecordForCompaction = agentId ? getAgentById(agentId) : undefined;
  await compactOpenAi(history, userMessage, agentId, _agentRecordForCompaction?.name, sessionId);
  // Native multi-modal: when attachments are present, build a content array
  // with text + image_url blocks instead of a plain string. Saved-message
  // log still uses the text body (vision URLs aren't useful in transcripts).
  if (attachments && attachments.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any[] = [];
    if (userMessage) content.push({ type: 'text', text: userMessage });
    for (const a of attachments) content.push({ type: 'image_url', image_url: { url: a.url } });
    history.push({ role: 'user', content });
  } else {
    history.push({ role: 'user', content: userMessage });
  }
  saveMessage(sessionId, 'user', userMessage);
  logAnalytics('message_sent', { role: 'user', length: userMessage.length }, sessionId);

  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  const toolCtx: ToolContext = { agentId, sessionId, onMeta };
  // Match prior buildTools behavior: no tools at all when there's no active agent.
  const baseTools     = (agentRecord && agentRecord.status === 'active') ? buildOpenAiTools(toolCtx) : [];
  const composioTools = (agentRecord && agentRecord.status === 'active') ? await buildComposioOpenAiTools(toolCtx) : [];
  const tools = [...baseTools, ...composioTools];

  // Refresh team awareness so every agent sees the current live roster
  const allAgents = getAllAgents();
  if (agentRecord?.name === 'Alfred') {
    history[0] = { role: 'system', content: buildOrchestratorPrompt(allAgents) };
  } else if (agentRecord) {
    const base = agentRecord.system_prompt ?? systemPrompt;
    history[0] = { role: 'system', content: base + buildTeamSection(agentRecord.id, allAgents) };
  }

  // Append agent's declared skills (manual selection, no auto-routing).
  const skillsBlock = buildSkillsBlock(resolveEffectiveSkillNames(parseAgentSkills(agentRecord?.skills)));
  if (skillsBlock && history[0] && typeof history[0].content === 'string') {
    history[0] = { role: 'system', content: history[0].content + skillsBlock };
  }

  // Pre-inject relevant long-term memories into the system prompt.
  const memoryBlock = await buildMemoryContextBlock({ query: userMessage, agentId });
  if (memoryBlock && history[0] && typeof history[0].content === 'string') {
    history[0] = { role: 'system', content: history[0].content + memoryBlock };
  }

  // Per-turn extra context (Discord ids, future channel-specific hints, etc.).
  // Appended LAST so it always wins — agents see this verbatim regardless of
  // their stored system_prompt or any of the dynamic blocks above.
  if (extraSystemContext && history[0] && typeof history[0].content === 'string') {
    history[0] = { role: 'system', content: history[0].content + extraSystemContext };
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

    const resolvedModel = resolveAgentModel(agentRecord, userMessage, 'voidai');
    const stream = await getClient().chat.completions.create({
      model:           resolvedModel,
      messages:        history,
      stream:          true,
      stream_options:  { include_usage: true },
      ...(tools.length > 0 ? { tools } : {}),
    });
    let realInputTokens:  number | null = null;
    let realOutputTokens: number | null = null;

    let textAccum = '';
    // Accumulate tool call chunks: index → { id, name, args }
    const toolAcc: Record<number, { id: string; name: string; args: string }> = {};
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      // Final chunk carries usage when stream_options.include_usage is true.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usage = (chunk as any).usage;
      if (usage) {
        if (typeof usage.prompt_tokens === 'number')     realInputTokens  = usage.prompt_tokens;
        if (typeof usage.completion_tokens === 'number') realOutputTokens = usage.completion_tokens;
      }

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
        const result = (await isComposioTool(tc.function.name, toolCtx))
          ? await dispatchComposioTool(tc.function.name, tc.function.arguments, toolCtx)
          : await dispatchOpenAiTool(tc.function.name, tc.function.arguments, toolCtx);
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
      logSpend({
        provider:      'voidai',
        model_id:      resolvedModel,
        input_tokens:  realInputTokens  ?? inputTokens,
        output_tokens: realOutputTokens ?? outputTokens,
        agent_id:      agentId ?? null,
        session_id:    sessionId,
      });
      ingestExchangeAsync({
        source:         'chat',
        agent_id:       agentId,
        agent_name:     agentRecord?.name,
        session_id:     sessionId,
        user_text:      userMessage,
        assistant_text: textAccum,
      });
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
  extraSystemContext?: string,
): Promise<void> {
  if (config.claude.backend === 'claude-cli') {
    // Subscription auth path. No silent fallback to anthropic-api on failure.
    return chatStreamClaudeCli(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, extraSystemContext);
  }

  const history = getOrCreateAnthropicHistory(sessionId, agentId);
  const _agentRecordForCompaction = agentId ? getAgentById(agentId) : undefined;
  await compactAnthropic(history, userMessage, agentId, _agentRecordForCompaction?.name, sessionId);
  history.push({ role: 'user', content: userMessage });
  saveMessage(sessionId, 'user', userMessage);
  logAnalytics('message_sent', { role: 'user', length: userMessage.length }, sessionId);

  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  const toolCtx: ToolContext = { agentId, sessionId, onMeta };
  const baseOpenAiTools = (agentRecord && agentRecord.status === 'active') ? buildOpenAiTools(toolCtx) : [];
  const composioTools   = (agentRecord && agentRecord.status === 'active') ? await buildComposioOpenAiTools(toolCtx) : [];
  const openAiTools = [...baseOpenAiTools, ...composioTools];
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

  // Append declared skills before pre-injecting memory.
  const skillsBlock = buildSkillsBlock(resolveEffectiveSkillNames(parseAgentSkills(agentRecord?.skills)));
  if (skillsBlock) activeSystemPrompt += skillsBlock;

  // Pre-inject relevant long-term memories.
  const memoryBlock = await buildMemoryContextBlock({ query: userMessage, agentId });
  if (memoryBlock) activeSystemPrompt += memoryBlock;

  const model = resolveAgentModel(agentRecord, userMessage, 'anthropic') || 'claude-sonnet-4-6';
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
      system: activeSystemPrompt,
      messages: history,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    });

    let textAccum = '';
    const toolBlocks = new Map<number, { id: string; name: string; inputAcc: string }>();
    let stopReason: string | null = null;
    let realInputTokens:  number | null = null;
    let realOutputTokens: number | null = null;

    for await (const event of stream) {
      if (event.type === 'message_start') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const u = (event as any).message?.usage;
        if (u && typeof u.input_tokens === 'number') realInputTokens = u.input_tokens;
      } else if (event.type === 'content_block_start') {
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const u = (event as any).usage;
        if (u && typeof u.output_tokens === 'number') realOutputTokens = u.output_tokens;
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
        const result = (await isComposioTool(tb.name, toolCtx))
          ? await dispatchComposioTool(tb.name, tb.inputAcc, toolCtx)
          : await dispatchOpenAiTool(tb.name, tb.inputAcc, toolCtx);
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
      logSpend({
        provider:      'anthropic',
        model_id:      model,
        input_tokens:  realInputTokens  ?? estimateTokens(inputText),
        output_tokens: realOutputTokens ?? outputTokens,
        agent_id:      agentId ?? null,
        session_id:    sessionId,
      });
      ingestExchangeAsync({
        source:         'chat',
        agent_id:       agentId,
        agent_name:     agentRecord?.name,
        session_id:     sessionId,
        user_text:      userMessage,
        assistant_text: textAccum,
      });
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

// ── Claude CLI streaming (subscription auth) ─────────────────────────────────

// ── Auto-compaction adapters ────────────────────────────────────────────────

function openAiHistoryToTurns(history: ChatCompletionMessageParam[]): HistoryTurn[] {
  return history.map(m => {
    const role = (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
      ? m.role : 'system';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text = m.content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).filter(Boolean).join('\n');
    }
    return { role, text };
  });
}

function anthropicHistoryToTurns(history: Anthropic.Messages.MessageParam[]): HistoryTurn[] {
  return history.map(m => {
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text = (m.content as any[]).map(b => (b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
    }
    return { role: m.role as 'user' | 'assistant', text };
  });
}

/**
 * Extend the splice end forward so we never cut inside a tool-call pair.
 * OpenAI requires every assistant message with tool_calls to be IMMEDIATELY
 * followed by the matching tool-role messages (one per tool_call_id). If the
 * compactor splices part of that pair away, the next chat completion errors.
 *
 * Rule: the message AFTER the splice (history[to + 1]) must NOT be a `tool`
 * role response. If it is, walk `to` forward until it isn't — i.e. consume
 * the entire tool-call response block into the splice.
 */
function extendSpliceEndPastToolPair(history: ChatCompletionMessageParam[], from: number, to: number): number {
  let safeTo = to;
  while (safeTo + 1 < history.length && history[safeTo + 1]?.role === 'tool') safeTo++;
  // Also: if the last message in the splice is an assistant with tool_calls,
  // bring its tool-results in too (they may already be inside the splice, but
  // the previous loop covers the case where they straddle the boundary).
  return safeTo;
}

async function compactOpenAi(
  history: ChatCompletionMessageParam[],
  newUserText: string,
  agentId?: string,
  agentName?: string | null,
  sessionId?: string | null,
): Promise<void> {
  const turns = openAiHistoryToTurns(history);
  const plan  = await maybeCompactHistory({ history: turns, newUserText, agentId, agentName: agentName ?? null, sessionId: sessionId ?? null });
  if (!plan) return;
  const safeTo = extendSpliceEndPastToolPair(history, plan.from, plan.to);
  history.splice(plan.from, safeTo - plan.from + 1, { role: 'system', content: plan.replacement.text });
  logger.info('compactor: OpenAI history compacted', {
    reclaimed: plan.tokensReclaimed,
    extendedBy: safeTo - plan.to,
    vault: plan.summaryWritten.vault_path,
  });
}

/**
 * Anthropic equivalent: every assistant message with `tool_use` content must
 * be paired with a user message containing matching `tool_result` blocks.
 * If the splice cuts between them, the next API call errors with
 * "tool_use ids must have corresponding tool_result blocks".
 */
function extendAnthropicSpliceEnd(history: Anthropic.Messages.MessageParam[], from: number, to: number): number {
  let safeTo = to;
  // Walk forward as long as the next message is a `user` role with tool_result blocks.
  while (safeTo + 1 < history.length) {
    const next = history[safeTo + 1];
    if (next?.role !== 'user') break;
    const blocks = Array.isArray(next.content) ? next.content : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasToolResult = blocks.some((b: any) => b?.type === 'tool_result');
    if (!hasToolResult) break;
    safeTo++;
  }
  return safeTo;
}

async function compactAnthropic(
  history: Anthropic.Messages.MessageParam[],
  newUserText: string,
  agentId?: string,
  agentName?: string | null,
  sessionId?: string | null,
): Promise<void> {
  const turns = anthropicHistoryToTurns(history);
  const plan  = await maybeCompactHistory({ history: turns, newUserText, agentId, agentName: agentName ?? null, sessionId: sessionId ?? null });
  if (!plan) return;
  const safeTo = extendAnthropicSpliceEnd(history, plan.from, plan.to);
  // Anthropic messages must alternate user/assistant. Splice in as a user message
  // labeled clearly so the model treats it as prior-turn context.
  const replacement: Anthropic.Messages.MessageParam = {
    role: 'user',
    content: plan.replacement.text,
  };
  history.splice(plan.from, safeTo - plan.from + 1, replacement);
  logger.info('compactor: Anthropic history compacted', {
    reclaimed: plan.tokensReclaimed,
    extendedBy: safeTo - plan.to,
    vault: plan.summaryWritten.vault_path,
  });
}

function flattenAnthropicHistoryAsText(history: Anthropic.Messages.MessageParam[]): string {
  if (history.length === 0) return '';
  const lines: string[] = [];
  for (const msg of history) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    if (typeof msg.content === 'string') {
      lines.push(`[${role}] ${msg.content}`);
    } else {
      const text = msg.content
        .map(b => (b.type === 'text' ? b.text : ''))
        .filter(Boolean)
        .join('\n');
      if (text) lines.push(`[${role}] ${text}`);
    }
  }
  return lines.join('\n\n');
}

async function chatStreamClaudeCli(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  systemPrompt: string,
  agentId?: string,
  _onMeta?: (e: MetaEvent) => void | Promise<void>,
  extraSystemContext?: string,
): Promise<void> {
  const history = getOrCreateAnthropicHistory(sessionId, agentId);
  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  await compactAnthropic(history, userMessage, agentId, agentRecord?.name, sessionId);
  saveMessage(sessionId, 'user', userMessage);
  logAnalytics('message_sent', { role: 'user', length: userMessage.length }, sessionId);

  const allAgents = getAllAgents();
  let activeSystemPrompt = systemPrompt;
  if (agentRecord?.name === 'Alfred') {
    activeSystemPrompt = buildOrchestratorPrompt(allAgents);
  } else if (agentRecord) {
    activeSystemPrompt = (agentRecord.system_prompt ?? systemPrompt) + buildTeamSection(agentRecord.id, allAgents);
  }

  // Append declared skills.
  const skillsBlock = buildSkillsBlock(resolveEffectiveSkillNames(parseAgentSkills(agentRecord?.skills)));
  if (skillsBlock) activeSystemPrompt += skillsBlock;

  // Pre-inject relevant long-term memories — critical for the Claude CLI
  // backend, which never sees our custom memory tools.
  const memoryBlock = await buildMemoryContextBlock({ query: userMessage, agentId });
  if (memoryBlock) activeSystemPrompt += memoryBlock;

  // Per-turn extra context (Discord ids etc.).
  if (extraSystemContext) activeSystemPrompt += extraSystemContext;

  const priorHistoryText = flattenAnthropicHistoryAsText(history);
  const finalSystemPrompt = priorHistoryText
    ? `${activeSystemPrompt}\n\n## Recent conversation\n${priorHistoryText}`
    : activeSystemPrompt;

  const model = resolveAgentModel(agentRecord, userMessage, 'anthropic') || 'claude-sonnet-4-6';
  const trace = createChatTrace(sessionId, agentId, agentRecord?.name, userMessage);
  const generation = trace?.generation({
    name: 'claude-cli-completion',
    model,
    input: { systemPrompt: finalSystemPrompt, prompt: userMessage },
    startTime: new Date(),
  });

  const maxRetries = config.claude.retryMax;
  const baseMs     = config.claude.retryBaseMs;
  let attempt = 0;
  let textAccum = '';
  let realInputTokens:  number | null = null;
  let realOutputTokens: number | null = null;

  while (true) {
    try {
      textAccum = '';
      for await (const chunk of streamClaudeCliChat({
        prompt:       userMessage,
        systemPrompt: finalSystemPrompt,
        sessionId,
        model,
        agentId,
        execEnabled:  !!agentRecord?.exec_enabled,
        onUsage:      (u) => {
          if (typeof u.input_tokens  === 'number') realInputTokens  = u.input_tokens;
          if (typeof u.output_tokens === 'number') realOutputTokens = u.output_tokens;
        },
      })) {
        await onChunk(chunk);
        textAccum += chunk;
      }
      break;
    } catch (err) {
      if (err instanceof ClaudeCliRateLimitError && attempt < maxRetries) {
        const delay = baseMs * Math.pow(2, attempt);
        attempt++;
        logger.warn('Claude CLI 429 — backing off', { attempt, delayMs: delay });
        try {
          logHive('claude_cli_throttled', 'Claude CLI 429, retrying with backoff', agentId, {
            attempt,
            delayMs: delay,
          });
        } catch {
          // hive logging is best-effort
        }
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      generation?.end({ output: '[error]', metadata: { error: (err as Error).message } });
      if (err instanceof ClaudeCliAuthError) {
        logger.error('Claude CLI auth failed — run `claude` to refresh credentials');
      }
      throw err;
    }
  }

  history.push({ role: 'user',      content: userMessage });
  history.push({ role: 'assistant', content: textAccum });
  saveMessage(sessionId, 'assistant', textAccum, agentId);
  logAnalytics('message_sent', { role: 'assistant', length: textAccum.length, agentId }, sessionId);
  generation?.end({ output: textAccum, metadata: { outputTokens: estimateTokens(textAccum) } });
  trace?.update({ output: textAccum });
  logSpend({
    provider:      'anthropic',
    model_id:      model,
    input_tokens:  realInputTokens  ?? estimateTokens(finalSystemPrompt + userMessage),
    output_tokens: realOutputTokens ?? estimateTokens(textAccum),
    agent_id:      agentId ?? null,
    session_id:    sessionId,
  });
  ingestExchangeAsync({
    source:         'chat',
    agent_id:       agentId,
    agent_name:     agentRecord?.name,
    session_id:     sessionId,
    user_text:      userMessage,
    assistant_text: textAccum,
  });
}

// ── Codex CLI streaming (ChatGPT subscription auth via local `codex` binary) ─

async function chatStreamCodexCli(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  systemPrompt: string,
  agentId?: string,
  _onMeta?: (e: MetaEvent) => void | Promise<void>,
  extraSystemContext?: string,
): Promise<void> {
  const { streamCodexCliChat, CodexCliAuthError, CodexCliRateLimitError } = await import('../providers/codex-cli');
  const history = getOrCreateAnthropicHistory(sessionId, agentId);
  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  await compactAnthropic(history, userMessage, agentId, agentRecord?.name, sessionId);
  saveMessage(sessionId, 'user', userMessage);
  logAnalytics('message_sent', { role: 'user', length: userMessage.length }, sessionId);

  const allAgents = getAllAgents();
  let activeSystemPrompt = systemPrompt;
  if (agentRecord?.name === 'Alfred') {
    activeSystemPrompt = buildOrchestratorPrompt(allAgents);
  } else if (agentRecord) {
    activeSystemPrompt = (agentRecord.system_prompt ?? systemPrompt) + buildTeamSection(agentRecord.id, allAgents);
  }
  const skillsBlock = buildSkillsBlock(resolveEffectiveSkillNames(parseAgentSkills(agentRecord?.skills)));
  if (skillsBlock) activeSystemPrompt += skillsBlock;
  const memoryBlock = await buildMemoryContextBlock({ query: userMessage, agentId });
  if (memoryBlock) activeSystemPrompt += memoryBlock;
  // Per-turn extra context (Discord ids etc.).
  if (extraSystemContext) activeSystemPrompt += extraSystemContext;

  const priorHistoryText = flattenAnthropicHistoryAsText(history);
  const finalSystemPrompt = priorHistoryText
    ? `${activeSystemPrompt}\n\n## Recent conversation\n${priorHistoryText}`
    : activeSystemPrompt;

  const model = agentRecord?.model || 'gpt-5.5';
  const trace = createChatTrace(sessionId, agentId, agentRecord?.name, userMessage);
  const generation = trace?.generation({
    name: 'codex-cli-completion',
    model,
    input: { systemPrompt: finalSystemPrompt, prompt: userMessage },
    startTime: new Date(),
  });

  let textAccum = '';
  let realInputTokens:  number | null = null;
  let realOutputTokens: number | null = null;

  try {
    for await (const chunk of streamCodexCliChat({
      prompt:       userMessage,
      systemPrompt: finalSystemPrompt,
      model,
      agentId,
      sessionId,
      onUsage: (u) => {
        if (typeof u.input_tokens  === 'number') realInputTokens  = u.input_tokens;
        if (typeof u.output_tokens === 'number') realOutputTokens = u.output_tokens;
      },
    })) {
      await onChunk(chunk);
      textAccum += chunk;
    }
  } catch (err) {
    generation?.end({ output: '[error]', metadata: { error: (err as Error).message } });
    if (err instanceof CodexCliAuthError) {
      logger.error('Codex CLI auth failed — run `codex login` to refresh credentials');
    } else if (err instanceof CodexCliRateLimitError) {
      logger.warn('Codex CLI rate-limited');
    }
    throw err;
  }

  history.push({ role: 'user',      content: userMessage });
  history.push({ role: 'assistant', content: textAccum });
  saveMessage(sessionId, 'assistant', textAccum, agentId);
  logAnalytics('message_sent', { role: 'assistant', length: textAccum.length, agentId }, sessionId);
  generation?.end({ output: textAccum, metadata: { outputTokens: estimateTokens(textAccum) } });
  trace?.update({ output: textAccum });
  logSpend({
    provider:      'codex',
    model_id:      model,
    input_tokens:  realInputTokens  ?? estimateTokens(finalSystemPrompt + userMessage),
    output_tokens: realOutputTokens ?? estimateTokens(textAccum),
    agent_id:      agentId ?? null,
    session_id:    sessionId,
  });
  ingestExchangeAsync({
    source:         'chat',
    agent_id:       agentId,
    agent_name:     agentRecord?.name,
    session_id:     sessionId,
    user_text:      userMessage,
    assistant_text: textAccum,
  });
}

// ── Public chatStream dispatcher ─────────────────────────────────────────────

/** Image attachment forwarded into the chat path when the resolved vision
 *  mode is 'native'. The route handler runs the 'preprocess' branch upstream
 *  and never threads anything here in that case (it's already inlined as text). */
export interface ChatImageAttachment {
  url:        string;
  mime_type?: string;
  name?:      string;
}

/**
 * Routes to the correct streaming implementation based on agent provider.
 * `attachments` is only set when the agent is on a vision-capable provider
 * AND vision_mode resolved to 'native' — for all other paths the route
 * handler converted the images into text descriptions before calling us.
 *
 * `extraSystemContext` is appended to the dynamically-rebuilt system prompt
 * on every turn (after team awareness + skills + memory blocks). Use it for
 * per-request context the agent needs but that doesn't belong in its stored
 * prompt: the Discord turn ids the bot path threads in, etc.
 */
export async function chatStream(
  userMessage: string,
  sessionId: string,
  onChunk: (chunk: string) => void | Promise<void>,
  systemPrompt: string,
  agentId?: string,
  onMeta?: (e: MetaEvent) => void | Promise<void>,
  attachments?: ChatImageAttachment[],
  extraSystemContext?: string,
): Promise<void> {
  const agentRecord = agentId ? getAgentById(agentId) : undefined;
  // Pre-warm fire-and-forget: if this agent's last heartbeat is stale (or
  // they've never had one), kick a tiny ping in parallel with the chat call so
  // the MCP / provider connection is hot for the next turn.
  if (agentRecord) prewarmAgentAsync(agentRecord);
  if (agentRecord?.provider === 'anthropic') {
    // Anthropic + Codex paths default to preprocess (descriptions inlined upstream),
    // so any attachments still here are bonus — Anthropic API can take them but
    // we'd need to extend the path. For now, drop with a warning if present.
    if (attachments && attachments.length > 0) {
      logger.warn('chatStream: native attachments dropped on anthropic path; agent\'s vision_mode should resolve to preprocess', { agentId, count: attachments.length });
    }
    return chatStreamAnthropic(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, extraSystemContext);
  }
  if (agentRecord?.provider === 'codex') {
    if (attachments && attachments.length > 0) {
      logger.warn('chatStream: native attachments dropped on codex path; agent\'s vision_mode should resolve to preprocess', { agentId, count: attachments.length });
    }
    return chatStreamCodexCli(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, extraSystemContext);
  }
  return chatStreamOpenAI(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta, attachments, extraSystemContext);
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
