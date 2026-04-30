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
};
