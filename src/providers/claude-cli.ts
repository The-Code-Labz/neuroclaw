import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { createNeuroclawMcpServer } from '../mcp/neuroclaw-mcp-server';
import { getComposioMcp, parseAgentToolkits } from '../composio/client';
import { config as appConfig } from '../config';
import { getAgentById } from '../db';
import { buildAgentScopedEnv } from '../broker/subprocessSecrets';
import { createStreamScrubber, scrubOutput } from '../broker/scrubber';
import { recordGiveUp } from '../system/give-up-telemetry';

function resolveCliBinary(): string | undefined {
  const cmd = config.claude.cliCommand;
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;

  const which = spawnSync('which', [cmd], { encoding: 'utf-8' });
  const found = which.stdout?.trim();
  if (found) return found;

  // Fall back to known install locations — useful when the parent process
  // was started without ~/.local/bin in PATH.
  const home = process.env.HOME ?? '';
  const candidates = [
    home && path.join(home, '.local/bin', cmd),
    home && path.join(home, '.claude/local', cmd),
    `/usr/local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export interface ClaudeCliUsage {
  input_tokens?:  number;
  output_tokens?: number;
  total_cost_usd?: number;
}

export interface ClaudeCliOptions {
  prompt:        string;
  systemPrompt?: string;
  cwd?:          string;
  sessionId?:    string;
  model?:        string;
  /**
   * Maximum agentic turns. Omit or pass `null`/`undefined` for no cap (unlimited).
   * Pass an explicit number to enforce a specific ceiling.
   */
  maxTurns?:     number | null;
  /**
   * When true, the bundled Claude binary's built-in tools (Bash/Read/Write/Edit/
   * Grep/Glob) are enabled for this call. Defaults to false (text-only).
   */
  execEnabled?:  boolean;
  /**
   * The agent's id, threaded through to the in-process NeuroClaw MCP server
   * so its tool handlers know which agent is calling them.
   */
  agentId?:      string | null;
  /**
   * The active run id, threaded through to the in-process NeuroClaw MCP server
   * so tool-call traces attach to their run in the Traces view.
   */
  runId?:        string | null;
  /**
   * When true, skip mounting all MCP servers (NeuroClaw in-process, Composio,
   * and user-registered HTTP servers). Use for lightweight sub-agent calls
   * where 230+ tool definitions would overflow the API request or trigger
   * invalid_request on smaller models like Haiku.
   */
  noMcp?:        boolean;
  /**
   * Called once when the stream's terminal `result` message is observed.
   * Carries real usage and cost from the Agent SDK.
   */
  onUsage?:      (usage: ClaudeCliUsage) => void;
  /**
   * When set, point the SDK at an Anthropic-compatible gateway/endpoint (LiteLLM,
   * or a provider's own native endpoint like Kimi/MiniMax) instead of subscription
   * OAuth — lets the same loop drive any model. Sets ANTHROPIC_BASE_URL +
   * ANTHROPIC_API_KEY from this target and suppresses the Claude Code params some
   * upstreams reject. The caller resolves which target from the agent's provider.
   */
  gateway?:      { baseURL: string; apiKey: string };
}

export class ClaudeCliRateLimitError extends Error {
  constructor(message = 'Claude CLI returned 429 (rate limit)') {
    super(message);
    this.name = 'ClaudeCliRateLimitError';
  }
}

export class ClaudeCliAuthError extends Error {
  constructor(message = 'Claude CLI authentication failed') {
    super(message);
    this.name = 'ClaudeCliAuthError';
  }
}

// ── Env scrubbing ─────────────────────────────────────────────────────────────

function buildChildEnv(): Record<string, string | undefined> {
  // Strip ANTHROPIC_API_KEY so the bundled CLI uses subscription OAuth.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // Long-running MCP tools (browser-based image generation: grok_web,
  // gemini_web, gpt_image) exceed the Claude Code SDK's default 60s MCP tool
  // timeout → "MCP error -32001: Request timed out" while the sidecar finishes
  // fine server-side. These sidecars run ~304s (measured), so 300s was a dead
  // heat that cut them off; 420s gives headroom above the tool's ceiling.
  //
  // Internal agent-to-agent messages (message_agent / assign_task_to_agent) are
  // a DIFFERENT beast: the recipient can run a full build+test turn that legit
  // takes many minutes, and cutting the caller off at 420s just orphans the work
  // (it keeps running; we lose the reply and have to poll). So the TOTAL ceiling
  // is raised to 30min — long enough for a real agent turn to complete. The idle
  // ceiling below is kept tight (hang-detection for genuinely-silent tools);
  // agent tools stay alive under it via the heartbeat in claude-sdk.ts, which
  // emits MCP progress every ~20s to reset the idle timer while the peer works.
  if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = '1800000';
  if (!env.MCP_TIMEOUT)      env.MCP_TIMEOUT      = '120000';
  // THE binding one for silent long tools: Claude Code (2.1.x) aborts an MCP
  // tool that emits NO output for CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT ms (default
  // 300s), SEPARATE from the total above. grok/gemini/chatgpt image gen streams
  // nothing for ~304s, so the idle timer — not the total — killed every call at
  // exactly 300s. Kept at 420s so a truly-hung non-agent tool still gets caught;
  // agent-comms tools defeat it cooperatively via the progress heartbeat.
  if (!env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT) env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = '420000';
  return env;
}

// Overlay the LiteLLM-gateway env onto the SDK child env. Points the bundled
// CLI at the gateway's /v1/messages with x-api-key auth, and disables the
// Claude Code features (extended-thinking effort, context-management/compaction)
// that emit params some gateway upstreams (e.g. OpenRouter) reject. Validated in
// scripts/claude-gateway-spike.ts.
function applyGatewayEnv(env: Record<string, string | undefined>, target: { baseURL: string; apiKey: string }): Record<string, string | undefined> {
  const { baseURL, apiKey } = target;
  return {
    ...env,
    ANTHROPIC_BASE_URL:                       baseURL,
    ANTHROPIC_API_KEY:                        apiKey,
    ANTHROPIC_AUTH_TOKEN:                     apiKey,
    MAX_THINKING_TOKENS:                      '0',
    DISABLE_AUTOCOMPACT:                      '1',
    DISABLE_MICROCOMPACT:                     '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Stream a single Claude completion through the local Claude CLI / Agent SDK.
 * Yields text chunks. Tool execution is owned by the caller, so we disable
 * built-in tools and pass a custom system prompt.
 */
export async function* streamClaudeCliChat(
  opts: ClaudeCliOptions,
): AsyncGenerator<string, void, void> {
  yield* runQuery(opts);
}

async function* runQuery(opts: ClaudeCliOptions): AsyncGenerator<string, void, void> {
  const abort = new AbortController();
  // Diagnostic instrumentation (claude-cli-abort-probe): the Agent SDK reports
  // every abort — our 900s timer, an internal SDK abort, or the subprocess
  // dying — as the same opaque "aborted by user". To tell those apart we track
  // elapsed time, whether OUR timer fired, and a scrubbed tail of the
  // subprocess's stderr (where MCP-connect failures and boot errors surface).
  const startedAt = Date.now();
  let timedOut = false;
  // ABSOLUTE backstop (project: Jarvis long-run triage): fires REGARDLESS of
  // activity at config.claude.timeoutMs. The liveness-gated idle watchdog below
  // (idleAbortMs + no tool in flight) is the primary stop for wedged turns; this
  // only catches a turn still ACTIVE past the ceiling (runaway) or a tool hung
  // with no give-up trigger. Raised in prod well above the old 900s so legit
  // long Forge builds aren't guillotined while genuinely working.
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, config.claude.timeoutMs);

  // Give-up condition — bail early and report back instead of grinding to the
  // hard timeout. Two triggers: (1) the model re-runs the SAME tool call
  // maxRepeatedToolCalls times (a non-converging retry loop, e.g. a failing
  // `docker compose run`), (2) an optional soft wall-clock budget. On either, we
  // abort the SDK and the catch path yields a bail message (not an error) so the
  // user gets the agent's progress + the blocker and can discuss before retrying.
  let gaveUp = false;
  let gaveUpKind: 'failures' | 'repeat' | 'soft-timeout' | 'idle' | null = null;
  let gaveUpCmd = '';
  let gaveUpCount = 0;
  let lastToolResult = '';                       // scrubbed tail of the most recent tool result
  let failedToolCalls = 0;                        // CUMULATIVE is_error count this turn (reporting only)
  let recoverableReadErrors = 0;                  // self-correcting "read-before-write" hits (observability)
  let failStreak = 0;                             // CONSECUTIVE failure streak — resets on any clean result; drives the give-up bail
  const toolSigCounts  = new Map<string, number>();
  const toolUseIdCmd   = new Map<string, string>(); // tool_use_id → command, to name a failing step
  const softTimer = config.claude.softTimeoutMs > 0
    ? setTimeout(() => { if (!gaveUp) { gaveUp = true; gaveUpKind = 'soft-timeout'; abort.abort(); } }, config.claude.softTimeoutMs)
    : null;

  // Stall watchdog: if no SDK message arrives for STALL_WARN_MS, log a warning
  // naming the in-flight tool — so we see a hang the moment it happens instead
  // of waiting the full timeout. Fires at most once per distinct stall.
  const STALL_WARN_MS = 120_000;
  let warnedThisStall = false;

  // Scrubbed ring buffer of recent subprocess stderr, capped so a chatty
  // process can't grow it unbounded. Logged only on the failure path.
  const STDERR_CAP = 8192;
  const stderrBuf: string[] = [];
  let stderrBytes = 0;
  let scrubSecrets: Record<string, string> = {};
  const captureStderr = (data: string) => {
    if (!data) return;
    stderrBuf.push(data);
    stderrBytes += data.length;
    while (stderrBytes > STDERR_CAP && stderrBuf.length > 1) {
      stderrBytes -= stderrBuf.shift()!.length;
    }
  };
  const stderrTail = (): string =>
    scrubOutput(stderrBuf.join('').slice(-STDERR_CAP), scrubSecrets).scrubbed.trim();

  // Activity tracking — distinguishes a HUNG turn (no SDK messages for minutes,
  // usually a tool call that never returns) from a RUNAWAY loop (messages keep
  // flowing, turns never converge). lastTool names the suspected culprit when
  // the stall happens right after a tool call with no result coming back.
  let lastMsgAt = startedAt;
  let msgCount = 0;
  let assistantCount = 0;
  let toolUseCount = 0;
  let lastTool: string | null = null;       // most recent tool the model invoked
  let lastToolAt = 0;                        // when that tool_use was emitted
  let pendingTool: string | null = null;     // tool_use seen but no result yet
  let pendingToolInput: string | null = null; // scrubbed preview of the stuck call's args
  const trackActivity = (msg: SDKMessage) => {
    lastMsgAt = Date.now();
    warnedThisStall = false;   // activity resumed — re-arm the stall warning
    msgCount++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = msg;
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      assistantCount++;
      for (const block of m.message.content) {
        if (block?.type === 'tool_use') {
          toolUseCount++;
          lastTool = String(block.name ?? '(unnamed)');
          lastToolAt = lastMsgAt;
          pendingTool = lastTool;
          // Scrubbed, truncated preview of the call's args — for Bash this is
          // the command string, naming exactly what stalled the turn.
          let rawInput = '';
          try {
            rawInput = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {});
            pendingToolInput = scrubOutput(rawInput.slice(0, 400), scrubSecrets).scrubbed;
          } catch { pendingToolInput = null; }
          // Give-up: count repeats of the SAME tool call. Signature = tool name +
          // its command (Bash) or args, whitespace-collapsed so trivial diffs
          // still match. The expensive failing step (e.g. `docker compose run`)
          // is byte-identical each loop, so it trips reliably.
          const cmd = (block.input && typeof block.input === 'object' && typeof block.input.command === 'string')
            ? block.input.command
            : rawInput;
          if (block.id) toolUseIdCmd.set(String(block.id), cmd);
          const sig = `${lastTool}:${cmd}`.replace(/\s+/g, ' ').trim().slice(0, 300);
          const n = (toolSigCounts.get(sig) ?? 0) + 1;
          toolSigCounts.set(sig, n);
          if (!gaveUp && config.claude.maxRepeatedToolCalls > 0 && n >= config.claude.maxRepeatedToolCalls) {
            gaveUp = true;
            gaveUpKind = 'repeat';
            gaveUpCount = n;
            gaveUpCmd = scrubOutput(cmd.slice(0, 300), scrubSecrets).scrubbed;
            abort.abort();
          }
        }
      }
    } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
      // The SDK feeds tool results back as a user message — clear the pending
      // marker so a tool that DID return isn't blamed for the stall, and keep a
      // scrubbed tail of the latest result so a give-up bail can show WHY.
      for (const b of m.message.content) {
        if (b?.type === 'tool_result') {
          pendingTool = null;
          pendingToolInput = null;
          let txt = b.content;
          if (Array.isArray(txt)) txt = txt.map((x: { text?: string }) => x?.text ?? '').join('');
          if (typeof txt === 'string' && txt) lastToolResult = scrubOutput(txt.slice(-600), scrubSecrets).scrubbed;
          // Give-up (primary): the SDK sets is_error on a non-zero exit / tool
          // failure (verified reliable on Bash). Count them; bail once a turn has
          // failed maxFailedToolCalls times — that's "it keeps failing".
          if (b.is_error === true) {
            // SELF-CORRECTING model mistakes are NOT task blockers — the model just
            // needs to adjust and retry (Read the file again, re-emit valid JSON),
            // so they carry HALF weight toward the streak. Covers:
            //   • read-before-write / stale-read guard (Edit/Write)
            //   • malformed tool input (JSON parse / InputValidationError) — the
            //     tool never even RAN, so it can't be a real failure
            const isSelfCorrecting = typeof txt === 'string' && (
              /has not been read yet|Read it first before|has been modified since read|Read it again/i.test(txt) ||
              /could not be parsed as JSON|InputValidationError|InputValidation/i.test(txt)
            );
            failedToolCalls++;                                 // cumulative (reporting)
            if (isSelfCorrecting) recoverableReadErrors++;     // observability
            // CONSECUTIVE streak drives the bail: a real failure counts full, a
            // self-correcting mistake counts half (needs ~2x to trip). Any clean
            // result below wipes it — so only a genuine unbroken run of failures,
            // not scattered benign errors across a productive turn, gives up.
            failStreak += isSelfCorrecting ? 0.5 : 1;
            const fc = toolUseIdCmd.get(String(b.tool_use_id));
            if (fc) gaveUpCmd = scrubOutput(fc.slice(0, 300), scrubSecrets).scrubbed;
            if (!gaveUp && config.claude.maxFailedToolCalls > 0 && failStreak >= config.claude.maxFailedToolCalls) {
              gaveUp = true;
              gaveUpKind = 'failures';
              gaveUpCount = failedToolCalls;
              abort.abort();
            }
          } else {
            // A clean tool result = real progress → reset the streak. This is the
            // root-cause fix: the give-up condition means "it KEEPS failing", which
            // is a consecutive notion, not a running total across the whole turn.
            failStreak = 0;
          }
        }
      }
    }
  };
  const activitySnapshot = () => ({
    msgCount,
    assistantCount,
    toolUseCount,
    lastTool,
    pendingTool,                                // non-null ⇒ this tool never returned
    pendingToolInput,                           // the stuck call's args (e.g. the Bash command)
    idleMs:          Date.now() - lastMsgAt,    // gap since last SDK message
    sinceLastToolMs: lastToolAt ? Date.now() - lastToolAt : null,
  });
  // Liveness-gated idle abort (project: Jarvis long-run triage). PRIMARY stop
  // signal: a turn that goes genuinely SILENT — no SDK message for IDLE_ABORT_MS
  // AND no tool in flight (pendingTool === null) — is wedged, so we bail with a
  // graceful report-back (gaveUpKind='idle'). A long-running tool (Forge build,
  // slow gen) keeps pendingTool set, so this never cuts legit work; that case is
  // bounded only by the absolute backstop (timer above). The stall WARN
  // (observability, names the in-flight tool) still fires at STALL_WARN_MS,
  // independent of the abort threshold.
  const IDLE_ABORT_MS = config.claude.idleAbortMs;
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastMsgAt;
    if (!warnedThisStall && idle >= STALL_WARN_MS) {
      warnedThisStall = true;
      logger.warn('claude-cli: turn stalled', {
        agentId: opts.agentId ?? null,
        model:   opts.model,
        gateway: opts.gateway?.baseURL ?? '(subscription)',
        ...activitySnapshot(),
      });
    }
    if (!gaveUp && IDLE_ABORT_MS > 0 && pendingTool === null && idle >= IDLE_ABORT_MS) {
      gaveUp = true;
      gaveUpKind = 'idle';
      gaveUpCount = Math.round(idle / 1000);
      logger.warn('claude-cli: idle abort — no progress, no tool in flight', {
        agentId:     opts.agentId ?? null,
        model:       opts.model,
        gateway:     opts.gateway?.baseURL ?? '(subscription)',
        idleAbortMs: IDLE_ABORT_MS,
        ...activitySnapshot(),   // includes idleMs (gap since last SDK message)
      });
      abort.abort();
    }
  }, 30_000);
  if (typeof (watchdog as { unref?: () => void }).unref === 'function') (watchdog as unknown as { unref: () => void }).unref();

  try {
    const cliPath = resolveCliBinary();
    const tools: string[] = opts.execEnabled
      ? ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob']
      : [];
    // In-process NeuroClaw MCP server so Claude-CLI agents can call our
    // memory / vault / agent-comms / spawn tools natively. MCP_ENABLED gates
    // this — if MCP is off, the server is omitted and the agent is text-only.
    // noMcp skips all MCP mounting (used by lightweight sub-agent calls where
    // 230+ tool definitions would overflow the request or trigger invalid_request).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpServers: Record<string, any> = {};
    if (!opts.noMcp && config.mcp.enabled) {
      mcpServers.neuroclaw = createNeuroclawMcpServer({ agentId: opts.agentId ?? null, sessionId: opts.sessionId ?? null, runId: opts.runId ?? null });
    }
    // Composio: per-agent identity + optional toolkit allowlist. Both the
    // global API key AND the agent's composio_enabled flag must be set.
    if (!opts.noMcp && appConfig.composio.enabled && opts.agentId) {
      const agent = getAgentById(opts.agentId);
      if (agent?.composio_enabled && agent.composio_user_id) {
        try {
          const endpoint = await getComposioMcp(agent.composio_user_id, parseAgentToolkits(agent.composio_toolkits));
          mcpServers.composio = { type: 'http', url: endpoint.url, headers: endpoint.headers };
        } catch (err) {
          logger.warn('Composio session mint failed (claude-cli path)', { agentId: opts.agentId, err: (err as Error).message });
        }
      }
    }
    // User-managed MCP server registry — every enabled, ready row is mounted
    // directly as an `http` mcpServer so Claude can call its tools natively
    // (it'll surface them as mcp__<server>__<tool> automatically). The same
    // tools also appear synthesized in our unified registry, so the OpenAI
    // and HTTP-MCP runtimes can call them via NeuroClaw's tool dispatch.
    if (!opts.noMcp && config.mcp.enabled) {
      try {
        const { getEnabledServersWithTools } = await import('../mcp/mcp-registry');
        const { parseMcpHeaders } = await import('../db');
        for (const { row } of getEnabledServersWithTools()) {
          if (mcpServers[row.name]) continue;   // don't shadow neuroclaw/composio
          const headers = parseMcpHeaders(row.headers);
          mcpServers[row.name] = {
            type:    'http',
            url:     row.url,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          };
        }
      } catch (err) {
        logger.warn('MCP registry load failed (claude-cli path)', { err: (err as Error).message });
      }
    }
    const hasMcpServers = Object.keys(mcpServers).length > 0;
    // Pre-approve everything we deliberately offer. This process is headless —
    // there is no interactive permission prompt and no canUseTool handler, and
    // settingSources is [] (no on-disk allow rules) — so the SDK's default
    // permission mode DENIES any tool that is "available" but not in
    // allowedTools. That silently killed Bash/Write/Edit for exec_enabled
    // agents (they were offered via `tools` but never auto-approved). Approve:
    //   - mcp__<server>__*  : every mounted MCP server's tools (dashboard/composio)
    //   - the built-in tools we enabled above (Bash/Read/Write/Edit/Grep/Glob)
    const allowedToolPatterns = [
      ...Object.keys(mcpServers).map(k => `mcp__${k}__*`),
      ...tools,
    ];
    const allowedTools = allowedToolPatterns.length > 0 ? allowedToolPatterns : undefined;
    // Force browser/sidecar IMAGE-generation tools through the archiving backend
    // wrappers (mcp__neuroclaw__{gpt_image_generate,grok_image_edit,gemini_image,…})
    // rather than the raw sidecar tools. The raw tools return the image inline to the
    // model but BYPASS deliverMcpImage → they never archive to the Gallery, and their
    // local_url/path delivery channels 404 (the uploads dir isn't mounted into the
    // sidecar container). Blocking them only affects what the MODEL may call directly;
    // the wrappers reach the same sidecars via internal callTool, which is untouched.
    const disallowedTools = [
      'mcp__gpt_image__chatgpt_image_generate',
      'mcp__gpt_image__chatgpt_image_edit',
      'mcp__grok_web__grok_web_generate_image',
      'mcp__gemini_web__gemini_generate_image',
      'mcp__gemini_web__gemini_edit_image',
      'mcp__grok_image_edit__grok_image_edit',
      'mcp__grok_image_edit__grok_image_compose',
    ];
    // Inject the agent's full scoped broker secret set into the Claude Agent
    // SDK child env, and prepare a scrubber for the streamed deltas.
    const sub = await buildAgentScopedEnv(opts.agentId ?? null, 'claude-cli', buildChildEnv());
    // Gateway mode wins last so its ANTHROPIC_* overrides any broker-injected key.
    const childEnv = opts.gateway ? applyGatewayEnv(sub.env, opts.gateway) : sub.env;
    const scrubber = createStreamScrubber(sub.resolved);
    // Redact broker-resolved secrets AND the gateway key from any logged stderr.
    scrubSecrets = { ...sub.resolved, ...(opts.gateway?.apiKey ? { GATEWAY_KEY: opts.gateway.apiKey } : {}) };
    const iter = query({
      prompt: opts.prompt,
      options: {
        cwd:                       opts.cwd ?? process.cwd(),
        systemPrompt:              opts.systemPrompt,
        model:                     opts.model,
        // Only pass maxTurns when an explicit numeric cap is requested.
        // null / undefined both mean unlimited — no option sent to the SDK.
        ...(typeof opts.maxTurns === 'number' ? { maxTurns: opts.maxTurns } : {}),
        tools,
        includePartialMessages:    true,
        env:                       childEnv,
        stderr:                    captureStderr,
        abortController:           abort,
        settingSources:            [],
        ...(hasMcpServers ? { mcpServers } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
      },
    });

    for await (const msg of iter as AsyncIterable<SDKMessage>) {
      trackActivity(msg);
      const chunk = extractTextChunk(msg);
      if (chunk) {
        const safe = scrubber.push(chunk);
        if (safe) yield safe;
      }

      // Terminal result message — extract real usage + cost, and log the full
      // structured diagnostics so a non-success terminal state tells us WHY
      // (subtype / errors[] / stop_reason / permission_denials / api_error).
      if (msg.type === 'result') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = msg;
        if (opts.onUsage) {
          opts.onUsage({
            input_tokens:   m.usage?.input_tokens,
            output_tokens:  m.usage?.output_tokens,
            total_cost_usd: m.total_cost_usd,
          });
        }
        const diag = {
          agentId:           opts.agentId ?? null,
          model:             opts.model,
          gateway:           opts.gateway?.baseURL ?? '(subscription)',
          subtype:           m.subtype,
          is_error:          m.is_error,
          stop_reason:       m.stop_reason ?? null,
          api_error_status:  m.api_error_status ?? null,
          num_turns:         m.num_turns,
          duration_ms:       m.duration_ms,
          permission_denials: Array.isArray(m.permission_denials) ? m.permission_denials.length : 0,
          terminal_reason:   m.terminal_reason ?? null,
          errors:            Array.isArray(m.errors) ? m.errors.slice(0, 5) : undefined,
        };
        if (m.subtype && m.subtype !== 'success') {
          logger.warn('claude-cli: terminal result (non-success)', { ...diag, stderrTail: stderrTail(), ...activitySnapshot() });
        } else {
          logger.debug('claude-cli: terminal result', diag);
        }
      }

      const err = detectError(msg);
      if (err) throw err;
    }
    const tail = scrubber.flush();
    if (tail) yield tail;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    // Give-up path: we deliberately aborted to bail early. Don't surface an error
    // (which Discord shows as "stream closed without a response") — yield a
    // report-back message so the user gets the agent's progress + the blocker and
    // can decide whether to retry. The turn is treated as a normal completion.
    if (gaveUp) {
      logger.warn('claude-cli: gave up early', {
        agentId: opts.agentId ?? null,
        model:   opts.model,
        kind:    gaveUpKind,
        cmd:         gaveUpCmd || undefined,
        count:       gaveUpCount || undefined,
        failedToolCalls,
        failStreak,
        recoverableReadErrors,
        elapsedMs,
        ...activitySnapshot(),
      });
      // Structured telemetry → the async give-up pattern detector clusters these
      // across turns and proposes carve-outs. Fail-safe: never breaks the bail.
      recordGiveUp({
        plane:      'claude-cli',
        kind:       gaveUpKind ?? 'unknown',
        agentId:    opts.agentId ?? null,
        model:      opts.model,
        cmd:        gaveUpCmd || null,
        count:      gaveUpCount || null,
        failStreak,
        output:     lastToolResult,
      });
      const lastOut = lastToolResult.trim().slice(-600);
      const hardMin = Math.round(config.claude.timeoutMs / 60000);
      let note: string;
      if (gaveUpKind === 'failures') {
        note = `\n\n---\n🛑 **Stopping early to report back** instead of running out the ${hardMin}-minute limit.\n\n` +
          `A step kept failing — ${gaveUpCount} failed attempts this turn` + (gaveUpCmd ? `, most recently \`${gaveUpCmd}\`` : '') + `. This looks like a blocker I can't clear by retrying.\n\n` +
          (lastOut ? `**Last failure:**\n\`\`\`\n${lastOut}\n\`\`\`\n\n` : '') +
          `Let's sort out the blocker, then tell me to continue.`;
      } else if (gaveUpKind === 'repeat') {
        note = `\n\n---\n🛑 **Stopping early to report back** instead of running out the ${hardMin}-minute limit.\n\n` +
          `I kept repeating the same step with no progress — ran \`${gaveUpCmd}\` ${gaveUpCount}×.\n\n` +
          (lastOut ? `**Last output:**\n\`\`\`\n${lastOut}\n\`\`\`\n\n` : '') +
          `Let's sort out the blocker, then tell me to continue.`;
      } else if (gaveUpKind === 'idle') {
        const idleLabel = gaveUpCount >= 120 ? `${Math.round(gaveUpCount / 60)} min` : `${gaveUpCount}s`;
        note = `\n\n---\n🛑 **Stopping — the turn went quiet.**\n\n` +
          `No new output for ${idleLabel} with no tool running — that's a stall, not work in progress, so I'm cutting it rather than hanging.\n\n` +
          (lastOut ? `Where I'm at (last step output):\n\`\`\`\n${lastOut}\n\`\`\`\n\n` : '') +
          `Reply to have me continue.`;
      } else {
        note = `\n\n---\n🛑 **Stopping early to report back** — I hit the soft time budget (${Math.round(config.claude.softTimeoutMs / 60000)} min) before finishing, and didn't want to run out the hard limit with no reply.\n\n` +
          (lastOut ? `Where I'm at (last step output):\n\`\`\`\n${lastOut}\n\`\`\`\n\n` : '') +
          `Reply to have me continue.`;
      }
      yield note;
      return;
    }
    // The abort/death path. Log enough to tell apart: (a) our 900s timer firing,
    // (b) an early subprocess death (elapsed << timeout), (c) a clean SDK error.
    // stderrTail() carries the real reason (MCP-connect failure, boot error)
    // that the SDK otherwise masks as "aborted by user".
    logger.warn('claude-cli: query threw', {
      agentId:    opts.agentId ?? null,
      model:      opts.model,
      gateway:    opts.gateway?.baseURL ?? '(subscription)',
      elapsedMs,
      timedOut,                                  // true ⇒ OUR 900s timer fired
      timeoutMs:  config.claude.timeoutMs,
      rawError:   err instanceof Error ? err.message : String(err),
      stderrTail: stderrTail(),
      ...activitySnapshot(),
    });
    throw err;
  } finally {
    clearTimeout(timer);
    if (softTimer) clearTimeout(softTimer);
    clearInterval(watchdog);
    // Abort the underlying SDK process immediately (no-op if already finished).
    // Without this, a caller that `break`s the for-await loop leaves the abort
    // timer running for the full timeoutMs before the subprocess is cancelled.
    abort.abort();
  }
}

