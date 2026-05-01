import dotenv from 'dotenv';
dotenv.config();

// Getters so live dotenv reloads (from config-watcher) propagate immediately
export const config = {
  get voidai() {
    return {
      apiKey:  process.env.VOIDAI_API_KEY  ?? '',
      baseURL: process.env.VOIDAI_BASE_URL ?? 'https://api.voidai.app/v1',
      model:   process.env.VOIDAI_MODEL    ?? 'gpt-5.1',
    };
  },
  get dashboard() {
    return {
      port:  parseInt(process.env.DASHBOARD_PORT ?? '3141', 10),
      token: process.env.DASHBOARD_TOKEN ?? 'change-me',
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
  get mcp() {
    return {
      enabled:               process.env.MCP_ENABLED === 'true',
      neurovaultUrl:         process.env.NEUROVAULT_MCP_URL?.trim() ?? '',
      neurovaultDefaultVault:process.env.NEUROVAULT_DEFAULT_VAULT?.trim() || 'neuroclaw',
      researchlmUrl:         process.env.RESEARCHLM_MCP_URL?.trim() ?? '',
      insightslmUrl:         process.env.INSIGHTSLM_MCP_URL?.trim() ?? '',
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
  get memory() {
    return {
      extractMinChars:     parseInt(process.env.MEMORY_EXTRACT_MIN_CHARS ?? '200', 10),
      extractModel:        process.env.MEMORY_EXTRACT_MODEL?.trim() || undefined,
      importanceThreshold: parseFloat(process.env.MEMORY_IMPORTANCE_THRESHOLD ?? '0.6'),
      perSessionMax:       parseInt(process.env.MEMORY_PER_SESSION_MAX ?? '50',  10),
      perHourMax:          parseInt(process.env.MEMORY_PER_HOUR_MAX    ?? '200', 10),
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
  get compaction() {
    return {
      enabled:           (process.env.COMPACT_ENABLED ?? 'true').toLowerCase() !== 'false',
      tokenThreshold:    parseInt(process.env.COMPACT_TOKEN_THRESHOLD ?? '8000', 10),
      turnThreshold:     parseInt(process.env.COMPACT_TURN_THRESHOLD  ?? '30',   10),
      keepRecent:        parseInt(process.env.COMPACT_KEEP_RECENT     ?? '6',    10),
      reinjectMemories:  parseInt(process.env.COMPACT_REINJECT_MEMORIES ?? '3',  10),
      model:             process.env.COMPACT_MODEL?.trim() || undefined,
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
      defaultCwd:     process.env.EXEC_DEFAULT_CWD?.trim() || process.cwd(),
    };
  },
  get claude() {
    const raw = (process.env.CLAUDE_BACKEND ?? 'claude-cli').trim().toLowerCase();
    const backend: 'claude-cli' | 'anthropic-api' =
      raw === 'anthropic-api' ? 'anthropic-api' : 'claude-cli';
    return {
      backend,
      cliCommand:       process.env.CLAUDE_CLI_COMMAND?.trim() || 'claude',
      maxTurns:         parseInt(process.env.CLAUDE_MAX_TURNS ?? '20', 10),
      timeoutMs:        parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '900000', 10),
      concurrencyLimit: parseInt(process.env.CLAUDE_CONCURRENCY_LIMIT ?? '1', 10),
      retryMax:         parseInt(process.env.CLAUDE_RETRY_MAX ?? '2', 10),
      retryBaseMs:      parseInt(process.env.CLAUDE_RETRY_BASE_MS ?? '3000', 10),
    };
  },
};
