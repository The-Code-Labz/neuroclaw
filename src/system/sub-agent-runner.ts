// src/system/sub-agent-runner.ts
// Non-blocking sub-agent execution harness.
//
// runSubAgentAsync() fires immediately and returns — the caller gets a task ID
// and the work happens in a detached Promise. Results are written to:
//   1. The local DB tasks table (status: done/failed, output field)
//   2. Hive Mind events (subtask_complete / subtask_failed / subtask_blocked)
//   3. taskEvents emitter → SSE stream → dashboard

import { randomUUID } from 'crypto';
import { RESEARCH_DISCIPLINE } from '../agent/prompt-fragments';
import { getDb, createAgentMessage, getAgentById } from '../db';
import { logHive }    from './hive-mind';
import { taskEvents } from './background-tasks';
import { logger }     from '../utils/logger';
import { translateClaudeError } from '../utils/claudeErrorLabel';
import { config }     from '../config';
import { triageSubAgentModel, type SubAgentProvider } from './sub-agent-triage';
import { getSubAgentKimiClient, getSubAgentMinimaxClient } from '../agent/subagent-clients';
import { isProgressOnlyOutput } from '../utils/progress-only-detector';
import { shouldDeliverTaskUpdate, type TaskNotifyPolicy } from './task-notify-policy';
import { getDetachedTaskLifecycleRuntime } from './detached-task-runtime';
import { isToolBlockedForSubAgent } from '../tools/registry';
import { dispatchOpenAiTool, buildOpenAiTools } from '../tools/adapters/openai';
import type { ToolContext } from '../tools/context';
import { KeyedSemaphore } from '../utils/keyed-semaphore';

// Per-provider-family concurrency gate (P2). Bounds simultaneous sub-agent LLM
// requests to each family (kimi/minimax) so a burst of fire-and-forget
// run_subtask calls can't stampede a single provider into 429s. Excess calls
// queue and admit as slots free up; the gate wraps only the network request,
// not the between-turn tool dispatch, so slow browser/web tools don't hold a
// provider slot hostage.
const providerGate = new KeyedSemaphore(config.subAgent.providerMaxConcurrent);

export interface RunSubAgentOptions {
  task:                  string;
  context:               string;
  agentName?:            string;
  parentAgentId?:        string | null;
  parentSessionId?:      string | null;
  priorityOverride?:     string;
  kind?:                 'code' | 'prose'; // explicit routing override — bypasses keyword scorer
  spawnDepth?:           number;           // defaults to 1 for all sub-agent calls
  allowedToolOverrides?: string[];         // tools the parent explicitly permitted
  notifyPolicy?:         TaskNotifyPolicy; // default: 'done_only'
}

export interface SubAgentHandle {
  taskId:   string;
  provider: string;
  model:    string;
}

// ── Provider fallback map (quota-aware routing) ────────────────────────────
// See specs/sub-agent-quota-fallback.md

interface SubAgentRoute {
  provider: SubAgentProvider;
  model:    string;
  family:   string;
}

// Two-provider fallback chain: kimi ↔ minimax (native gateways).
// If the primary quota-exhausts, the other picks up; no other providers are used.
const PROVIDER_FALLBACK_MAP: Record<string, SubAgentRoute[]> = {
  'kimi': [
    { provider: 'minimax', model: '', family: 'minimax' },  // model resolved at runtime
  ],
  'minimax': [
    { provider: 'kimi',    model: '', family: 'kimi'    },  // model resolved at runtime
  ],
};

// ── Quota exhaustion cache (60s TTL, process-scoped) ──────────────────────

const quotaExhaustedUntil = new Map<string, number>();

function isQuotaExhausted(family: string): boolean {
  const until = quotaExhaustedUntil.get(family);
  return until !== undefined && Date.now() < until;
}

function markQuotaExhausted(family: string, ttlMs = 60_000): void {
  quotaExhaustedUntil.set(family, Date.now() + ttlMs);
  logger.warn('sub-agent-runner: provider marked quota-exhausted', { family, ttlMs });
}

function isQuotaError(err: unknown): boolean {
  const msg    = err instanceof Error ? err.message : String(err);
  const status = (err as any)?.httpStatus ?? (err as any)?.status;
  return status === 429 || msg.includes('rate limit') || msg.includes('usage limit') || msg.includes('quota');
}

// ── System prompt sanitizer ────────────────────────────────────────────────
// Only strip literal NeuroClaw tool-call references that would confuse an
// external provider (no fs_write/bash_run available on non-CLI paths).
// Do NOT strip generic English like "write the file to" — that corrupts prompts
// that use those words non-literally and leaves the sub-agent with no guidance.