function extractTextChunk(msg: SDKMessage): string | null {
  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      return ev.delta.text;
    }
  }
  return null;
}

function detectError(msg: SDKMessage): Error | null {
  if (msg.type === 'assistant' && msg.error) {
    if (msg.error === 'rate_limit')           return new ClaudeCliRateLimitError();
    if (msg.error === 'authentication_failed') return new ClaudeCliAuthError();
    return new Error(`Claude CLI error: ${msg.error}`);
  }
  if (msg.type === 'result' && msg.subtype && msg.subtype !== 'success') {
    return new Error(`Claude CLI ended with subtype=${msg.subtype}`);
  }
  return null;
}

// ── Subprocess fallback ───────────────────────────────────────────────────────
// Used by the diagnostics command and as a sanity probe.

export interface CliProbeResult {
  ok:         boolean;
  binaryPath: string | null;
  version:    string | null;
  error:      string | null;
}

export async function probeClaudeCli(): Promise<CliProbeResult> {
  return new Promise(resolve => {
    const cmd = resolveCliBinary() ?? config.claude.cliCommand;
    const child = spawn(cmd, ['--version'], { env: buildChildEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      resolve({ ok: false, binaryPath: null, version: null, error: err.message });
    });
    child.on('close', code => {
      if (code === 0) {
        resolve({ ok: true, binaryPath: cmd, version: stdout.trim(), error: null });
      } else {
        resolve({ ok: false, binaryPath: cmd, version: null, error: stderr.trim() || `exit ${code}` });
      }
    });
  });
}

export function fetchClaudeCliModels(): string[] {
  const cmd = resolveCliBinary() ?? config.claude.cliCommand;
  const result = spawnSync(cmd, ['--print', '/model'], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: buildChildEnv(),
  });
  if (result.error || result.status !== 0) return [];
  const text = (result.stdout ?? '').trim();
  // Extract all claude model IDs from the output text
  const matches = text.match(/claude-[a-z]+-\d[\w.-]*/gi) ?? [];
  return [...new Set(matches)];
}

export function logClaudeCliInfo(): void {
  logger.info('Claude backend: claude-cli', {
    cliCommand: config.claude.cliCommand,
    maxTurns:   'unlimited',
    timeoutMs:  config.claude.timeoutMs,
  });
}
