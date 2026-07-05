// The OpenAI-compatible Agents-SDK backbone. Runs ONE agent turn for a
// flagged OpenAI-compatible provider via @openai/agents, mapping the SDK's
// stream onto the internal BackendEvent contract. Pure "run a turn, stream
// events, return final text" — persistence stays in the alfred caller.
import OpenAI from 'openai';
import { Agent, run, OpenAIChatCompletionsModel, setTracingDisabled } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents-core';
import type { MetaEvent } from './alfred';
import type { ToolContext } from '../tools/context';
import { bridgeBackendEvent } from './types/backend-event';
import { mapSdkEvent, toAgentInput } from './openai-agents-events';
import { buildAgentsSdkTools } from './openai-agents-tools';
import { config } from '../config';
import { logger } from '../utils/logger';
import { classifyProviderError } from './provider-error';
import { reportProviderSuccess, reportProviderFailure, extractRetryAfterMs } from '../infra/provider-health';

// Without this the SDK tries to export OpenAI tracing spans and warns/errors
// when no OPENAI_API_KEY is set — true for every non-OpenAI provider here.
setTracingDisabled(true);

export interface RunBackboneOpts {
  client:       OpenAI; // openai v4 — cast to v6 at the model constructor (bundled inside @openai/agents-openai)
  model:        string;
  providerKey?: string;                // resolver key (e.g. 'hermes') for provider-specific tool tweaks
  systemPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  history:      any[];                 // OpenAI-format ChatCompletionMessageParam[]
  ctx:          ToolContext;
  agentName:    string;
  // Provider-specific request params spread into the chat.completions body via
  // the SDK's modelSettings.providerData passthrough (openaiChatCompletionsModel
  // spreads `...providerData` into the request). Lets a provider opt into quirks
  // the SDK won't emit itself — e.g. Venice's `venice_parameters`. Omit for the
  // clean OpenAI-compat providers (OpenRouter) to keep their path unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerData?: Record<string, any>;
  onChunk:      (chunk: string) => void | Promise<void>;
  onMeta?:      (e: MetaEvent) => void | Promise<void>;
}