const SUB_AGENT_TOOL_INSTRUCTION_PATTERNS = [
  /use\s+`?fs_write`?\s+to\b/gi,
  /call\s+`?bash_run`?\b/gi,
];

function sanitizeSystemPromptForSubAgent(prompt: string, allowedToolOverrides?: string[]): string {
  const bashAllowed = allowedToolOverrides?.includes('bash_run') ?? false;
  let sanitized = prompt;
  if (!bashAllowed) {
    for (const pattern of SUB_AGENT_TOOL_INSTRUCTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[not available in text-only sub-agent mode]');
    }
  }
  const toolNote =
    '\n\nTOOLS: You have the same tool surface as a main agent. Use `search_tools(query)` to find a capability, ' +
    '`get_tool_schema(name)` to inspect its parameters, then `call_tool(name, args)` to invoke it. This reaches the full ' +
    'registry, the MCP research servers (web_search, browserless_fetch, perplexity, crawl4ai, deep_research, web_research, ' +
    'browser_agent, etc.), and skills. You may NOT ' +
    'write files, run shell, persist memory (write_vault_note / save_session_summary), manage tasks / projects / skills, ' +
    'schedule jobs, spawn further sub-agents, delegate to other agents, or take external (Composio) actions — those are ' +
    'blocked for sub-agents. Do NOT attempt them: a blocked call is wasted and repeated blocked calls will end your turn ' +
    'early. Return your result as text and the parent agent performs any writes, memory persistence, or actions.' +
    RESEARCH_DISCIPLINE;
  const note = bashAllowed
    ? '\n\nNOTE: You are running as a sub-agent with shell access. Use Write/Edit/Bash tools directly to make changes. Broker credentials (e.g. SHARED_GITHUB_PAT, API keys) are already injected as env vars — use $SECRET_NAME directly in shell commands. Return a concise summary of what you did and which files changed.' + toolNote
    : '\n\nNOTE: You are a sub-agent. You cannot write to disk or run shell commands. OUTPUT CONTRACT for code tasks: return complete file content in fenced code blocks annotated with the target path (e.g. ```typescript src/foo.ts\n...\n```), stacked for multiple files — the parent applies them. For research/analysis tasks, return the actual findings/answer as text.' + toolNote;
  return sanitized + note;
}

function truncateContext(text: string): string {
  const limit = config.subAgent.contextLimitTokens * 4;
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n[...truncated]';
}

function insertSubAgentTask(taskId: string, opts: RunSubAgentOptions, provider: string, model: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO tasks
      (id, title, description, status, notify_policy, agent_id, session_id, task_source, created_at, updated_at)
     VALUES (?, ?, ?, 'doing', ?, ?, ?, 'subtask', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  ).run(
    taskId,
    opts.task.slice(0, 120),
    opts.task,
    opts.notifyPolicy ?? 'done_only',
    opts.parentAgentId ?? null,
    opts.parentSessionId ?? null,
  );
}

/**
 * Write terminal state for a successfully-executed sub-agent task.
 * terminalOutcome='blocked' means progress-only output (spec: sub-agent-blocked-outcome).
 * Exported so the detached-task-runtime default implementation can use it.
 */
export function resolveSubAgentTask(
  taskId: string,
  output: string,
  terminalOutcome: 'blocked' | null = null,
): void {
  getDb().prepare(
    `UPDATE tasks
     SET status='done', output=?, terminal_outcome=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id=?`,
  ).run(output, terminalOutcome, taskId);
}

/**
 * Write terminal failure state for a sub-agent task.
 * Exported so the detached-task-runtime default implementation can use it.
 */
export function failSubAgentTask(taskId: string, error: string): void {
  getDb().prepare(
    `UPDATE tasks SET status='failed', output=?, terminal_outcome=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id=?`,
  ).run(JSON.stringify({ error }), taskId);
}

/**
 * Cancel a task intentionally (spec: task-status-extension).
 */
export function cancelTask(taskId: string, reason: string): void {
  getDb().prepare(
    `UPDATE tasks SET status='cancelled', block_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id=?`,
  ).run(reason, taskId);
}

