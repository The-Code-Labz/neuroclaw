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
  createAgentMessage, updateAgentMessageResponse,
  type AgentRecord,
} from '../db';
import { logger } from '../utils/logger';
import { classifyRoute } from '../system/router';
import { spawnAgentAsync, type SpawnRequest } from '../system/spawner';
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

  if (config.mcp.enabled) {
    tools.push(
      {
        type: 'function',
        function: {
          name:        'search_memory',
          description: 'Search across memory_index + NeuroVault (and ResearchLM/InsightsLM if configured). Returns categorized hits ranked by salience, importance, and recency.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to look up (2-8 keywords).' },
              limit: { type: 'number', description: 'Max hits (default 20).' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name:        'search_vault',
          description: 'Search the NeuroVault MCP directly (no SQLite). Useful when you specifically want vault-stored notes.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' },
              vault: { type: 'string', description: 'Vault name (defaults to NEUROVAULT_DEFAULT_VAULT).' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name:        'write_vault_note',
          description: 'Persist a structured memory: indexes locally and mirrors to NeuroVault. Use for procedures, insights, decisions, or preferences worth keeping. Do NOT save raw chat — write the distilled lesson.',
          parameters: {
            type: 'object',
            properties: {
              title:      { type: 'string', description: '4-8 words.' },
              type:       { type: 'string', description: 'One of: episodic, semantic, procedural, preference, insight, project.' },
              summary:    { type: 'string', description: '1-2 sentence summary.' },
              content:    { type: 'string', description: 'Optional richer body (2-5 sentences).' },
              tags:       { type: 'array', items: { type: 'string' } },
              importance: { type: 'number', description: '0-1, default 0.7.' },
            },
            required: ['title', 'type', 'summary'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name:        'save_session_summary',
          description: 'Save a summary of the current session to memory + vault. Call before context pressure forces a compaction.',
          parameters: {
            type: 'object',
            properties: {
              summary:    { type: 'string', description: 'Distilled summary of what happened.' },
              title:      { type: 'string' },
              tags:       { type: 'array', items: { type: 'string' } },
              importance: { type: 'number' },
            },
            required: ['summary'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name:        'compact_context',
          description: 'Compact the conversation: provide a summary you want to keep; the rest of the prior context is replaced with that summary plus any retrieved relevant memories.',
          parameters: {
            type: 'object',
            properties: {
              conversation: { type: 'string', description: 'Serialized recent turns to compact.' },
            },
            required: ['conversation'],
          },
        },
      },
    );
  }

  if (agent.exec_enabled) {
    tools.push(
      {
        type: 'function',
        function: {
          name:        'bash_run',
          description: 'Run a shell command on the host. Returns stdout, stderr, exit code, duration. Output is byte-capped; some destructive patterns are hard-blocked.',
          parameters: {
            type:       'object',
            properties: {
              command:    { type: 'string', description: 'The full shell command to run (executed via bash -lc).' },
              cwd:        { type: 'string', description: 'Working directory. Defaults to EXEC_DEFAULT_CWD.' },
              timeout_ms: { type: 'number', description: 'Per-call timeout in ms; capped server-side.' },
            },
            required: ['command'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name:        'fs_read',
          description: 'Read the contents of a file on the host. Output is byte-capped; truncated if too large.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Absolute or relative file path.' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name:        'fs_write',
          description: 'Write to a file on the host. mode=overwrite (default), append, or create (fails if exists). Creates parent dirs.',
          parameters: {
            type: 'object',
            properties: {
              path:    { type: 'string' },
              content: { type: 'string' },
              mode:    { type: 'string', enum: ['create', 'overwrite', 'append'] },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name:        'fs_list',
          description: 'List the contents of a directory.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name:        'fs_search',
          description: 'Recursively search for a regex/pattern across files (uses ripgrep when available, else grep -rn).',
          parameters: {
            type: 'object',
            properties: {
              pattern:     { type: 'string' },
              path:        { type: 'string', description: 'Directory to search (defaults to EXEC_DEFAULT_CWD).' },
              max_results: { type: 'number' },
            },
            required: ['pattern'],
          },
        },
      },
    );
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
  // ── memory tools (gated on MCP enabled at registration time) ─────────────
  if (name === 'search_memory' || name === 'search_vault' || name === 'write_vault_note' || name === 'save_session_summary' || name === 'compact_context') {
    let args: Record<string, unknown>;
    try { args = JSON.parse(argsStr); } catch { return JSON.stringify({ error: `Invalid ${name} arguments` }); }
    const tools = await import('../memory/memory-tools');
    const agent = parentAgentId ? getAgentById(parentAgentId) : undefined;
    try {
      let result: unknown;
      if (name === 'search_memory') {
        result = await tools.searchMemoryTool({
          query: String(args.query ?? ''),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          agentId: parentAgentId ?? null,
        });
      } else if (name === 'search_vault') {
        result = await tools.searchVaultTool({
          query: String(args.query ?? ''),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          vault: typeof args.vault === 'string' ? args.vault : undefined,
        });
      } else if (name === 'write_vault_note') {
        result = await tools.writeVaultNoteTool({
          title:      String(args.title ?? ''),
          type:       String(args.type ?? 'episodic'),
          summary:    String(args.summary ?? ''),
          content:    typeof args.content === 'string' ? args.content : undefined,
          tags:       Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          importance: typeof args.importance === 'number' ? args.importance : undefined,
          agent_id:   parentAgentId ?? null,
          agent_name: agent?.name,
          session_id: sessionId ?? null,
        });
      } else if (name === 'save_session_summary') {
        result = await tools.saveSessionSummaryTool({
          summary:    String(args.summary ?? ''),
          title:      typeof args.title === 'string' ? args.title : undefined,
          tags:       Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          importance: typeof args.importance === 'number' ? args.importance : undefined,
          agent_id:   parentAgentId ?? null,
          agent_name: agent?.name,
          session_id: sessionId ?? null,
        });
      } else {
        result = await tools.compactContextTool({
          conversation: String(args.conversation ?? ''),
          agent_id:     parentAgentId ?? null,
          agent_name:   agent?.name,
          session_id:   sessionId ?? null,
        });
      }
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }
  }

  // ── exec tools (gated on agent.exec_enabled at registration time) ─────────
  if (name === 'bash_run' || name === 'fs_read' || name === 'fs_write' || name === 'fs_list' || name === 'fs_search') {
    let args: Record<string, unknown>;
    try { args = JSON.parse(argsStr); } catch { return JSON.stringify({ error: `Invalid ${name} arguments` }); }
    const exec = await import('../system/exec-tools');
    let result: unknown;
    if (name === 'bash_run') {
      result = await exec.bashRun({
        command:    String(args.command ?? ''),
        cwd:        typeof args.cwd === 'string' ? args.cwd : undefined,
        timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        agentId:    parentAgentId,
      });
    } else if (name === 'fs_read') {
      result = await exec.fsRead({ path: String(args.path ?? ''), agentId: parentAgentId });
    } else if (name === 'fs_write') {
      result = await exec.fsWrite({
        path:    String(args.path ?? ''),
        content: String(args.content ?? ''),
        mode:    args.mode === 'create' || args.mode === 'append' ? args.mode : 'overwrite',
        agentId: parentAgentId,
      });
    } else if (name === 'fs_list') {
      result = await exec.fsList({ path: String(args.path ?? ''), agentId: parentAgentId });
    } else {
      result = await exec.fsSearch({
        pattern:     String(args.pattern ?? ''),
        path:        typeof args.path === 'string' ? args.path : undefined,
        max_results: typeof args.max_results === 'number' ? args.max_results : undefined,
        agentId:     parentAgentId,
      });
    }
    return JSON.stringify(result);
  }

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

  const result = await spawnAgentAsync({ ...args, parentAgentId });
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
  const _agentRecordForCompaction = agentId ? getAgentById(agentId) : undefined;
  await compactOpenAi(history, userMessage, agentId, _agentRecordForCompaction?.name, sessionId);
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
): Promise<void> {
  if (config.claude.backend === 'claude-cli') {
    // Subscription auth path. No silent fallback to anthropic-api on failure.
    return chatStreamClaudeCli(userMessage, sessionId, onChunk, systemPrompt, agentId, onMeta);
  }

  const history = getOrCreateAnthropicHistory(sessionId, agentId);
  const _agentRecordForCompaction = agentId ? getAgentById(agentId) : undefined;
  await compactAnthropic(history, userMessage, agentId, _agentRecordForCompaction?.name, sessionId);
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
  history.splice(plan.from, plan.to - plan.from + 1, { role: 'system', content: plan.replacement.text });
  logger.info('compactor: OpenAI history compacted', { reclaimed: plan.tokensReclaimed, vault: plan.summaryWritten.vault_path });
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
  // Anthropic messages must alternate user/assistant. Splice in as a user message
  // labeled clearly so the model treats it as prior-turn context.
  const replacement: Anthropic.Messages.MessageParam = {
    role: 'user',
    content: plan.replacement.text,
  };
  history.splice(plan.from, plan.to - plan.from + 1, replacement);
  logger.info('compactor: Anthropic history compacted', { reclaimed: plan.tokensReclaimed, vault: plan.summaryWritten.vault_path });
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
