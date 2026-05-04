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
      // The fan-out tool name is configurable per-server. Default to '' which
      // means: skip the fan-out entirely. Set explicitly when you've confirmed
      // the live server actually exposes that tool. Common choices:
      //   ResearchLM (n8n): 'rag_chat' (RAG against notebooks) or 'web_search'
      //   InsightsLM:        'insightslm_search_sources' or whatever your server exposes
      researchlmSearchTool:  process.env.RESEARCHLM_SEARCH_TOOL?.trim() ?? '',
      insightslmSearchTool:  process.env.INSIGHTSLM_SEARCH_TOOL?.trim() ?? '',
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
      // Auto-inject top relevant memories into the system prompt every turn
      // so all agents (every provider + backend, including Claude CLI which
      // doesn't see custom tools) get baseline memory awareness.
      preinjectEnabled:    (process.env.MEMORY_PREINJECT_ENABLED ?? 'true').toLowerCase() !== 'false',
      preinjectMax:        parseInt(process.env.MEMORY_PREINJECT_MAX ?? '5', 10),
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
  get heartbeat() {
    return {
      enabled:     (process.env.HEARTBEAT_ENABLED ?? 'true').toLowerCase() !== 'false',
      intervalSec: parseInt(process.env.HEARTBEAT_INTERVAL_SEC ?? '60', 10),
      // Heartbeat model is a fixed cheap default unless overridden. gpt-4.1
      // is reliably available on VoidAI and snappy enough for sub-second pings.
      model:       process.env.HEARTBEAT_MODEL?.trim() || 'gpt-4.1',
      // Skip Claude CLI agents — pinging would burn subscription quota every interval.
      skipClaudeCli: (process.env.HEARTBEAT_SKIP_CLAUDE_CLI ?? 'true').toLowerCase() !== 'false',
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
  get codex() {
    const raw = (process.env.CODEX_BACKEND ?? 'cli').trim().toLowerCase();
    const backend: 'cli' | 'api' = raw === 'api' ? 'api' : 'cli';
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
  get vision() {
    return {
      model:      process.env.VISION_MODEL?.trim() || 'gpt-4o',
      provider:   (process.env.VISION_PROVIDER?.trim() || 'voidai').toLowerCase(),
      prompt:     process.env.VISION_PROMPT?.trim()
                  || 'Describe this image in detail, including text, objects, layout, and any notable visual elements. Be concise but complete — your description is the only context an LLM will see.',
      maxChars:   parseInt(process.env.VISION_MAX_DESCRIPTION_CHARS ?? '2000', 10),
    };
  },
  get embeddings() {
    return {
      enabled:    (process.env.MEMORY_EMBEDDINGS_ENABLED ?? 'false').trim().toLowerCase() === 'true',
      model:      process.env.MEMORY_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
      minChars:   parseInt(process.env.MEMORY_EMBEDDING_MIN_CHARS ?? '30', 10),
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
      // Hard cap on uploaded audio (transcription) and on text length (TTS) to avoid runaway spend.
      maxFileMb:    parseInt(process.env.AUDIO_MAX_MB        ?? '25',   10),
      maxTtsChars:  parseInt(process.env.AUDIO_MAX_TTS_CHARS ?? '4000', 10),
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
      sessionTtlSec: parseInt(process.env.COMPOSIO_SESSION_TTL_SEC ?? '900', 10),
    };
  },
};