/**
 * Surface a subtask's terminal state into the parent agent's inbox
 * (agent_messages → drained into the parent's next turn by agent-inbox).
 *
 * Root cause this fixes: chat history is restored from DB as user/assistant
 * text only, so across turns the parent loses the taskId that run_subtask
 * returned. When the user asks "is it done?", the parent has no idea a
 * subtask ever ran and spawns the same one again — the repeat-sub-agent
 * loop. The inbox note puts the taskId back in the parent's context.
 *
 * Keep content under the inbox's 240-char per-message truncation, with the
 * taskId early so it can never be cut off. Best-effort: must never throw.
 */
function notifyParentInbox(
  taskId: string,
  opts: RunSubAgentOptions,
  status: 'done' | 'blocked' | 'failed',
  detail?: string,
): void {
  if (!opts.parentAgentId) return;
  try {
    const parent = getAgentById(opts.parentAgentId);
    if (!parent) return;
    const title = opts.task.replace(/\s+/g, ' ').slice(0, 40);
    let content: string;
    if (status === 'done') {
      content = `Subtask done [task-id: ${taskId}] "${title}". Call get_subtask_result('${taskId}') and use its result — do NOT re-spawn this subtask.`;
    } else if (status === 'blocked') {
      content = `Subtask blocked [task-id: ${taskId}] "${title}". ${(detail ?? 'No actionable output.').slice(0, 90)}`;
    } else {
      content = `Subtask FAILED [task-id: ${taskId}] "${title}". ${(detail ?? '').slice(0, 90)}`;
    }
    createAgentMessage(null, 'SubAgent Runner', opts.parentAgentId, parent.name, content, opts.parentSessionId ?? undefined);
  } catch (err) {
    logger.warn('sub-agent-runner: parent inbox notify failed', { taskId, error: (err as Error).message });
  }
}

// Sub-agents now get the SAME upfront tool surface as main agents — core tools
// plus the search_tools/call_tool/get_tool_schema meta-tools — so they can
// discover and invoke the full registry, the MCP research servers, and skills.
// The lockdown is enforced centrally at dispatch (isToolBlockedForSubAgent),
// not by withholding the offer. MAX_TOOL_TURNS is raised (config) to cover the
// extra turns that tool discovery costs.
const MAX_TOOL_TURNS = config.subAgent.maxToolTurns;

// MiniMax (and some reasoning models) emit <think>...</think> before the answer.
// Keep only the final answer (everything after the last </think>); strip stray
// tags. Falls back to the original text if stripping would empty the output.
function stripThinkBlocks(text: string): string {
  if (!text || !/<\/?think>/i.test(text)) return text;
  const close = text.toLowerCase().lastIndexOf('</think>');
  let out = close >= 0 ? text.slice(close + '</think>'.length) : text;
  out = out.replace(/<\/?think>/gi, '').trim();
  return out || text.trim();
}

