import dotenv from 'dotenv';
dotenv.config();

// Getters so live dotenv reloads (from config-watcher) propagate immediately
export const config = {
  get voidai() {
    return {
      apiKey:  process.env.VOIDAI_API_KEY  ?? '',
      baseURL: process.env.VOIDAI_BASE_URL ?? 'https://api.voidai.app/v1',
      model:   process.env.VOIDAI_MODEL    ?? 'gpt-5.1',
      // Optional override model for the task decomposer. Falls back to `model`
      // when unset. Useful for routing decomposition to a cheaper / faster model
      // than the main chat completion model.
      bgApiKey:         process.env.VOIDAI_BG_API_KEY?.trim()   || process.env.VOIDAI_API_KEY?.trim()   || '',
      skillForgeApiKey: process.env.SKILL_FORGE_API_KEY?.trim() || '',
      decomposerModel:  process.env.DECOMPOSER_MODEL?.trim()   || undefined,
      skillForgeModel:  process.env.SKILL_FORGE_MODEL?.trim()  || process.env.DECOMPOSER_MODEL?.trim() || 'gpt-4.1-nano',
    };
  },
  get dashboard() {
    const port = parseInt(process.env.DASHBOARD_PORT ?? '3141', 10);
    // Public-facing origin used for OAuth callbacks (Composio, GitHub Apps, etc.)
    // Precedence: explicit DASHBOARD_PUBLIC_URL → local http fallback.
    // Production deployments MUST set DASHBOARD_PUBLIC_URL or external OAuth
    // providers can't reach the callback from the public internet.
    const rawPublic = process.env.DASHBOARD_PUBLIC_URL?.trim();
    const publicUrl = (rawPublic && rawPublic.length > 0)
      ? rawPublic.replace(/\/+$/, '')
      : `http://localhost:${port}`;
    return {
      port,
      // Bind address for the HTTP listener. Defaults to loopback-only
      // (127.0.0.1) for security. Set DASHBOARD_HOST to a NetBird/VPN IP
      // (e.g. 100.x.x.x) to reach the dashboard from another device over the
      // VPN. NEVER bind 0.0.0.0 — that exposes the admin UI on the public IP.
      host: process.env.DASHBOARD_HOST?.trim() || '127.0.0.1',
      token: process.env.DASHBOARD_TOKEN ?? 'change-me',
      publicUrl,
      // Heartbeat staleness threshold for the stale-run sweeper. Runs whose
      // last_heartbeat_at exceeds this many ms get flipped to 'dropped'.
      // Lives on dashboard config because the sweeper is owned by the
      // dashboard server lifecycle (started/stopped with it).
      runStaleMs: parseInt(process.env.AGENT_RUN_STALE_MS ?? '600000', 10),
      // v3.2 dashboard chat reliability — when true (default), a client SSE
      // disconnect detaches the run rather than killing the agent loop. The
      // loop keeps running, partial output accumulates in the DB, and the user
      // can reconnect from any tab. Set false to restore the legacy
      // stopStream-on-disconnect behaviour.
      detachOnDisconnect: (process.env.DASHBOARD_CHAT_DETACH_ON_DISCONNECT ?? 'true').toLowerCase() !== 'false',
    };
  },
  get db() {
    return { path: process.env.DB_PATH ?? './neuroclaw.db' };
  },
  get routing() {
    return {
      enabled:       process.env.AUTO_DELEGATION_ENABLED === 'true',
      minConfidence: parseFloat(process.env.AUTO_DELEGATION_MIN_CONFIDENCE ?? '0.65'),
      model:         process.env.ROUTER_MODEL?.trim() || undefined,
    };
  },
  // spec: ssh-machine-connections — agent SSH capability kill-switch.
  // Fail-closed: absent env → disabled. Per-agent ssh_enabled is the second gate.
  get ssh() {
    return {
      enabled: process.env.SSH_TOOLS_ENABLED === 'true',
    };
  },
  get spawning() {
    return {
      enabled:            process.env.SPAWN_AGENTS_ENABLED === 'true',
      autoApprove:        process.env.TEMP_AGENTS_AUTO_APPROVE !== 'false',
      ttlHours:           parseInt(process.env.TEMP_AGENT_TTL_HOURS ?? '6', 10),
      idleTimeoutMinutes: parseInt(process.env.TEMP_AGENT_IDLE_TIMEOUT_MINUTES ?? '30', 10),
      softLimit:          parseInt(process.env.TEMP_AGENT_SOFT_LIMIT ?? '10', 10),
      hardLimit:          parseInt(process.env.TEMP_AGENT_HARD_LIMIT ?? '25', 10),
    };
  },
  get langfuse() {
    return {
      secretKey: process.env.LANGFUSE_SECRET_KEY?.trim() ?? '',
      publicKey:  process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? '',
      host:       process.env.LANGFUSE_HOST?.trim() || 'https://cloud.langfuse.com',
      enabled:    !!(process.env.LANGFUSE_SECRET_KEY?.trim() && process.env.LANGFUSE_PUBLIC_KEY?.trim()),
    };
  },
  get anthropic() {
    return {
      apiKey:  process.env.ANTHROPIC_API_KEY?.trim() ?? '',
      enabled: !!(process.env.ANTHROPIC_API_KEY?.trim()),
    };
  },
  get openai() {
    return {
      apiKey:  process.env.OPENAI_API_KEY?.trim() ?? '',
      enabled: !!(process.env.OPENAI_API_KEY?.trim()),
    };
  },
  get mcp() {
    return {
      enabled:               process.env.MCP_ENABLED === 'true',
      neurovaultUrl:         process.env.NEUROVAULT_MCP_URL?.trim() ?? '',
      neurovaultDefaultVault:process.env.NEUROVAULT_DEFAULT_VAULT?.trim() || 'neuroclaw',
      // Wall-clock cap (ms) on a single agent__<name> MCP delegation call. The
      // MCP client's own 300s ceiling covers slow image gen, but when an agent
      // delegates to another agent mid-turn a wedged server would otherwise
      // freeze the PARENT agent's tool loop for the full 5 min. 120s lets a
      // genuinely slow delegate finish while bailing cleanly on a hang.
      agentDelegationTimeoutMs: parseInt(process.env.MCP_AGENT_DELEGATION_TIMEOUT_MS ?? '120000', 10),
    };
  },
  get dream() {
    return {
      enabled:       process.env.DREAM_ENABLED === 'true',
      runTime:       process.env.DREAM_RUN_TIME?.trim() || '03:00',
      lookbackHours: parseInt(process.env.DREAM_LOOKBACK_HOURS ?? '24', 10),
      model:         process.env.DREAM_MODEL?.trim() || undefined,
    };
  },
  get background() {
    return {
      // Split-provider background routing (per user 2026-07-07):
      //  - Default tier  = VoidAI gpt-4.1-nano. Non-reasoning, cheap, on the flat
      //    VoidAI plan we already pay for, accepts temperature:0. Handles the 7
      //    "wash" bg tasks (session-namer, decomposer, dream-cycle,
      //    context-compactor, skill-forge, holdout-reviewer, doc-notebooks).
      //  - Gemini tier   = OpenRouter google/gemini-2.5-flash-lite. Used ONLY by
      //    the nuanced-inference callers that pass { preferGemini: true }
      //    (memory-extractor, user-profiler) where gemini's reasoning edge and
      //    memory-quality compounding actually matter.
      // No cross-provider fallback: each caller has one lane. `provider`/`model`
      // are kept for getBgClient()/embeddings compatibility.
      provider:    process.env.BG_PROVIDER?.trim()      || 'openrouter',
      model:       process.env.BG_MODEL?.trim()         || 'google/gemini-2.5-flash-lite',
      // Default VoidAI model for the "rest" of the background tasks.
      voidaiModel: process.env.BG_VOIDAI_MODEL?.trim()  || 'gpt-4.1-nano',
      // Gemini model for preferGemini callers (extractor, profiler).
      geminiModel: process.env.BG_GEMINI_MODEL?.trim()  || 'google/gemini-2.5-flash-lite',
    };
  },
  get skillForge() {
    return {
      provider:         process.env.SKILL_FORGE_PROVIDER?.trim()          || 'antigravity',
      antigravityModel: process.env.SKILL_FORGE_ANTIGRAVITY_MODEL?.trim() || 'antigravity/gemini-3-5-flash-low',
    };
  },
  get memory() {
    return {
      extractMinChars:         parseInt(process.env.MEMORY_EXTRACT_MIN_CHARS ?? '200', 10),
      extractModel:            process.env.MEMORY_EXTRACT_MODEL?.trim() || undefined,
      extractProvider:         process.env.MEMORY_EXTRACT_PROVIDER?.trim()          || 'antigravity',
      extractAntigravityModel: process.env.MEMORY_EXTRACT_ANTIGRAVITY_MODEL?.trim() || 'antigravity/gemini-3-5-flash-low',
      importanceThreshold: parseFloat(process.env.MEMORY_IMPORTANCE_THRESHOLD ?? '0.6'),
      perSessionMax:       parseInt(process.env.MEMORY_PER_SESSION_MAX ?? '50',  10),
      perHourMax:          parseInt(process.env.MEMORY_PER_HOUR_MAX    ?? '200', 10),
      // Auto-inject top relevant memories into the system prompt every turn
      // so all agents (every provider + backend, including Claude CLI which
      // doesn't see custom tools) get baseline memory awareness.
      preinjectEnabled:    (process.env.MEMORY_PREINJECT_ENABLED ?? 'true').toLowerCase() !== 'false',
      preinjectMax:        parseInt(process.env.MEMORY_PREINJECT_MAX ?? '5', 10),
      preinjectMinScore:   parseFloat(process.env.MEMORY_PREINJECT_MIN_SCORE ?? '0.45'),
      // Bulk-import parallelism. The importer fans out N exchanges through the
      // extractor concurrently — each in-flight worker = one outstanding LLM
      // call. Higher = faster imports until VoidAI rate-limits push back. Set
      // to 1 to restore the legacy serial behaviour.
      importConcurrency:   Math.max(1, parseInt(process.env.MEMORY_IMPORT_CONCURRENCY ?? '6', 10)),
      // Storage backend for memory_index/entities/relationships. 'sqlite' (local,
      // default) or 'supabase' (neuroclaw_kb pgvector — same schema/client as the
      // KB). Switching is the migration cutover AND the instant rollback.
      backend:             (process.env.MEMORY_BACKEND ?? 'sqlite').trim().toLowerCase() === 'supabase' ? 'supabase' as const : 'sqlite' as const,
    };
  },
  get curator() {
    return {
      enabled:           (process.env.CURATOR_ENABLED ?? 'true').toLowerCase() !== 'false',
      runTime:           process.env.CURATOR_RUN_TIME?.trim() || '02:00',
      concurrency:       Math.max(1, parseInt(process.env.CURATOR_CONCURRENCY ?? '3', 10)),
      maxSessionsPerRun: Math.max(1, parseInt(process.env.CURATOR_MAX_SESSIONS_PER_RUN ?? '100', 10)),
    };
  },
  get agentInbox() {
    return {
      enabled: (process.env.AGENT_INBOX_ENABLED ?? 'true').toLowerCase() !== 'false',
    };
  },
  get optimize() {
    return {
      // Phase 1 per-agent compression engines. Default OFF so operators opt in
      // after validation; per-agent toggles override these globals.
      engines: {
        lite:     process.env.TOKEN_OPT_LITE_ENABLED     === 'true',
        headroom: process.env.TOKEN_OPT_HEADROOM_ENABLED === 'true',
        // rtk reuses the existing global kill-switch in tokenOpt.toolCompression.
      },
      // Roll-up telemetry TTL. Buckets older than this many hours are pruned.
      telemetryTtlHours: Math.max(1, parseInt(process.env.TOKEN_OPT_TELEMETRY_TTL_HOURS ?? '168', 10)),
    };
  },
  get autonomous() {
    return {
      // Autonomous Mission Control loop (src/system/autonomous-loop.ts).
      // Default behaviour = drain the WHOLE board: maxTasks/maxMinutes of 0 mean
      // "unlimited", so the loop runs until no todo task remains. The real
      // runaway guard is the consecutive-failure streak (systemic-breakage stop),
      // not a task count. maxTasks/maxMinutes are optional caps for short runs.
      maxTasks:               Math.max(0, parseInt(process.env.AUTONOMOUS_MAX_TASKS ?? '0', 10)),
      maxMinutes:             Math.max(0, parseInt(process.env.AUTONOMOUS_MAX_MINUTES ?? '0', 10)),
      maxConsecutiveFailures: Math.max(1, parseInt(process.env.AUTONOMOUS_MAX_CONSECUTIVE_FAILURES ?? '3', 10)),
      perTaskTimeoutMs:       Math.max(60_000, parseInt(process.env.AUTONOMOUS_PER_TASK_TIMEOUT_MS ?? '1200000', 10)),
      // Stale guard: skip todo tasks created more than N days ago. 0 = no limit.
      maxTaskAgeDays:         Math.max(0, parseInt(process.env.AUTONOMOUS_MAX_TASK_AGE_DAYS ?? '0', 10)),
      defaultAgentName:       process.env.AUTONOMOUS_DEFAULT_AGENT?.trim() || 'Alfred',
    };
  },
  get cleanup() {
    return {
      commsMinHours:    parseInt(process.env.CLEANUP_COMMS_MIN_HOURS ?? '24', 10),
      hardCapHours:     parseInt(process.env.CLEANUP_HARD_CAP_HOURS ?? '54', 10),
      maxExtractPerRun: Math.max(0, parseInt(process.env.CLEANUP_MAX_EXTRACT_PER_RUN ?? '25', 10)),
    };
  },
  get triage() {
    return {
      llmEnabled:   (process.env.TRIAGE_LLM_ENABLED ?? 'true').toLowerCase() !== 'false',
      llmModel:     process.env.TRIAGE_LLM_MODEL?.trim() || undefined,
      borderLow:    parseFloat(process.env.TRIAGE_BORDER_LOW  ?? '0.40'),
      borderHigh:   parseFloat(process.env.TRIAGE_BORDER_HIGH ?? '0.55'),
      budgetSession: parseInt(process.env.BUDGET_SESSION_TOKENS ?? '200000', 10),
      budgetHour:    parseInt(process.env.BUDGET_HOUR_TOKENS    ?? '1000000', 10),
    };
  },
  get review() {
    const parseList = (v: string | undefined, def: string[]): string[] =>
      (v?.trim() ? v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : def);
    return {
      // Legacy merge-loop (dormant; kept for the flagged consumer / holdout path).
      loopEnabled:   (process.env.REVIEW_LOOP_ENABLED ?? 'false').toLowerCase() === 'true',
      councilUrl:    process.env.REVIEWER_COUNCIL_URL?.trim() || 'http://127.0.0.1:7102/mcp',
      maxIterations: parseInt(process.env.REVIEW_LOOP_MAX_ITERATIONS ?? '3', 10),

      // In-process tiered review service (pre-gate → Tier-1 → Tier-2).
      enabled:            (process.env.REVIEW_ENABLED ?? 'true').toLowerCase() !== 'false',
      // Default to MiniMax-M3 (native lane, off the flaky VoidAI proxy path) — override
      // back to a VoidAI model id via env if needed; runTier1 detects the lane by prefix.
      tier1CodeModel:     process.env.REVIEW_T1_CODE_MODEL?.trim()  || 'MiniMax-M3',
      tier1NonCodeModel:  process.env.REVIEW_T1_PROSE_MODEL?.trim() || 'MiniMax-M3',
      // Primary rides the OpenRouter lane (preferGemini) → needs the provider-prefixed
      // slug (bare 'claude-sonnet-4-6' 400s there). Fallback rides the VoidAI lane →
      // needs a VoidAI-valid id ('kimi-for-coding' 404s there). Both are Sonnet 4.6 on
      // uncorrelated windows (OpenRouter vs VoidAI flat plan); neither is a reasoning
      // model, so temperature:0.1 is accepted.
      tier2Model:         process.env.REVIEW_T2_MODEL?.trim()       || 'anthropic/claude-sonnet-4.6',
      tier2Fallback:      process.env.REVIEW_T2_FALLBACK?.trim()    || 'claude-sonnet-4-6',
      tier2MaxConcurrent: parseInt(process.env.REVIEW_T2_MAX_CONCURRENT ?? '2', 10),
      tier1MaxDiffLines:  parseInt(process.env.REVIEW_T1_MAX_DIFF_LINES ?? '400', 10),
      tierTimeoutMs:      parseInt(process.env.REVIEW_TIER_TIMEOUT_MS ?? '45000', 10),
      riskyGlobs:         parseList(process.env.REVIEW_RISKY_GLOBS,
        ['auth', 'payment', 'migration', 'config.ts', 'registry.ts', 'routes.ts', '.sql', '.env']),
      trivialTaskTypes:   parseList(process.env.REVIEW_TRIVIAL_TYPES,
        ['session_name', 'tagging', 'naming']),
    };
  },
  get loop() {
    // Loop Engineering — adversarial build → verify → loop-until-gate.
    // All bounds are enforced together: whichever trips first ends the loop.
    return {
      enabled:           (process.env.LOOP_ENABLED ?? 'true').toLowerCase() !== 'false',
      maxRounds:         parseInt(process.env.LOOP_MAX_ROUNDS ?? '4', 10),
      // Per-round wall-clock cap (build+verify each get their own timeout below).
      perRoundTimeoutMs: parseInt(process.env.LOOP_PER_ROUND_TIMEOUT_MS ?? '120000', 10),
      // Independent hard verifier timeout so a hung gate can't deadlock the loop.
      verifyTimeoutMs:   parseInt(process.env.LOOP_VERIFY_TIMEOUT_MS ?? '45000', 10),
      // Total time budget across all rounds — checked before each round.
      totalBudgetMs:     parseInt(process.env.LOOP_TOTAL_BUDGET_MS ?? '420000', 10),
      // Consecutive repeat/oscillating critiques before declaring 'stalled'.
      stallLimit:        parseInt(process.env.LOOP_STALL_LIMIT ?? '2', 10),
      // Estimated-token cost gate — projected spend checked BEFORE each round.
      maxTotalTokens:    parseInt(process.env.LOOP_MAX_TOTAL_TOKENS ?? '120000', 10),
      // Builder model (MiniMax-M3 native lane by default; VoidAI id overrides).
      builderModel:      process.env.LOOP_BUILDER_MODEL?.trim() || 'MiniMax-M3',
    };
  },
  get selfHeal() {
    // Master shadow / panic switch. When true it forces BOTH action mechanisms
    // inert, preserving the observe/learn-only posture. When false, two
    // independent sub-gates control the action surface.
    const shadow = (process.env.SELF_HEAL_SHADOW ?? 'true').toLowerCase() !== 'false';
    return {
      // Master switch. When false, no failure observation, no learning, no repair.
      enabled:      (process.env.SELF_HEAL_ENABLED ?? 'true').toLowerCase() !== 'false',
      // SHADOW-MODE default ON: observe + build failure-memory + LOG would-repair
      // decisions, but never actually inject a stored fix or trip a live repair.
      shadowMode:   shadow,
      // Learn stage (Verify-gated). Off ⇒ observe-only, never persists verified fixes.
      learnEnabled: (process.env.SELF_HEAL_LEARN ?? 'true').toLowerCase() !== 'false',
      // Run-level signature-storm breaker: same signature this many times in one
      // autonomous run ⇒ stop repairing it, escalate once, suppress the rest.
      // Default ON when out of shadow; flip SELF_HEAL_STORM_BREAKER=false to disable.
      stormBreakerActive: shadow
        ? false
        : (process.env.SELF_HEAL_STORM_BREAKER ?? 'true').toLowerCase() !== 'false',
      // Verified-fix injection: folds a trusted stored fix into the critique fed
      // back to the agent. Default OFF even out of shadow; must be explicitly
      // armed with SELF_HEAL_FIX_INJECTION=true after human review of candidates.
      fixInjectionActive: shadow
        ? false
        : (process.env.SELF_HEAL_FIX_INJECTION ?? 'false').toLowerCase() === 'true',
      // Per-task bounded repair attempts before escalate. Matches task max_retries intent.
      maxRepairAttempts: parseInt(process.env.SELF_HEAL_MAX_REPAIR ?? '2', 10),
      stormThreshold:    parseInt(process.env.SELF_HEAL_STORM_THRESHOLD ?? '3', 10),
      // rate_limited is a windowed transient the tool boundary already spaced-
      // retried (Retry-After aware). Gate it behind a HIGHER count than the
      // permanent-blocker threshold so a busy-upstream burst doesn't trip the
      // systemic-blocker suppression. Never below stormThreshold.
      rateLimitStormThreshold: Math.max(
        parseInt(process.env.SELF_HEAL_STORM_THRESHOLD ?? '3', 10),
        parseInt(process.env.SELF_HEAL_RATE_LIMIT_STORM_THRESHOLD ?? '8', 10),
      ),
      // Confidence gate: a stored fix is blind-trusted only at/above this hit-count
      // with a clean verify record AND with verify passes from at least this many
      // distinct sessions. Below the bar the fix is fed as a PRIOR, not injected.
      trustHitCount:     parseInt(process.env.SELF_HEAL_TRUST_HITS ?? '2', 10),
      // Phases permanently excluded from Learn (noise / footgun automation).
      // vcs = git-state artifacts; infra = host/liveness timing coincidences.
      neverLearnPhases:  (process.env.SELF_HEAL_NEVER_LEARN ?? 'vcs')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    };
  },
  get compaction() {
    const contextWindow = parseInt(process.env.COMPACT_CONTEXT_WINDOW ?? '200000', 10);
    return {
      enabled:              (process.env.COMPACT_ENABLED ?? 'true').toLowerCase() !== 'false',
      /** Total token budget for this model / backend (default 200k for GPT-5.1 / o3). */
      contextWindow,
      /** Compaction triggers when estimated tokens exceed contextWindow * triggerRatio. */
      triggerRatio:         parseFloat(process.env.COMPACT_TRIGGER_RATIO ?? '0.70'),
      /** After compaction we aim for contextWindow * targetRatio tokens remaining. */
      targetRatio:          parseFloat(process.env.COMPACT_TARGET_RATIO ?? '0.75'),
      /** Hard floor — never keep fewer than this many recent turns regardless of ratios. */
      keepRecentMin:        parseInt(process.env.COMPACT_KEEP_RECENT_MIN ?? '4', 10),
      /** Hard ceiling — never compact more than this many turns in one pass. */
      maxCompactTurns:      parseInt(process.env.COMPACT_MAX_TURNS ?? '60', 10),
      /** Legacy absolute threshold (fallback when contextWindow is 0). */
      tokenThreshold:       parseInt(process.env.COMPACT_TOKEN_THRESHOLD ?? '100000', 10),
      /** Legacy absolute turn threshold (fallback when contextWindow is 0). */
      turnThreshold:        parseInt(process.env.COMPACT_TURN_THRESHOLD  ?? '30',   10),
      /** Deprecated: replaced by keepRecentMin. Kept for backwards compat. */
      keepRecent:           parseInt(process.env.COMPACT_KEEP_RECENT     ?? '6',    10),
      reinjectMemories:     parseInt(process.env.COMPACT_REINJECT_MEMORIES ?? '3',  10),
      model:                process.env.COMPACT_MODEL?.trim() || undefined,
      extractWorkingState:  (process.env.COMPACT_EXTRACT_WORKING_STATE ?? 'true').toLowerCase() !== 'false',
    };
  },
  get heartbeat() {
    return {
      enabled:     (process.env.HEARTBEAT_ENABLED ?? 'true').toLowerCase() !== 'false',
      intervalSec: parseInt(process.env.HEARTBEAT_INTERVAL_SEC ?? '60', 10),
      // Heartbeat model override. When unset, pickCheapModel() selects the
      // first available model from PREFERRED_VOIDAI (catalog-aware). Set
      // HEARTBEAT_MODEL to pin a specific model (e.g. gpt-4o-mini).
      model:       process.env.HEARTBEAT_MODEL?.trim() || undefined,
      // Skip Claude CLI agents — pinging would burn subscription quota every interval.
      skipClaudeCli: (process.env.HEARTBEAT_SKIP_CLAUDE_CLI ?? 'true').toLowerCase() !== 'false',
      // Route OpenRouter-provider heartbeats through the VoidAI (OpenAI-compatible)
      // client instead of OpenRouter. Useful when OpenRouter is flaky for pings.
      openrouterViaVoidai: (process.env.HEARTBEAT_OPENROUTER_VIA_VOIDAI ?? 'false').toLowerCase() === 'true',
      // If true, ALL heartbeat pings route through the custom heartbeat Ollama
      // provider instead of per-provider routing. Overrides HEARTBEAT_MODEL.
      useOllamaProvider: (process.env.HEARTBEAT_USE_OLLAMA_PROVIDER ?? 'false').toLowerCase() === 'true',
    };
  },
  get heartbeatOllama() {
    return {
      apiKey:  process.env.HEARTBEAT_OLLAMA_API_KEY?.trim() ?? '',
      baseURL: process.env.HEARTBEAT_OLLAMA_BASE_URL?.trim() || 'https://ollama.internal.neurolearninglabs.com/v1',
      model:   process.env.HEARTBEAT_OLLAMA_MODEL?.trim()   || 'llama3.2',
      enabled: (process.env.HEARTBEAT_USE_OLLAMA_PROVIDER ?? 'false').toLowerCase() === 'true',
    };
  },
  get exec() {
    const denyRaw = (process.env.EXEC_BASH_DENY ?? '').trim();
    const denyDefaults = [
      'rm -rf /',
      'rm -rf /*',
      'rm -rf ~',
      'rm -rf $HOME',
      ':(){',                         // fork bomb prefix
      'mkfs',
      'dd if=/dev/zero of=/dev/',
      'dd if=/dev/random of=/dev/',
      '> /dev/sda',
      'shutdown',
      'reboot',
      'sudo rm',
      'curl | sh',
      'curl | bash',
      'wget | sh',
      'wget | bash',
    ];
    const customDeny = denyRaw ? denyRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    return {
      timeoutMs:      parseInt(process.env.EXEC_TIMEOUT_MS ?? '60000', 10),
      outputMaxBytes: parseInt(process.env.EXEC_OUTPUT_MAX_BYTES ?? '200000', 10),
      bashDeny:       [...denyDefaults, ...customDeny],
      root:           process.env.EXEC_ROOT?.trim() || '',  // empty = no fs boundary
      // Comma-separated allow-roots. The workspace root + os.tmpdir() are always
      // permitted on top of these (see checkFsBoundary).
      roots:          (process.env.EXEC_ROOT?.trim() || '')
                        .split(',').map(s => s.trim()).filter(Boolean),
      defaultCwd:     process.env.EXEC_DEFAULT_CWD?.trim() || process.cwd(),
    };
  },
  get workspace() {
    return {
      // Kill switch — false reverts exec tools to the old defaultCwd behavior.
      enabled:             (process.env.WORKSPACE_ENABLED ?? 'true').toLowerCase() !== 'false',
      root:                process.env.WORKSPACE_ROOT?.trim() || './workspaces',
      ttlHours:            parseInt(process.env.WORKSPACE_TTL_HOURS ?? '72', 10),
      sweepMaxPerRun:      parseInt(process.env.WORKSPACE_SWEEP_MAX_PER_RUN ?? '500', 10),
      // Age-based sweep of generated uploads/ media (chat, carbone_renders, docs).
      // Deliverables (agent-files), avatars, and images are never auto-deleted.
      uploadsSweepEnabled: (process.env.UPLOADS_SWEEP_ENABLED ?? 'true').toLowerCase() !== 'false',
      uploadsTtlHours:     parseInt(process.env.UPLOADS_TTL_HOURS ?? '336', 10),  // 14 days; 0 = off
    };
  },
  get uploads() {
    return {
      // Kill switch — false reverts both surfaces to ephemeral (no persistence).
      persistEnabled:  (process.env.UPLOADS_PERSIST_ENABLED ?? 'true').toLowerCase() !== 'false',
      sessionMaxBytes: parseInt(process.env.UPLOADS_SESSION_MAX_MB ?? '256', 10) * 1024 * 1024,
      perFileMaxBytes: parseInt(process.env.UPLOAD_PER_FILE_MAX_MB ?? '50', 10) * 1024 * 1024,
    };
  },
  get codex() {
    const raw = (process.env.CODEX_BACKEND ?? 'cli').trim().toLowerCase();
    // 'cli' = legacy `codex exec` (default, safe). 'app-server' = persistent
    // JSON-RPC backend with in-process NeuroClaw tools (opt-in). 'api' reserved.
    const backend: 'cli' | 'api' | 'app-server' =
      raw === 'api' ? 'api' : raw === 'app-server' ? 'app-server' : 'cli';
    return {
      backend,
      cliCommand:       process.env.CODEX_CLI_COMMAND?.trim() || 'codex',
      timeoutMs:        parseInt(process.env.CODEX_TIMEOUT_MS ?? '900000', 10),
      concurrencyLimit: parseInt(process.env.CODEX_CONCURRENCY_LIMIT ?? '1', 10),
      // Codex exec uses sandboxed shell tools by default; for our purposes the
      // safest default is read-only — agents that genuinely need to write files
      // should use Claude CLI exec or our own bash_run path.
      sandboxMode:      (process.env.CODEX_SANDBOX_MODE ?? 'read-only').trim(),
    };
  },
  get openrouter() {
    return {
      apiKey:  process.env.OPENROUTER_API_KEY?.trim() ?? '',
      baseURL: process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
      model:   process.env.OPENROUTER_MODEL?.trim() || 'anthropic/claude-sonnet-4',
      enabled: !!(process.env.OPENROUTER_API_KEY?.trim()),
    };
  },
  get venice() {
    return {
      apiKey:  process.env.VENICE_API_KEY?.trim() ?? '',
      baseURL: process.env.VENICE_BASE_URL?.trim() || 'https://api.venice.ai/api/v1',
      model:   process.env.VENICE_MODEL?.trim()   || 'zai-org-glm-5',
      enabled: !!(process.env.VENICE_API_KEY?.trim()),
    };
  },
  get abacus() {
    return {
      apiKey:  process.env.ABACUS_API_KEY?.trim() ?? '',
      baseURL: process.env.ABACUS_BASE_URL?.trim() || 'https://routellm.abacus.ai/v1',
      model:   process.env.ABACUS_MODEL?.trim()   || 'gpt-5',
      enabled: !!(process.env.ABACUS_API_KEY?.trim()),
    };
  },
  // KIE AI — async media job API (Surface B). Key resolved from the broker
  // (SHARED_KIE_API_KEY → KIE_API_KEY) at boot; never written to .env.
  get kie() {
    return {
      apiKey:      process.env.KIE_API_KEY?.trim() ?? '',
      baseURL:     process.env.KIE_BASE_URL?.trim() || 'https://api.kie.ai/api/v1',
      imageModel:  process.env.KIE_IMAGE_MODEL?.trim() || 'google/nano-banana',
      videoModel:  process.env.KIE_VIDEO_MODEL?.trim() || 'veo3_fast',
      audioModel:  process.env.KIE_AUDIO_MODEL?.trim() || 'suno/v5',
      enabled:     !!(process.env.KIE_API_KEY?.trim()),
    };
  },
  // fal — async media queue (queue.fal.run). Auth is `Key <k>`, not Bearer.
  // Key resolved from the broker (SHARED_FAL_API_KEY → FAL_API_KEY) at boot.
  get fal() {
    return {
      apiKey:      process.env.FAL_API_KEY?.trim() ?? '',
      baseURL:     process.env.FAL_BASE_URL?.trim() || 'https://queue.fal.run',
      imageModel:  process.env.FAL_IMAGE_MODEL?.trim() || 'fal-ai/flux/schnell',
      videoModel:  process.env.FAL_VIDEO_MODEL?.trim() || 'fal-ai/wan/v2.2-5b/text-to-video',
      audioModel:  process.env.FAL_AUDIO_MODEL?.trim() || 'cassetteai/music-generator',
      enabled:     !!(process.env.FAL_API_KEY?.trim()),
    };
  },
  // OpenArt — MCP-only media provider (generate + edit), OAuth 2.1 Bearer.
  // ⚠️ Auth is a ROTATING refresh token read LIVE from the broker by the token
  // manager (src/infra/openart-auth.ts) — it MUST NOT be snapshotted into
  // process.env or added to SECRET_REGISTRY, or a stale RT would nuke the token
  // family. `enabled` delegates to openartConfigured() (single source of truth,
  // primed async at boot via primeOpenArtConfigured()).
  get openart() {
    // Lazy import avoids a config↔auth module cycle at load time.
    let enabled = false;
    try { enabled = require('./infra/openart-auth').openartConfigured(); } catch { enabled = false; }
    return {
      clientId: process.env.OPENART_CLIENT_ID?.trim() || '5wUuGDLn4m9MMNwh4FJU',
      mcpUrl:   process.env.OPENART_MCP_URL?.trim()   || 'https://mcp.openart.ai/mcp',
      imageModel: process.env.OPENART_IMAGE_MODEL?.trim() || 'nano-banana-2-lite',
      enabled,
    };
  },
  get higgsfield() {
    // Lazy import avoids a config↔auth module cycle at load time.
    let enabled = false;
    try { enabled = require('./infra/higgsfield-auth').higgsfieldConfigured(); } catch { enabled = false; }
    return {
      clientId:   process.env.HIGGSFIELD_CLIENT_ID?.trim() || 'SmaNEDl8PtPUH4Cf',
      mcpUrl:     process.env.HIGGSFIELD_MCP_URL?.trim()   || 'https://mcp.higgsfield.ai/mcp',
      imageModel: process.env.HIGGSFIELD_IMAGE_MODEL?.trim() || 'nano_banana_2',
      videoModel: process.env.HIGGSFIELD_VIDEO_MODEL?.trim() || 'cinematic_studio_3_0',
      enabled,
    };
  },
  get omniroute() {
    // Self-hosted OpenAI-compatible gateway (200+ upstream providers, auto-fallback,
    // RTK/Caveman compression). Local service like Ollama: key is OPTIONAL (the
    // gateway's REQUIRE_API_KEY defaults false), so `enabled` is not key-gated —
    // an offline gateway simply fails at chat time. Disable explicitly with
    // OMNIROUTE_ENABLED=false.
    return {
      apiKey:  process.env.OMNIROUTE_API_KEY?.trim() ?? '',
      baseURL: process.env.OMNIROUTE_BASE_URL?.trim() || 'http://127.0.0.1:20128/v1',
      model:   process.env.OMNIROUTE_MODEL?.trim()    || 'auto/best-coding',
      enabled: process.env.OMNIROUTE_ENABLED?.trim() !== 'false',
    };
  },
  get pollinations() {
    return {
      apiKey:  process.env.POLLINATIONS_API_KEY?.trim() || undefined,
      baseURL: process.env.POLLINATIONS_BASE_URL?.trim() || 'https://gen.pollinations.ai',
    };
  },
  get perplexity() {
    return {
      mcpUrl:  process.env.PERPLEXITY_MCP_URL?.trim() || 'http://127.0.0.1:7205/sse',
      enabled: !!(process.env.PERPLEXITY_SESSION_TOKEN?.trim()),
    };
  },
  get veniceImage() {
    return {
      mcpUrl:  process.env.VENICE_IMAGE_MCP_URL?.trim() || 'http://127.0.0.1:7206/mcp',
      enabled: !!(process.env.VENICE_SESSION_TOKEN?.trim()),
    };
  },
  get canva() {
    const clientId       = process.env.CANVA_CLIENT_ID?.trim()          || '';
    const clientSecret   = process.env.CANVA_CLIENT_SECRET?.trim()      || '';
    const loopbackClient = process.env.CANVA_LOOPBACK_CLIENT_ID?.trim() || '';
    return {
      // Official Canva MCP (remote, Streamable HTTP) — see canva.dev/docs/mcp.
      // Not env-overridable: Canva publishes exactly one production endpoint.
      mcpUrl: 'https://mcp.canva.com/mcp',
      clientId,
      clientSecret,
      // A client_id/client_secret pair means SOME DCR client is configured —
      // does NOT guarantee it was registered against our loopback
      // redirect_uri (a stale public-host client can sit here from an
      // earlier attempt). Use loopbackReady to gate the /authorize step.
      configured: !!(clientId && clientSecret),
      // True only when clientId is the exact client that mcp/canva-oauth.ts
      // registerDcrClient() registered against CANVA_LOOPBACK_REDIRECT_URI.
      // Authorize URLs must never be built when this is false — Canva's
      // /authorize 500s on a client paired with a redirect_uri it never
      // registered. See mcp/canva-oauth.ts isLoopbackClientRegistered().
      loopbackReady: !!(clientId && loopbackClient && clientId === loopbackClient),
      hasToken: !!(process.env.CANVA_ACCESS_TOKEN?.trim()),
    };
  },
  get sonarSmart() {
    return {
      mcpUrl:  process.env.SONAR_SMART_MCP_URL?.trim() || 'http://127.0.0.1:7207/mcp',
      // Enabled when: session token present AND operator explicitly opted in.
      // Default false prevents breaking existing setups that only run perplexity-mcp.
      enabled: (process.env.SONAR_SMART_ENABLED ?? '').toLowerCase() === 'true'
               && !!(process.env.PERPLEXITY_SESSION_TOKEN?.trim()),
    };
  },
  get hermes() {
    return {
      // Local OpenAI-compatible proxy started with: hermes proxy start --provider xai
      proxyUrl: process.env.HERMES_PROXY_URL?.trim() || 'http://127.0.0.1:8645/v1',
      model:    process.env.HERMES_MODEL?.trim()     || 'grok-4.3',
    };
  },
  get openaiAgents() {
    return {
      // Comma-separated resolver.key values routed through the @openai/agents
      // backbone instead of the legacy chatStreamOpenAI loop. Empty = off.
      providers: (process.env.OPENAI_AGENTS_PROVIDERS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      // Per-model gate for the `litellm` provider only. LiteLLM is a multi-upstream
      // proxy: some models expose native OpenAI tool_calls (e.g. MiniMax-M2.7) and
      // are backbone-ready, while others (e.g. literouter/claude-* — confirmed live)
      // ignore the tools array entirely and require the legacy text-tool harness the
      // backbone can't reproduce. When `litellm` is in `providers`, only models whose
      // name CONTAINS one of these entries route to the backbone; the rest stay on the
      // legacy loop. Empty list = no litellm model routes to the backbone (safe default).
      litellmNativeModels: (process.env.OPENAI_AGENTS_LITELLM_NATIVE_MODELS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      // Hard backstop on internal LLM→tool→LLM cycles per user turn — a guard
      // against a model that loops while every tool call SUCCEEDS (the FAIL-based
      // give-up and idle watchdog can't catch that case). It must NOT double as a
      // work limiter: keep it high enough that only pathological loops hit it.
      // 50 was too low — legitimate deep turns (multi-file edits, long tool
      // chains, research) blew through it and reported back unfinished. The
      // FAIL-based give-up below is the primary stop condition for healthy turns.
      // 0 or negative = fully unlimited (SDK accepts maxTurns: null).
      maxTurns: parseInt(process.env.OPENAI_AGENTS_MAX_TURNS ?? '200', 10),
      // Give-up condition (primary), mirroring CLAUDE_MAX_FAILED_TOOL_CALLS on
      // the claude-cli plane: bail early and report back once this many tool
      // calls have FAILED this turn. 0 disables.
      maxFailedToolCalls: parseInt(process.env.OPENAI_AGENTS_MAX_FAILED_TOOL_CALLS ?? '3', 10),
      // Inactivity watchdog: abort a turn that produces NO stream event for this
      // many ms — a stalled upstream (provider hung mid-generation) otherwise
      // leaves the run heartbeating 'thinking' forever, never terminating, so
      // nothing is ever delivered ("she won't reply"). Re-armed on every SDK
      // event, so it only fires on genuine silence. 0 disables.
      streamIdleMs: parseInt(process.env.OPENAI_AGENTS_STREAM_IDLE_MS ?? '120000', 10),
      // Absolute backstop ceiling (project: Jarvis long-run triage), mirroring the
      // claude plane's timeoutMs. The streamIdleMs watchdog above only catches
      // SILENCE — a runaway loop that keeps streaming tokens or firing fast tools
      // never goes idle and (with maxTurns high) could run unbounded. This fires
      // REGARDLESS of activity at a wall-clock ceiling, so it never cuts legit
      // long work — only a genuinely immortal turn. 0 disables.
      //
      // Wave-2 Item C (ASAGI FATAL): the old default was 45 min (2700000), which
      // sat ABOVE job-worker's 25-min WEDGED_JOB_CAP_MS — so this graceful ceiling
      // was DEAD CODE for any 25–45 min run (the blunt force-fail always won
      // first). Re-derived so the ordering is now correct end-to-end:
      //   absoluteMaxMs (25m) < RUNAWAY_BUDGET_MS (30m) < WEDGED_JOB_CAP_MS (35m)
      // i.e. the backbone's own graceful bail gets first crack, THEN Sentinel's
      // targeted runaway interrupt, THEN the blunt job-worker backstop last.
      // 25m is ASAGI-verified against 746 real backbone turns: the sole legit
      // near-miss was an 18.5m Rossweisse run (33 tool calls / 1.3M input tokens);
      // 25m gives 6.5m headroom while still killing the 88m Akeno-class wedge.
      absoluteMaxMs: parseInt(process.env.OPENAI_AGENTS_ABSOLUTE_MAX_MS ?? '1500000', 10),
    };
  },
  get queue() {
    // Session-queue timeout. MUST sit ABOVE both backend ceilings (claude
    // timeoutMs / openaiAgents absoluteMaxMs) so the queue is only ever a
    // last-resort backstop and never rejects a turn the backend is still working
    // — the mismatch that orphaned long Jarvis runs at the old 600s default.
    // Auto-derives from the live backend ceilings (+2 min margin) so raising a
    // backend timeout can't silently leave the queue capping below it; an
    // explicit SESSION_QUEUE_TIMEOUT_MS overrides the derivation.
    const explicit = process.env.SESSION_QUEUE_TIMEOUT_MS;
    if (explicit && explicit.trim()) return { timeoutMs: parseInt(explicit, 10) };
    const ceiling = Math.max(this.claude.timeoutMs, this.openaiAgents.absoluteMaxMs);
    return { timeoutMs: ceiling + 120_000 };
  },
  get decomposer() {
    return {
      // Model for task decomposition. Falls back to the main voidai model when unset.
      model:          process.env.DECOMPOSER_MODEL?.trim() || undefined,
      // Token budget for the decomposition LLM call. Hard-coded 350 was too tight
      // and caused JSON truncation. 900 provides reliable headroom.
      // See specs/decomposer-json-truncation-fix.md Fix 1.
      maxTokens:      parseInt(process.env.DECOMPOSER_MAX_TOKENS ?? '900', 10),
      // Token budget for the second-chance yes/no complexity retry.
      retryMaxTokens: parseInt(process.env.DECOMPOSER_RETRY_MAX_TOKENS ?? '32', 10),
    };
  },
  get subAgent() {
    return {
      preferKimiFrontier: process.env.PREFER_KIMI_FRONTIER === 'true',
      // Parent-supplied context cap (tokens, ~4 chars/token heuristic). 2000
      // (~8KB) silently starved code tasks of the context they were handed;
      // both native sub-agent models carry large windows, so 8000 (~32KB) is
      // still cheap while fitting a real file or diff.
      contextLimitTokens: parseInt(process.env.SUB_AGENT_CONTEXT_LIMIT ?? '8000', 10),
      maxConcurrent:      parseInt(process.env.SUB_AGENT_MAX_CONCURRENT ?? '20', 10),
      // Per-provider-family ceiling on concurrent sub-agent LLM requests. The
      // global maxConcurrent caps orchestration *steps*, but fire-and-forget
      // run_subtask calls have no per-family limit — N concurrent sub-agents
      // can all hit Kimi/MiniMax at once and trip the 429s the quota cache
      // then reacts to. This bounds in-flight requests per family proactively.
      providerMaxConcurrent: parseInt(process.env.SUB_AGENT_PROVIDER_MAX_CONCURRENT ?? '6', 10),
      // Sub-agents now get the same search_tools/call_tool surface as main
      // agents (full registry + MCP research servers + skills), so they need
      // more tool turns: discovery (search_tools → get_tool_schema → call_tool)
      // costs turns before any real work. Bumped from the old hardcoded 8.
      maxToolTurns: parseInt(process.env.SUB_AGENT_MAX_TOOL_TURNS ?? '16', 10),
      // "Don't go overboard" guardrails on the broadened surface: sub-agents may
      // reach the full tool registry + MCP research tools + skills, but by
      // default may NOT delegate to other agents (agent__*) — prevents fan-out /
      // recursion — nor invoke Composio (COMPOSIO_*) external side effects. The
      // registry blockedTools list (writes/management/spawn/schedule) still
      // applies on top. Flip these to relax.
      blockAgentDelegation: process.env.SUB_AGENT_BLOCK_AGENT_DELEGATION !== 'false',
      blockComposio:        process.env.SUB_AGENT_BLOCK_COMPOSIO !== 'false',
      // Ollama Cloud model for the (legacy) coding sub-agent route.
      // Retained for back-compat; the live routes are subAgent.kimi/.minimax below.
      ollamaModel:        process.env.SUBAGENT_OLLAMA_MODEL?.trim() || 'kimi-k2.6:cloud',
      // Native coding sub-agent route — Kimi for Coding (Moonshot), OpenAI-compatible.
      // The /coding endpoint gates by client identity, so a recognized coding-agent
      // User-Agent is required (plain requests get 403). Same key as the main Kimi agents.
      kimi: {
        baseURL:   process.env.SUBAGENT_KIMI_BASE_URL?.trim()   || 'https://api.kimi.com/coding/v1',
        apiKey:    process.env.KIMI_ANTHROPIC_KEY?.trim()       || '',
        model:     process.env.SUBAGENT_KIMI_MODEL?.trim()      || 'kimi-for-coding',
        userAgent: process.env.SUBAGENT_KIMI_USER_AGENT?.trim() || 'claude-code/1.0.0',
        // Whether this family may be used for sub-agent routing. Explicit env
        // wins; otherwise defaults to enabled only when a key is present, so a
        // fresh install without a Kimi key simply skips this family instead of
        // 401-failing every code-routed sub-agent. Set SUBAGENT_KIMI_ENABLED=false
        // to disable even with a valid key (e.g. cost/quota control).
        enabled:   process.env.SUBAGENT_KIMI_ENABLED !== undefined
                     ? process.env.SUBAGENT_KIMI_ENABLED === 'true'
                     : !!(process.env.KIMI_ANTHROPIC_KEY?.trim()),
      },
      // Native prose/general sub-agent route — MiniMax direct, OpenAI-compatible.
      minimax: {
        baseURL: process.env.SUBAGENT_MINIMAX_BASE_URL?.trim() || 'https://api.minimax.io/v1',
        apiKey:  process.env.MINIMAX_ANTHROPIC_KEY?.trim()     || '',
        model:   process.env.SUBAGENT_MINIMAX_MODEL?.trim()    || process.env.MINIMAX_ANTHROPIC_MODEL?.trim() || 'MiniMax-M3',
        // See kimi.enabled above — same semantics for the MiniMax family.
        enabled: process.env.SUBAGENT_MINIMAX_ENABLED !== undefined
                   ? process.env.SUBAGENT_MINIMAX_ENABLED === 'true'
                   : !!(process.env.MINIMAX_ANTHROPIC_KEY?.trim()),
      },
      // Comma-separated tools blocked for sub-agents (spawnDepth >= 1).
      // fs_read/fs_list are read-only and allowed — sub-agents need them to inspect cloned repos etc.
      // See specs/sub-agent-tool-lockdown.md Fix 1.
      blockedTools: (process.env.SUB_AGENT_BLOCKED_TOOLS ?? [
        'fs_write', 'fs_edit', 'fs_search',
        'bash_run',
        'write_vault_note', 'save_session_summary',
        'manage_task', 'manage_project',
        'manage_skill', 'manage_skill_script',
        'discord_register_bot', 'discord_remove_bot',
        'schedule_job', 'delete_job', 'update_job',
        'spawn_agent', 'assign_task_to_agent',
      ].join(',')).split(',').map((s: string) => s.trim()).filter(Boolean),
    };
  },
  // Universal token-optimization layer (spec 2026-07-10). Two independent
  // components; both default-safe.
  //  - Component A (verbosity directives) is per-agent opt-in via the agents
  //    table, not env — no global flag here.
  //  - Component B (tool-output compression) is a global middleware with a
  //    kill switch + byte cap. Retrieval results are ALWAYS exempt regardless.
  get tokenOpt() {
    return {
      // Compress noisy command/tool output before it re-enters model context.
      // Default ON; flip TOKEN_OPT_TOOL_COMPRESSION=false to disable entirely.
      toolCompression:  process.env.TOKEN_OPT_TOOL_COMPRESSION !== 'false',
      // Per-result byte cap (final backstop; head+tail preserved). Only strings
      // ABOVE this many bytes are ever touched; small results pass untouched.
      compressionMaxBytes: parseInt(process.env.TOKEN_OPT_COMPRESSION_MAX_BYTES ?? '8000', 10),
      // Minimum string length (bytes) before any compression rule engages. Keeps
      // short results byte-identical and avoids churning tiny payloads.
      compressionMinBytes: parseInt(process.env.TOKEN_OPT_COMPRESSION_MIN_BYTES ?? '2000', 10),
      // Lines of context to protect on either side of an error/diagnostic line
      // (stack-trace continuation guard).
      keepVerbatimContext: parseInt(process.env.TOKEN_OPT_KEEP_VERBATIM_CONTEXT ?? '3', 10),
    };
  },
  get ollama() {
    return {
      baseURL:      process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434/v1',
      model:        process.env.OLLAMA_MODEL?.trim()   || 'llama3.2',
      enabled:      true, // no key required; offline server fails at chat time
      // Set OLLAMA_TOOLS_ENABLED=false to strip the tools array from requests.
      // Useful for local models that don't support function calling and fail
      // with premature close when they receive a tools payload.
      toolsEnabled: process.env.OLLAMA_TOOLS_ENABLED !== 'false',
      retryMax:     parseInt(process.env.OLLAMA_RETRY_MAX     ?? '2',    10),
      retryBaseMs:  parseInt(process.env.OLLAMA_RETRY_BASE_MS ?? '1500', 10),
      // Ollama defaults to a small context window (2048–4096 tokens). Tool schemas
      // alone can consume that budget before the model reads the user prompt.
      // 16384 gives most modern models room for system prompt + tools + history.
      // Set to 0 to let Ollama use its own default.
      numCtx:       parseInt(process.env.OLLAMA_NUM_CTX       ?? '16384', 10),
    };
  },
  get claude() {
    const raw = (process.env.CLAUDE_BACKEND ?? 'claude-cli').trim().toLowerCase();
    const backend: 'claude-cli' | 'anthropic-api' =
      raw === 'anthropic-api' ? 'anthropic-api' : 'claude-cli';
    return {
      backend,
      cliCommand:       process.env.CLAUDE_CLI_COMMAND?.trim() || 'claude',
      // ABSOLUTE backstop ceiling — fires REGARDLESS of activity (project: Jarvis
      // long-run triage). The PRIMARY stop signal is now idleAbortMs (genuine
      // model silence); this only catches a turn still ACTIVE past the ceiling
      // (runaway loop) or a tool wedged with no give-up trigger. Raised in prod
      // (.env) well above the old 900s so legit 20-30 min Forge builds — which
      // stream/hold tools the whole time — are never guillotined mid-work.
      timeoutMs:        parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '900000', 10),
      retryMax:         parseInt(process.env.CLAUDE_RETRY_MAX ?? '2', 10),
      retryBaseMs:      parseInt(process.env.CLAUDE_RETRY_BASE_MS ?? '3000', 10),
      // Give-up condition (primary): bail early and report back once this many
      // tool calls FAIL in a turn (is_error — non-zero exit / tool error). A
      // task blocked on an external failure (e.g. a docker run that keeps exiting
      // 1 on a Cloudflare block) trips this instead of grinding to timeoutMs. 0 off.
      maxFailedToolCalls:   parseInt(process.env.CLAUDE_MAX_FAILED_TOOL_CALLS ?? '3', 10),
      // Give-up condition (backstop): bail when the model re-runs the SAME tool
      // call this many times — catches pointless looping even when calls exit 0
      // (e.g. "completed but wrong state" retried identically). Default off; the
      // failure counter above is the primary trigger.
      maxRepeatedToolCalls: parseInt(process.env.CLAUDE_MAX_REPEATED_TOOL_CALLS ?? '0', 10),
      // Soft wall-clock budget: bail gracefully (report progress + how to resume)
      // after this long, well before the hard timeoutMs / Discord's stream cutoff.
      // 0 disables (rely on the repeat-detector + hard timeout only).
      softTimeoutMs:    parseInt(process.env.CLAUDE_SOFT_TIMEOUT_MS ?? '0', 10),
      // Liveness-gated idle abort (project: Jarvis long-run triage) — the PRIMARY
      // stop signal. If the turn goes genuinely SILENT (no SDK message for this
      // long) AND no tool is in flight (pendingTool === null), it's wedged, so we
      // bail with a graceful report-back. A long-running tool (Forge build, slow
      // gen) keeps pendingTool set, so this never cuts legit work — that case is
      // bounded only by the absolute backstop (timeoutMs). 0 disables idle abort.
      idleAbortMs:      parseInt(process.env.CLAUDE_IDLE_ABORT_MS ?? '300000', 10),
      // Two-plane backbone: point the Claude Agent SDK at the LiteLLM
      // Anthropic-compatible gateway (/v1/messages) so it can drive ANY model
      // (gemini/deepseek/kimi/etc.) through one agentic loop. Agents opt in via
      // provider='claude-gateway'. Reuses the LiteLLM credentials. The default
      // model is validated on the gateway (see scripts/claude-gateway-spike.ts).
      gateway: {
        baseURL: process.env.LITELLM_BASE_URL?.trim() || '',
        apiKey:  process.env.LITELLM_API_KEY?.trim()  || '',
        model:   process.env.CLAUDE_GATEWAY_MODEL?.trim() || 'openrouter/google/gemini-2.5-flash',
      },
      // Native Anthropic-endpoint targets driven by the SAME Claude SDK loop but
      // pointed at each provider's OWN /v1/messages endpoint (bypassing LiteLLM).
      // Agents opt in via provider='kimi' / 'minimax'. Disabled until both URL+key
      // are set (then the provider routes through the Claude SDK natively). Unlocks
      // provider-specific features (e.g. MiniMax) without LiteLLM translation loss.
      gateways: {
        kimi: {
          baseURL: process.env.KIMI_ANTHROPIC_BASE_URL?.trim() || 'https://api.moonshot.ai/anthropic',
          apiKey:  process.env.KIMI_ANTHROPIC_KEY?.trim()      || '',
          model:   process.env.KIMI_ANTHROPIC_MODEL?.trim()    || 'kimi-k2.6',
        },
        minimax: {
          baseURL: process.env.MINIMAX_ANTHROPIC_BASE_URL?.trim() || '',
          apiKey:  process.env.MINIMAX_ANTHROPIC_KEY?.trim()      || '',
          model:   process.env.MINIMAX_ANTHROPIC_MODEL?.trim()    || 'MiniMax-M2.7',
        },
      },
    };
  },
  get vision() {
    return {
      provider:   (process.env.VISION_PROVIDER?.trim() || 'openrouter').toLowerCase(),
      // Dual-pipeline preprocessor models. openrouterModel = Gemini via OpenRouter
      // (default pipeline, universal describer); hermesModel = Grok via Hermes
      // (allowlist agents whose images Gemini refuses). Each provider resolves to
      // its OWN model so the hermes path never sends a gemini model string to xAI.
      openrouterModel: process.env.VISION_OPENROUTER_MODEL?.trim() || 'google/gemini-3.5-flash',
      hermesModel:     process.env.VISION_HERMES_MODEL?.trim() || 'grok-4',
      prompt:     process.env.VISION_PROMPT?.trim()
                  || 'Describe this image in detail, including text, objects, layout, and any notable visual elements. Be concise but complete — your description is the only context an LLM will see.',
      maxChars:   parseInt(process.env.VISION_MAX_DESCRIPTION_CHARS ?? '2000', 10),
    };
  },
  get embeddings() {
    const openAiKey = process.env.OPENAI_API_KEY?.trim();
    return {
      enabled:    (process.env.MEMORY_EMBEDDINGS_ENABLED ?? 'false').trim().toLowerCase() === 'true',
      model:      process.env.MEMORY_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
      minChars:   parseInt(process.env.MEMORY_EMBEDDING_MIN_CHARS ?? '30', 10),
      // Route to OpenAI directly when OPENAI_API_KEY is set; otherwise fall back
      // to the existing VoidAI-compatible client.
      provider:   openAiKey ? ('openai' as const) : ('voidai' as const),
      apiKey:     openAiKey || this.voidai.bgApiKey,
      baseURL:    openAiKey ? 'https://api.openai.com/v1' : this.voidai.baseURL,
    };
  },
  get kb() {
    return {
      enabled:            (process.env.KB_ENABLED ?? 'false').trim().toLowerCase() === 'true',
      supabaseUrl:        process.env.SUPABASE_URL?.trim() || '',
      supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY?.trim() || '',
      // Dedicated schema for all KB objects (must be exposed via PGRST_DB_SCHEMAS).
      dbSchema:           process.env.KB_DB_SCHEMA?.trim() || 'neuroclaw_kb',
      // Locked: must match the model used for the KB's existing embedded vectors.
      embeddingModel:     process.env.KB_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
      chunkMaxChars:      parseInt(process.env.KB_CHUNK_MAX_CHARS ?? '2000', 10), // ~500 tokens
      crawl4aiUrl:        process.env.KB_CRAWL4AI_URL?.trim() || 'http://127.0.0.1:7105/mcp',
      matchCount:         parseInt(process.env.KB_MATCH_COUNT ?? '5', 10),
      // Prefer a docs platform's Markdown-native page variant (e.g. Mintlify's
      // `<path>.md`) over a rendered-HTML crawl. The .md version includes ALL
      // tabbed code samples (curl/python/ts); an HTML crawl only gets the
      // default-visible tab. Falls back to crawl4ai when no .md variant exists.
      preferMarkdown:     (process.env.KB_CRAWL_PREFER_MARKDOWN ?? 'true').trim().toLowerCase() !== 'false',
    };
  },
  get memoryGraph() {
    return {
      // Default true: same LLM call as the extractor, marginal token cost,
      // big win for cross-memory queries ("which memories mention X?",
      // "what relationships involve agent Y?").
      enabled: (process.env.MEMORY_GRAPH_EXTRACT_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    };
  },
  get discordBot() {
    const token = process.env.DISCORD_BOT_TOKEN?.trim();
    let routes: Record<string, string> = {};
    try {
      const raw = process.env.DISCORD_CHANNEL_ROUTES?.trim();
      if (raw) routes = JSON.parse(raw);
    } catch { /* malformed JSON — fall back to empty */ }
    const allow = (process.env.DISCORD_ALLOWED_USERS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    return {
      enabled:        !!token,
      token,
      defaultAgent:   process.env.DISCORD_DEFAULT_AGENT?.trim() || 'Alfred',
      channelRoutes:  routes,
      allowedUsers:   allow,
      maxReplyChars:  parseInt(process.env.DISCORD_MAX_REPLY_CHARS ?? '1900', 10),
    };
  },
  get voice() {
    return {
      silenceThresholdMs: parseInt(process.env.VOICE_SILENCE_THRESHOLD_MS ?? '500', 10),
      maxUtteranceSec:    parseInt(process.env.VOICE_MAX_UTTERANCE_SEC    ?? '30',  10),
    };
  },
  get audio() {
    const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();
    return {
      // VoidAI exposes OpenAI-compatible /audio/speech (TTS) and /audio/transcriptions (Whisper).
      voidai: {
        ttsModel:        process.env.VOIDAI_TTS_MODEL?.trim()        || 'tts-1',
        ttsVoice:        process.env.VOIDAI_TTS_VOICE?.trim()        || 'alloy',
        transcribeModel: process.env.VOIDAI_TRANSCRIBE_MODEL?.trim() || 'whisper-1',
      },
      // ElevenLabs is its own product with richer voice cloning. Disabled when no key is set.
      elevenlabs: {
        enabled:        !!elevenKey,
        apiKey:         elevenKey ?? '',
        baseURL:        process.env.ELEVENLABS_BASE_URL?.trim()         || 'https://api.elevenlabs.io/v1',
        defaultVoiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim() || '',
        model:          process.env.ELEVENLABS_MODEL?.trim()            || 'eleven_turbo_v2_5',
      },
      kokoro: {
        enabled:        !!(process.env.KOKORO_API_KEY?.trim()),
        apiKey:         process.env.KOKORO_API_KEY?.trim() ?? '',
        baseURL:        process.env.KOKORO_BASE_URL?.trim()         || 'https://kokorotts.nb.neurolearninglabs.com/v1',
        defaultVoiceId: process.env.KOKORO_DEFAULT_VOICE_ID?.trim() || 'af_heart',
        model:          process.env.KOKORO_MODEL?.trim()            || 'kokoro',
      },
      deepgram: {
        enabled: !!(process.env.DEEPGRAM_API_KEY?.trim()),
        apiKey:  process.env.DEEPGRAM_API_KEY?.trim() ?? '',
        baseURL: process.env.DEEPGRAM_BASE_URL?.trim() || 'https://api.deepgram.com/v1',
        model:   process.env.DEEPGRAM_MODEL?.trim()   || 'nova-3',
      },
      hermes: {
        ttsVoice: process.env.HERMES_TTS_VOICE?.trim() || 'default',
      },
      // Chatterbox TTS — internal instance at chatterbox.internal.neurolearninglabs.com.
      // No API key required for the internal deployment; CHATTERBOX_API_KEY is optional
      // for setups that add bearer auth in front of the service.
      // model_type: base | turbo | multilingual (default: base)
      chatterbox: {
        enabled:      (process.env.CHATTERBOX_ENABLED ?? 'true').toLowerCase() !== 'false',
        baseURL:      process.env.CHATTERBOX_BASE_URL?.trim()       || 'https://chatterbox.internal.neurolearninglabs.com',
        apiKey:       process.env.CHATTERBOX_API_KEY?.trim()        || '',
        defaultVoice: process.env.CHATTERBOX_DEFAULT_VOICE?.trim()  || '',
        modelType:    process.env.CHATTERBOX_MODEL_TYPE?.trim()     || 'base',
        exaggeration: parseFloat(process.env.CHATTERBOX_EXAGGERATION ?? '0.5'),
        cfgWeight:    parseFloat(process.env.CHATTERBOX_CFG_WEIGHT    ?? '0.5'),
      },
      // Hard cap on uploaded audio (transcription) and on text length (TTS) to avoid runaway spend.
      maxFileMb:    parseInt(process.env.AUDIO_MAX_MB        ?? '25',   10),
      maxTtsChars:   parseInt(process.env.AUDIO_MAX_TTS_CHARS ?? '4000', 10),
      ttsChunkChars: parseInt(process.env.TTS_CHUNK_CHARS    ?? '1500', 10),
    };
  },
  get geminiLive() {
    const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
    return {
      apiKey,
      liveModel:    process.env.GEMINI_LIVE_MODEL?.trim()                    ?? 'gemini-2.0-flash-live',
      liveVoice:    process.env.GEMINI_LIVE_VOICE?.trim()                    ?? 'Zephyr',
      idleTimeoutMs: parseInt(process.env.GEMINI_LIVE_IDLE_TIMEOUT_MINUTES ?? '5', 10) * 60_000,
      enabled:      !!apiKey,
    };
  },
  get browser() {
    return {
      url:       process.env.BROWSERLESS_URL?.trim() ?? '',
      token:     process.env.BROWSERLESS_TOKEN?.trim() ?? '',
      timeoutMs: parseInt(process.env.BROWSERLESS_TIMEOUT_MS ?? '60000', 10),
      enabled:   !!(process.env.BROWSERLESS_URL?.trim() && process.env.BROWSERLESS_TOKEN?.trim()),
      // Optional upstream proxy for the headless Chromium. Set to a residential
      // SOCKS5/HTTP proxy (e.g. socks5://100.x.x.x:1080 over NetBird) to escape
      // the datacenter-IP bot-walls (Cloudflare "Just a moment", etc.) that
      // block direct fetches. NOTE: Chromium cannot authenticate to a SOCKS5
      // proxy — the proxy MUST be no-auth (gate access at the network layer,
      // e.g. bind to the NetBird interface only). Applied per-request via
      // Browserless's `launch` query param. Empty = no proxy (direct).
      proxyUrl:  process.env.BROWSERLESS_PROXY_URL?.trim() ?? '',
    };
  },
  get providerHealth() {
    return {
      // WS2 provider health & cooldown layer. Disable to restore the old
      // memoryless routing (candidates always tried in declared order).
      enabled:                 process.env.PROVIDER_HEALTH_ENABLED !== 'false',
      // Usage-limit windows at/over this % set a soft cooldown until reset.
      windowThresholdPercent:  parseInt(process.env.PROVIDER_HEALTH_WINDOW_THRESHOLD ?? '95', 10),
      // How often to poll the claude/minimax limit-window fetchers.
      pollMinutes:             parseInt(process.env.PROVIDER_HEALTH_POLL_MINUTES ?? '15', 10),
    };
  },
  get brave() {
    // Brave Search API — datacenter-resilient JSON web search. Used as the
    // PRIMARY backend for web_search when a key is present; the SearXNG +
    // headless-browser ladder remains the fallback. Free tier: 2k queries/mo.
    const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim() ?? '';
    return {
      apiKey,
      enabled:   !!apiKey,
      baseUrl:   process.env.BRAVE_SEARCH_BASE_URL?.trim() || 'https://api.search.brave.com/res/v1',
      timeoutMs: parseInt(process.env.BRAVE_SEARCH_TIMEOUT_MS ?? '15000', 10),
    };
  },
  get searxng() {
    return {
      // NeuroClaw SearXNG metasearch instance — backs the first-class web_search
      // tool. Defaults to the hosted instance; set SEARXNG_ENABLED=false to gate
      // the tool off entirely.
      baseUrl:   process.env.SEARXNG_BASE_URL?.trim() || 'https://searxng.neurolearninglabs.com',
      enabled:   process.env.SEARXNG_ENABLED !== 'false',
      timeoutMs: parseInt(process.env.SEARXNG_TIMEOUT_MS ?? '20000', 10),
      // When a general-category search returns zero results (the default engine
      // set — brave/ddg/startpage — is frequently blocked from datacenter IPs),
      // retry once pinned to these engines. Reachability is time-varying, so we
      // fan out across several known-survivable engines instead of betting on a
      // single one (bing alone times out intermittently).
      fallbackEngines: process.env.SEARXNG_FALLBACK_ENGINES?.trim()
        || 'bing,google,brave,duckduckgo,mojeek,wikipedia,stackoverflow',
    };
  },
  get composio() {
    const apiKey = process.env.COMPOSIO_API_KEY?.trim();
    return {
      // The integration is gated TWICE: globally on the presence of an API key
      // here, and per-agent on the agents.composio_enabled column. Both must
      // be truthy for an agent to receive Composio tools.
      enabled:    !!apiKey,
      apiKey:     apiKey || undefined,
      baseUrl:    process.env.COMPOSIO_BASE_URL?.trim() || undefined,
      sessionTtlSec:    parseInt(process.env.COMPOSIO_SESSION_TTL_SEC ?? '900', 10),
      // Global default cap on the number of Composio tools surfaced to any
      // single agent per turn. Per-agent overrides live on
      // agents.composio_token_budget; null there falls back to this value.
      maxToolsPerAgent: parseInt(process.env.COMPOSIO_MAX_TOOLS ?? '40', 10),
    };
  },
  get livekit() {
    return {
      apiKey:    process.env.LIVEKIT_API_KEY?.trim()    ?? '',
      apiSecret: process.env.LIVEKIT_API_SECRET?.trim() ?? '',
      url:       process.env.LIVEKIT_URL?.trim()        ?? '',
      enabled:   !!(
        process.env.LIVEKIT_API_KEY?.trim() &&
        process.env.LIVEKIT_API_SECRET?.trim() &&
        process.env.LIVEKIT_URL?.trim()
      ),
    };
  },
  get alerts() {
    return {
      discordChannelId: process.env.ALERT_DISCORD_CHANNEL_ID?.trim() || null,
      discordBotId:     process.env.ALERT_DISCORD_BOT_ID?.trim()     || null,
      gotifyUrl:        process.env.GOTIFY_URL?.trim()                || null,
      gotifyToken:      process.env.GOTIFY_TOKEN?.trim()              || null,
      dedupWarnMin:     parseInt(process.env.ALERT_DEDUP_WARN_MIN  ?? '30', 10),
      dedupErrorMin:    parseInt(process.env.ALERT_DEDUP_ERROR_MIN ?? '10', 10),
    };
  },
  get notifications() {
    return {
      // Mirror dashboard notifications (agent_user_message, approval, analyst_alert) to Discord.
      // When enabled, every new notification also posts to ALERT_DISCORD_CHANNEL_ID (or a separate channel).
      discordEnabled:   (process.env.NOTIFY_DISCORD_ENABLED ?? 'false').trim().toLowerCase() === 'true',
      discordChannelId: process.env.NOTIFY_DISCORD_CHANNEL_ID?.trim() || process.env.ALERT_DISCORD_CHANNEL_ID?.trim() || null,
      discordBotId:     process.env.NOTIFY_DISCORD_BOT_ID?.trim()     || process.env.ALERT_DISCORD_BOT_ID?.trim()     || null,
    };
  },
  get taskHealth() {
    return {
      intervalMin: parseInt(process.env.TASK_HEALTH_INTERVAL_MIN ?? '5',   10),
      warnMin:     parseInt(process.env.TASK_HEALTH_WARN_MIN     ?? '30',  10),
      errorMin:    parseInt(process.env.TASK_HEALTH_ERROR_MIN    ?? '120', 10),
      criticalMin: parseInt(process.env.TASK_HEALTH_CRITICAL_MIN ?? '480', 10),
    };
  },
  get n8n() {
    return {
      baseUrl: process.env.N8N_BASE_URL?.trim() || 'http://localhost:5678',
      apiKey:  process.env.N8N_API_KEY?.trim()  || '',
    };
  },
  get kimiApi() {
    return {
      apiKey:  process.env.KIMI_API_KEY?.trim()      ?? '',
      baseURL: process.env.KIMI_API_BASE_URL?.trim() || 'https://api.kimi.com/coding/v1',
      model:   process.env.KIMI_API_MODEL?.trim()    || 'kimi-for-coding',
      enabled: !!(process.env.KIMI_API_KEY?.trim()),
    };
  },
  get opencode() {
    return {
      cliCommand:       process.env.OPENCODE_CLI_COMMAND?.trim()                   || 'opencode',
      timeoutMs:        parseInt(process.env.OPENCODE_TIMEOUT_MS        ?? '900000', 10),
      concurrencyLimit: parseInt(process.env.OPENCODE_CONCURRENCY_LIMIT ?? '1',      10),
    };
  },
  get antigravity() {
    return {
      cliCommand:       process.env.ANTIGRAVITY_CLI_COMMAND?.trim()  || 'agy',
      settingsDir:      process.env.ANTIGRAVITY_SETTINGS_DIR?.trim() || '',
      model:            process.env.ANTIGRAVITY_MODEL?.trim()        || 'antigravity/gemini-3-5-flash-high',
      timeoutMs:        parseInt(process.env.ANTIGRAVITY_TIMEOUT_MS         ?? '900000', 10),
      concurrencyLimit: parseInt(process.env.ANTIGRAVITY_CONCURRENCY_LIMIT  ?? '0',      10),
      // DEFAULT ON: agy runs as a persistent tmux REPL (launched via `agy -i`,
      // persona folded into the first prompt, completion via the respond MCP
      // tool — see antigravity-session.ts). Validated end-to-end against agy
      // 1.0.5. Set ANTIGRAVITY_TMUX_ENABLED=false to fall back to the stateless
      // `--print` path.
      tmuxEnabled:       process.env.ANTIGRAVITY_TMUX_ENABLED                  !== 'false',
      sessionTtlMinutes: parseInt(process.env.ANTIGRAVITY_SESSION_TTL_MINUTES  ?? '30',     10),
    };
  },
  get litellm() {
    return {
      apiKey:       process.env.LITELLM_API_KEY?.trim()  || '',
      baseURL:      process.env.LITELLM_BASE_URL?.trim() || 'http://localhost:4000/v1',
      model:        process.env.LITELLM_MODEL?.trim()    || 'gpt-4o',
      enabled:      !!(process.env.LITELLM_API_KEY?.trim() || process.env.LITELLM_BASE_URL?.trim()),
      toolsEnabled:     process.env.LITELLM_TOOLS_ENABLED !== 'false',
      textToolsEnabled: process.env.LITELLM_TEXT_TOOLS_ENABLED === 'true',
    };
  },
  get kestra() {
    return {
      baseUrl: process.env.KESTRA_BASE_URL?.trim() || 'http://localhost:8080',
      apiKey:  process.env.KESTRA_API_KEY?.trim()  || '',
    };
  },
  get approvals() {
    return {
      waitMs:           parseInt(process.env.APPROVAL_WAIT_MS ?? '300000', 10),
      autoAllow:        (process.env.APPROVAL_AUTO_ALLOW ?? '').split(',').map(s => s.trim()).filter(Boolean),
      defaultOnTimeout: (process.env.APPROVAL_DEFAULT_ON_TIMEOUT ?? 'deny') as 'deny' | 'allow',
    };
  },
  get inngest() {
    // Durable job queue (self-hosted Inngest at a public URL — see the plan at
    // docs/superpowers/plans/2026-06-03-inngest-integration.md).
    //   INNGEST_ENABLED: 'false' = legacy SQLite queue | 'dual' = SQLite + Inngest
    //   events (Phase 1 verification) | 'true' = Inngest-only (Phase 2).
    // eventKey/signingKey come from process.env, populated at boot from Infisical
    // (INGEST_EVENT_KEY / INGEST_SIGNING_KEY) via the broker SECRET_REGISTRY; the
    // Inngest SDK reads them lazily at send/serve time.
    const flag = (process.env.INNGEST_ENABLED ?? 'false').trim().toLowerCase();
    return {
      enabled:    flag === 'true',
      dualWrite:  flag === 'dual' || flag === 'true',
      baseUrl:    process.env.INNGEST_BASE_URL?.trim()    || 'https://inngest.neurolearninglabs.com',
      eventKey:   process.env.INNGEST_EVENT_KEY?.trim()   || '',
      signingKey: process.env.INNGEST_SIGNING_KEY?.trim() || '',
      serveUrl:   process.env.INNGEST_SERVE_URL?.trim()   || 'https://neuroclaw.neurolearninglabs.com/api/inngest',
    };
  },
  get claudeInteractive() {
    // Opt-in interactive-REPL path: drives a real `claude` session in tmux so
    // billing draws from the normal subscription pool, not the post-2026-06-15
    // metered Agent SDK credit pool. Additive — the Agent SDK path (claude-cli.ts)
    // is unchanged. See docs/superpowers/specs/2026-06-03-claude-interactive-pty-design.md
    return {
      enabled:        process.env.CLAUDE_INTERACTIVE_ENABLED === 'true',
      runUser:        process.env.CLAUDE_INTERACTIVE_RUN_USER?.trim() || '',
      idleReapMin:    parseInt(process.env.CLAUDE_INTERACTIVE_IDLE_REAP_MIN    ?? '10',      10),
      turnTimeoutMs:  parseInt(process.env.CLAUDE_INTERACTIVE_TURN_TIMEOUT_MS  ?? '600000',  10),
      maxSessionMs:   parseInt(process.env.CLAUDE_INTERACTIVE_MAX_SESSION_MS   ?? '3600000', 10),
    };
  },
  get update() {
    // GitHub self-update (spec 2026-07-15-github-self-update). Ships DORMANT:
    // UPDATE_ENABLED defaults false. remote/branch are trust-pinned from env —
    // request bodies can never redirect the update at an arbitrary repo (C8).
    return {
      enabled:           process.env.UPDATE_ENABLED === 'true',
      remote:            process.env.UPDATE_REMOTE?.trim() || 'origin',
      branch:            process.env.UPDATE_BRANCH?.trim() || 'main',
      canaryMaxAttempts: parseInt(process.env.UPDATE_CANARY_MAX_ATTEMPTS ?? '2', 10),
      rollbackKeep:      parseInt(process.env.UPDATE_ROLLBACK_KEEP ?? '5', 10),
    };
  },
  get studio() {
    // Studio Gen tab cost estimation + server-side spend circuit breaker.
    // Grayfia's thresholds (per-user burst 6 calls / 5 min, concurrency 2,
    // daily $8 USD-equivalent, global daily $40 USD-equivalent).
    const costMap: Record<string, number> = {
      // VoidAI image models (per-image USD estimate).
      'voidai_image':                        0.018,
      'voidai_image/gemini-3.1-flash-image': 0.018,
      'voidai_image/gemini-3-pro-image':     0.20,
      'voidai_gpt_image':                    0.15,
      'voidai_gpt_image/gpt-image-2':        0.15,
      // Abacus image models (gated out of launch providers, but priced for cap math).
      'abacus_image':                        0.03,
      'abacus_image/flux_pro':               0.03,
      'abacus_image/flux_pro_ultra':         0.06,
      // Pollinations is free-tier / ad-supported; nominal cost for cap math.
      'pollinations':                        0.00,
      // OpenArt is subscription-credit (no per-call USD); rough flat estimate so
      // the org/session USD ledger + call-count throttle still engage.
      'openart_image':                       0.02,
    };
    // Allow operator overrides as JSON: STUDIO_COST_MAP='{"voidai_image":0.04}'
    try {
      const override = process.env.STUDIO_COST_MAP?.trim();
      if (override) {
        const parsed = JSON.parse(override);
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number') costMap[k] = v;
        }
      }
    } catch { /* ignore malformed env */ }
    return {
      costMap,
      spendBreaker: {
        enabled:        (process.env.STUDIO_BREAKER_ENABLED ?? 'true').toLowerCase() !== 'false',
        // Grayfia: 5 minute rolling burst window.
        burstWindowMs:  parseInt(process.env.STUDIO_BREAKER_BURST_WINDOW_MS ?? '300000', 10),
        // Max concurrent in-flight image generations per user/session.
        maxConcurrent:  parseInt(process.env.STUDIO_BREAKER_MAX_CONCURRENT ?? '2', 10),
        // Grayfia: 6 calls per 5 minutes.
        burstMaxCalls:  parseInt(process.env.STUDIO_BREAKER_BURST_MAX_CALLS ?? '6', 10),
        // Secondary hard cap: max calls per calendar day per user/session.
        dailyMaxCalls:  parseInt(process.env.STUDIO_BREAKER_DAILY_MAX_CALLS ?? '200', 10),
        // Grayfia: $25 USD-equivalent per user per day.
        dailyMaxUsd:    parseFloat(process.env.STUDIO_BREAKER_DAILY_MAX_USD ?? '25.00'),
        // Grayfia: $20 USD-equivalent org-wide daily ceiling.
        globalDailyMaxUsd: parseFloat(process.env.STUDIO_BREAKER_GLOBAL_DAILY_MAX_USD ?? '20.00'),
        // Soft-warning threshold (internal alert) before org ceiling is hit.
        orgWarnUsd:     parseFloat(process.env.STUDIO_BREAKER_ORG_WARN_USD ?? '32.00'),
      },
    };
  },
};