export interface RunBackboneResult {
  text:      string;
  ok:        boolean;
  error?:    string;
  toolCalls: number;
  // Real token usage from the SDK run (stream_options.include_usage). Absent if
  // the provider didn't report usage — callers fall back to estimates.
  // cachedInputTokens: provider-reported prompt-cache hits (WS1 metric) —
  // present only when the provider exposes prompt_tokens_details.cached_tokens.
  usage?:    { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}

export async function runOpenAiAgentsBackbone(opts: RunBackboneOpts): Promise<RunBackboneResult> {
  const sink = { onChunk: opts.onChunk, onMeta: opts.onMeta };
  let acc = '';
  let toolCalls = 0;
  // Give-up condition (mirrors the claude-cli plane's CLAUDE_MAX_FAILED_TOOL_CALLS):
  // count FAILED tool calls this turn and bail early with a report-back note
  // instead of letting the model grind to the maxTurns backstop. Dispatchers
  // never throw — failure means the result JSON carries a truthy `error` or
  // `ok: false`, both of which only the dispatch error envelopes emit.
  const abort = new AbortController();
  let gaveUp = false;
  let failedToolCalls = 0;
  let lastFailedTool = '';
  let lastFailure = '';
  // Inactivity watchdog: a provider that stalls mid-generation otherwise leaves
  // the turn streaming nothing forever — the run heartbeats 'thinking' and never
  // reaches a terminal state, so nothing is ever delivered. Re-armed on every SDK
  // event below; fires only on genuine silence. Distinct from gaveUp so the catch
  // can report back with the right message.
  let idleAborted = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idleMs = config.openaiAgents.streamIdleMs;
  const armIdle = () => {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!gaveUp) { idleAborted = true; abort.abort(); }
    }, idleMs);
  };
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
  // Absolute backstop ceiling (project: Jarvis long-run triage), mirroring the
  // claude plane's timeoutMs. The idle watchdog above only catches SILENCE — a
  // runaway loop that keeps streaming tokens or firing fast tools never goes idle
  // and (with maxTurns high) could run unbounded. This fires REGARDLESS of
  // activity at a generous wall-clock ceiling, so it never cuts legit long work,
  // only a genuinely immortal turn. Distinct flag from gaveUp/idleAborted so the
  // catch + bailReportBack surface the right message.
  let absAborted = false;
  let absTimer: ReturnType<typeof setTimeout> | undefined;
  const absMaxMs = config.openaiAgents.absoluteMaxMs;
  const armAbsolute = () => {
    if (absMaxMs <= 0) return;
    absTimer = setTimeout(() => {
      if (!gaveUp && !idleAborted) { absAborted = true; abort.abort(); }
    }, absMaxMs);
    if (typeof (absTimer as { unref?: () => void }).unref === 'function') (absTimer as unknown as { unref: () => void }).unref();
  };
  const clearAbsolute = () => { if (absTimer) { clearTimeout(absTimer); absTimer = undefined; } };
  const onToolResult = (name: string, result: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(result); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = parsed as any;
    if (!p.error && p.ok !== false) return;
    failedToolCalls++;
    lastFailedTool = name;
    lastFailure = String(p.error ?? '').slice(0, 600);
    const cap = config.openaiAgents.maxFailedToolCalls;
    if (!gaveUp && cap > 0 && failedToolCalls >= cap) {
      gaveUp = true;
      abort.abort();
    }
  };
  // Shared terminal path for OUR deliberate aborts (give-up / idle watchdog).
  // The SDK is inconsistent about signal aborts on streamed runs: sometimes the
  // iterator throws, sometimes the loop just ends and `.completed` resolves
  // (verified live — a give-up abort completed "successfully" with an empty
  // reply). Both the success path and the catch funnel through here so the
  // report-back note is emitted either way.
  const bailReportBack = async (): Promise<RunBackboneResult> => {
    let note: string;
    if (gaveUp) {
      logger.warn('openai-agents-backbone: gave up early after failed tool calls', {
        agent: opts.agentName, failedToolCalls, lastFailedTool, toolCalls,
      });
      note = `\n\n---\n🛑 **Stopping early to report back.**\n\n` +
        `A step kept failing — ${failedToolCalls} failed tool calls this turn` +
        (lastFailedTool ? `, most recently \`${lastFailedTool}\`` : '') +
        `. This looks like a blocker I can't clear by retrying.\n\n` +
        (lastFailure ? `**Last failure:**\n\`\`\`\n${lastFailure}\n\`\`\`\n\n` : '') +
        `Let's sort out the blocker, then tell me to continue.`;
    } else if (absAborted) {
      const maxMin = Math.round(absMaxMs / 60000);
      logger.warn('openai-agents-backbone: aborted on absolute ceiling', {
        agent: opts.agentName, absMaxMs, chars: acc.length, toolCalls,
      });
      note = `\n\n---\n🛑 **Stopping — hit the ${maxMin}-minute ceiling for one turn.**\n\n` +
        (acc.length > 0 ? `Here's what I had so far above. ` : ``) +
        `That's the absolute cap for a single uninterrupted turn — reply to have me continue from here.`;
    } else {
      logger.warn('openai-agents-backbone: aborted on stream inactivity', {
        agent: opts.agentName, idleMs, chars: acc.length, toolCalls,
      });
      note = `\n\n---\n🛑 **Stopping — the response stalled.**\n\n` +
        `The model went quiet for ${Math.round(idleMs / 1000)}s mid-reply, so I'm ` +
        `cutting the turn rather than hanging. ` +
        (acc.length > 0 ? `Here's what I had so far above. ` : ``) +
        `Tell me to continue and I'll pick it back up.`;
    }
    await opts.onChunk(note);
    await bridgeBackendEvent({ kind: 'done' }, sink);
    return { text: acc + note, ok: true, toolCalls };
  };
  // Routing breadcrumb: makes it obvious in the logs when a turn runs on the
  // Agents SDK backbone (vs the legacy chatStreamOpenAI loop).
  logger.info('openai-agents-backbone: turn start', { agent: opts.agentName, model: opts.model });
  try {
    // @openai/agents-openai bundles openai v6; top-level project uses openai v4.
    // The types are structurally incompatible but the runtime shapes are compatible
    // (same HTTP client interface). Cast through unknown to satisfy tsc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = new OpenAIChatCompletionsModel(opts.client as unknown as any, opts.model);
    const tools = await buildAgentsSdkTools(opts.ctx, opts.providerKey, onToolResult);
    const agent = new Agent({
      name:         opts.agentName || 'agent',
      instructions: opts.systemPrompt,
      model,
      tools,
      ...(opts.providerData ? { modelSettings: { providerData: opts.providerData } } : {}),
    });

    // toAgentInput returns plain {role, content} objects. Cast to AgentInputItem[]
    // — the SDK accepts these simple message shapes at runtime even though the
    // union type also includes richer variants.
    const input = toAgentInput(opts.history) as unknown as AgentInputItem[];
    // maxTurns is only a pathological-loop backstop (0/negative = unlimited —
    // the SDK treats null as no cap); the give-up condition above is the real
    // stop signal, delivered through the abort signal.
    const maxTurns = config.openaiAgents.maxTurns > 0 ? config.openaiAgents.maxTurns : null;
    const stream = await run(agent, input, { stream: true, maxTurns, signal: abort.signal });

    // Inactivity watchdog policy: the idle timer catches genuine MODEL silence
    // (stream wedged mid-reply), NOT a tool that is legitimately running long.
    // Slow generators (GPT image / video gen) emit ZERO stream events between
    // `tool_start` and `tool_done` while the tool promise resolves — which the
    // watchdog would otherwise mistake for a hang and abort (observed:
    // `aborted on stream inactivity ... chars:0, toolCalls:1`). So we SUSPEND the
    // watchdog while any tool is in flight and resume it only once the LAST one
    // returns (parallel tool batches stay covered). Tool runtime is bounded at the
    // dispatcher layer (MCP client 300s, per-tool AbortSignal timeouts), so this
    // cannot create an immortal hang; dispatchers always emit `tool_done` (they
    // return JSON error envelopes rather than throwing) so the counter reliably
    // returns to 0.
    let toolsInFlight = 0;
    armIdle();
    armAbsolute();   // wall-clock ceiling — independent of idle/tool state
    for await (const ev of stream) {
      const mapped = mapSdkEvent(ev);
      if (!mapped) { if (toolsInFlight === 0) armIdle(); continue; }
      if (mapped.kind === 'tool_start') {
        toolCalls++;
        toolsInFlight++;
        clearIdle(); // tool executing — pause the model-silence clock
      } else if (mapped.kind === 'tool_done') {
        if (toolsInFlight > 0) toolsInFlight--;
        if (toolsInFlight === 0) armIdle(); // all tools returned — resume the clock
      } else if (toolsInFlight === 0) {
        armIdle(); // model output while no tool runs — push the deadline forward
      }
      if (mapped.kind === 'text') acc += mapped.delta;
      await bridgeBackendEvent(mapped, sink);
    }
    await stream.completed;
    clearIdle();
    clearAbsolute();

    // Our deliberate aborts can land here instead of the catch — the SDK often
    // ends a signal-aborted streamed run gracefully rather than throwing.
    if (gaveUp || idleAborted || absAborted) return bailReportBack();

    // Prefer the SDK's finalOutput, but fall back to the streamed accumulation
    // if it's absent or empty (defensive — never return '' when text streamed).
    const final = (typeof stream.finalOutput === 'string' && stream.finalOutput) ? stream.finalOutput : acc;
    // 200-error-sentinel guard: some providers (e.g. VoidAI when an upstream model
    // is down) return HTTP 200 with finish_reason:"error" and the error envelope AS
    // the content — the SDK surfaces it as a normal reply. Detect it and fail the
    // turn so it isn't recorded as a successful exchange (no spend/memory pollution).
    // The legacy loop caught this via its peek buffer (alfred.ts); deterministic
    // text match here replaces it without reintroducing the peek machinery.
    if (/^\s*\[An error occurred/i.test(final)) {
      logger.warn('openai-agents-backbone: provider returned a 200 error-sentinel', { agent: opts.agentName, preview: final.trim().slice(0, 140) });
      if (opts.providerKey) {
        reportProviderFailure(opts.providerKey, { reason: 'server_error', httpStatus: null, retryable: true, shouldCompress: false, shouldFallback: true, message: final.trim().slice(0, 300) });
      }
      await bridgeBackendEvent({ kind: 'error', message: final.trim().slice(0, 300), retryable: true }, sink);
      return { text: final, ok: false, error: final.trim().slice(0, 300), toolCalls };
    }
    if (opts.providerKey) reportProviderSuccess(opts.providerKey);
    // Real token usage from the SDK run state (populated by stream_options.include_usage).
    // FRAGILE: neither path is part of the SDK's public typed surface — an SDK
    // upgrade can silently empty both, in which case `usage` is undefined and
    // alfred falls back to token ESTIMATION (no error). If dashboard usage
    // numbers suddenly look estimated, check here first.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u: any = (stream as any).state?.usage ?? (stream as any).usage;
    // Prompt-cache hits (WS1): the SDK's Usage.inputTokensDetails is an ARRAY
    // of per-request detail records ({cached_tokens: N} per LLM call in the
    // run) — sum across them. Fall back to object/raw shapes defensively.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detailEntries: Array<Record<string, any>> = Array.isArray(u?.inputTokensDetails)
      ? u.inputTokensDetails
      : (u?.inputTokensDetails ? [u.inputTokensDetails] : (u?.prompt_tokens_details ? [u.prompt_tokens_details] : []));
    const cachedRaw = detailEntries.reduce((s, d) => {
      const v = d?.cached_tokens ?? d?.cachedTokens;
      return s + (typeof v === 'number' ? v : 0);
    }, 0);
    const usage = (u && typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number')
      ? {
          inputTokens:  u.inputTokens,
          outputTokens: u.outputTokens,
          ...(cachedRaw > 0 ? { cachedInputTokens: cachedRaw } : {}),
        }
      : undefined;
    await bridgeBackendEvent({ kind: 'done' }, sink);
    logger.info('openai-agents-backbone: turn done', { agent: opts.agentName, ok: true, chars: final.length, toolCalls, usage });
    return { text: final, ok: true, toolCalls, usage };
  } catch (err) {
    clearIdle();
    clearAbsolute();
    const message = (err as Error).message ?? String(err);
    // Deliberate-abort paths (give-up after repeated tool failures, or the idle
    // watchdog). Report back as a normal completion — never an error turn.
    if (gaveUp || idleAborted || absAborted) return bailReportBack();
    // MaxTurnsExceeded backstop: the model did real (non-failing) work but blew
    // through the turn cap. Also a report-back completion, not an error — the
    // partial progress is real and the user can say "continue".
    if (/max turns \(\d+\) exceeded/i.test(message)) {
      logger.warn('openai-agents-backbone: hit maxTurns backstop', {
        agent: opts.agentName, maxTurns: config.openaiAgents.maxTurns, toolCalls,
      });
      const note = `\n\n---\n🛑 **Stopping early to report back** — I hit the ` +
        `${config.openaiAgents.maxTurns}-step limit for a single turn before finishing.\n\n` +
        `Reply to have me continue from here.`;
      await opts.onChunk(note);
      await bridgeBackendEvent({ kind: 'done' }, sink);
      return { text: acc + note, ok: true, toolCalls };
    }
    logger.error('openai-agents-backbone: turn failed', { agent: opts.agentName, message, toolCalls });
    // Genuine provider failure (give-up/idle/maxTurns all returned above) —
    // feed the health layer so the next turn demotes this provider.
    if (opts.providerKey) {
      reportProviderFailure(opts.providerKey, classifyProviderError(err), extractRetryAfterMs(err));
    }
    // Emit a terminal error event (bridged to onMeta). Never throw mid-stream.
    await bridgeBackendEvent({ kind: 'error', message, retryable: false }, sink);
    return { text: acc, ok: false, error: message, toolCalls };
  }
}