async function runOnRoute(opts: RunSubAgentOptions, route: SubAgentRoute, ctx: string, systemPrompt: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    ...(ctx ? [{ role: 'user', content: `Context:\n${ctx}` }] : []),
    { role: 'user', content: opts.task },
  ];

  const resolveModel = (r: SubAgentRoute): string =>
    r.model || (r.provider === 'kimi' ? config.subAgent.kimi.model : config.subAgent.minimax.model);

  const toolCtx: ToolContext = {
    agentId:              opts.parentAgentId ?? null,
    sessionId:            opts.parentSessionId ?? null,
    spawnDepth:           1,
    allowedToolOverrides: opts.allowedToolOverrides,
  };

  // Offer the same upfront surface main agents get (visibleCoreTools +
  // search_tools/call_tool/get_tool_schema). The sub-agent reaches everything
  // else — full registry, MCP research servers, skills — by searching and
  // calling through the meta-tools, with the lockdown enforced at dispatch.
  // We still filter the UPFRONT list so we don't advertise a core tool the
  // sub-agent can't use (e.g. fs_write, run_subtask), which would just burn a
  // turn on a guaranteed "blocked"/"gated" error.
  const tools = buildOpenAiTools(toolCtx)
    .filter(t => !isToolBlockedForSubAgent(t.function.name, toolCtx, opts.allowedToolOverrides));

  const client = route.provider === 'kimi' ? getSubAgentKimiClient() : getSubAgentMinimaxClient();
  const model  = resolveModel(route);

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await providerGate.run(route.family, () => client.chat.completions.create({
      model,
      messages,
      stream: false,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const choice = (response as any).choices?.[0];
    const msg    = choice?.message;
    if (!msg) break;

    if (choice.finish_reason === 'tool_calls' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Strip <think> blocks from INTERMEDIATE assistant messages too — they
      // otherwise stay in the transcript fed back to the model every turn,
      // wasting context and sometimes confusing the next completion.
      const intermediate = typeof msg.content === 'string'
        ? (msg.content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim() || null)
        : null;
      messages.push({ role: 'assistant', content: intermediate, tool_calls: msg.tool_calls });

      const results = await Promise.all(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        msg.tool_calls.map(async (tc: any) => ({
          role:         'tool' as const,
          tool_call_id: tc.id,
          content:      await dispatchOpenAiTool(tc.function.name, tc.function.arguments, toolCtx),
        })),
      );
      messages.push(...results);
      logger.info('sub-agent-runner: tool turn', { turn, tools: msg.tool_calls.map((tc: any) => tc.function.name) });
      continue;
    }

    return stripThinkBlocks(msg.content ?? '');
  }

  // Exhausted turns — return last assistant text if any. Never return ''
  // silently: an empty string used to be written to the task as a successful
  // result, giving the parent no signal that the sub-agent ran out of turns.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const last = [...messages].reverse().find((m: any) => m.role === 'assistant' && typeof m.content === 'string');
  const lastText = stripThinkBlocks((last?.content as string | undefined) ?? '');
  if (lastText.trim()) return lastText;
  logger.warn('sub-agent-runner: exhausted tool turns with no final text', { family: route.family, model });
  return `[sub-agent incomplete: exhausted ${MAX_TOOL_TURNS} tool turns without producing a final answer — re-run with a narrower task or fewer required tool calls]`;
}

async function executeSubAgent(opts: RunSubAgentOptions, triage: ReturnType<typeof triageSubAgentModel>): Promise<string> {
  const ctx = truncateContext(opts.context);

  let rawPrompt = 'You are a focused sub-agent. Complete the assigned task concisely and accurately.';
  if (opts.agentName) {
    try {
      const agentRow = getDb().prepare(
        `SELECT system_prompt FROM agents WHERE lower(name) = lower(?) AND status = 'active' LIMIT 1`,
      ).get(opts.agentName) as { system_prompt: string | null } | undefined;
      rawPrompt = agentRow?.system_prompt
        ?? `You are a specialized sub-agent named ${opts.agentName}. Complete the assigned task concisely and accurately.`;
    } catch {
      rawPrompt = `You are a specialized sub-agent named ${opts.agentName}. Complete the assigned task concisely and accurately.`;
    }
  }

  const systemPrompt = sanitizeSystemPromptForSubAgent(rawPrompt, opts.allowedToolOverrides);

  const primaryRoute: SubAgentRoute = { provider: triage.provider, model: triage.model, family: triage.family };
  const fallbacks = PROVIDER_FALLBACK_MAP[triage.family] ?? [];
  const routes = [primaryRoute, ...fallbacks].filter(r => !isQuotaExhausted(r.family));

  if (routes.length === 0) {
    throw new Error(`sub-agent-runner: all providers quota-exhausted for task (primary: ${triage.family})`);
  }

  let lastError: unknown;

  for (const route of routes) {
    try {
      logger.info('sub-agent-runner: attempting route', { family: route.family, model: route.model });
      return await runOnRoute(opts, route, ctx, systemPrompt);
    } catch (err) {
      // ANY provider error fails over to the next route, not just 429s.
      // Rationale: the native Kimi /coding endpoint returns 403 for an
      // unrecognized User-Agent, and transient 5xx/network errors are common —
      // none of those should kill the task while a healthy fallback exists.
      // Only genuine quota errors poison the 60s exhaustion cache; everything
      // else retries the family fresh on the next task.
      lastError = err;
      if (isQuotaError(err)) markQuotaExhausted(route.family);
      const nextFamily = routes[routes.indexOf(route) + 1]?.family ?? 'none';
      logger.warn('sub-agent-runner: provider fallback', {
        from:   route.family,
        to:     nextFamily,
        reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        quota:  isQuotaError(err),
      });
    }
  }

  throw new Error(`sub-agent-runner: all routes failed — last error: ${String(lastError)}`);
}

export function runSubAgentAsync(opts: RunSubAgentOptions): SubAgentHandle {
  const taskId = randomUUID();
  const triage = triageSubAgentModel(opts.task, opts.priorityOverride, opts.kind);
  const policy = opts.notifyPolicy ?? 'done_only';

  insertSubAgentTask(taskId, opts, triage.provider, triage.model);

  logHive('subtask_started', `sub-agent spawned for: ${opts.task.slice(0, 80)}`, opts.parentAgentId ?? undefined, {
    taskId, provider: triage.provider, model: triage.model, complexity: triage.complexity,
  });
  logHive('subtask_triage', `${triage.provider}/${triage.model} (${triage.complexity})`, opts.parentAgentId ?? undefined, {
    taskId, provider: triage.provider, model: triage.model, complexity: triage.complexity,
    kindOverride: opts.kind ?? null,
    codeScore: triage.codeScore,
    proseScore: triage.proseScore,
  });

  // Fire-and-forget — never awaited by caller
  (async () => {
    try {
      const result = await executeSubAgent(opts, triage);

      // Spec 2: progress-only detection — marks blocked instead of done
      const isBlocked = isProgressOnlyOutput(result);

      // When blocked, diagnose whether the task likely needed shell access so
      // the parent agent can self-correct by re-calling with allow_bash: true.
      const SHELL_TASK_RE = /\b(?:curl|wget|git\s+(?:clone|push|pull|commit|log|status)|npm|pip|gh\s+run|fetch\s+logs?|ci\s+logs?|github\s+actions?|bash|shell|execute|docker|ssh|scp)\b/i;
      const likelyNeedsBash = SHELL_TASK_RE.test(opts.task) && !opts.allowedToolOverrides?.includes('bash_run');
      const blockReason = isBlocked
        ? (likelyNeedsBash
            ? 'Task requires shell/git execution — re-call run_subtask with allow_bash: true to enable bash commands'
            : 'Sub-agent returned progress-only output — no actionable result was produced')
        : null;

      if (isBlocked) {
        logger.warn('sub-agent-runner: output classified as progress-only — marking blocked', {
          taskId,
          outputSnippet: result.replace(/\s+/g, ' ').slice(0, 120),
          provider: triage.provider,
          likelyNeedsBash,
        });
      }

      // Spec 6: finalize through detached runtime (default preserves current behavior)
      getDetachedTaskLifecycleRuntime().finalizeTaskRunByRunId({
        taskId,
        runId:  taskId,
        status: isBlocked ? 'blocked' : 'done',
        output: result,
      });

      // Write block_reason to the task row so get_subtask_result can surface it.
      if (isBlocked && blockReason) {
        try {
          getDb().prepare(
            `UPDATE tasks SET block_reason = ? WHERE id = ?`,
          ).run(blockReason, taskId);
        } catch { /* best-effort */ }
      }

      // Hive + taskEvents
      if (isBlocked) {
        logHive('subtask_blocked',
          `sub-agent blocked (progress-only): ${result.slice(0, 80)}`,
          opts.parentAgentId ?? undefined,
          { taskId, provider: triage.provider, model: triage.model, likelyNeedsBash, blockReason },
        );
        // Spec 7: honour notifyPolicy — thread it in the event payload
        if (shouldDeliverTaskUpdate({ notifyPolicy: policy }, 'terminal')) {
          taskEvents.emit('task_blocked', { taskId, partialOutput: result, provider: triage.provider, notifyPolicy: policy });
          notifyParentInbox(taskId, opts, 'blocked', blockReason ?? undefined);
        }
      } else {
        logHive('subtask_complete',
          `sub-agent done: ${result.slice(0, 120)}`,
          opts.parentAgentId ?? undefined,
          { taskId, provider: triage.provider, model: triage.model },
        );
        if (shouldDeliverTaskUpdate({ notifyPolicy: policy }, 'terminal')) {
          taskEvents.emit('task_complete', { taskId, result, provider: triage.provider, model: triage.model, notifyPolicy: policy });
          notifyParentInbox(taskId, opts, 'done');
        }
      }
    } catch (err) {
      const msg        = (err as Error).message;
      const displayMsg = translateClaudeError(err);

      getDetachedTaskLifecycleRuntime().finalizeTaskRunByRunId({
        taskId,
        runId:  taskId,
        status: 'failed',
        error:  msg,
      });

      logHive('subtask_failed', `sub-agent failed: ${displayMsg}`, opts.parentAgentId ?? undefined, { taskId, error: displayMsg });
      if (shouldDeliverTaskUpdate({ notifyPolicy: policy }, 'terminal')) {
        taskEvents.emit('task_failed', { taskId, error: displayMsg, provider: triage.provider, notifyPolicy: policy });
        notifyParentInbox(taskId, opts, 'failed', displayMsg);
      }
      logger.error('sub-agent-runner: task failed', { taskId, error: displayMsg });
    }
  })().catch(() => { /* already logged above */ });

  return { taskId, provider: triage.provider, model: triage.model };
}
