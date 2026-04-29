import { Langfuse, type LangfuseTraceClient } from 'langfuse';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: Langfuse | null = null;

export function getLangfuse(): Langfuse | null {
  const cfg = config.langfuse;
  if (!cfg.enabled) return null;

  if (!client) {
    try {
      client = new Langfuse({
        secretKey:     cfg.secretKey,
        publicKey:     cfg.publicKey,
        baseUrl:       cfg.host,
        flushAt:       10,
        flushInterval: 5000,
        release:       'neuroclaw-v1',
      });
      logger.info('Langfuse connected', { host: cfg.host });
    } catch (err) {
      logger.warn('Langfuse init failed', { err });
      return null;
    }
  }
  return client;
}

export function resetLangfuse(): void {
  if (client) {
    client.flushAsync().catch(() => {});
    client = null;
  }
}

// Helper to estimate tokens (rough approximation: ~4 chars per token)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Create a trace for a chat session
export function createChatTrace(
  sessionId: string,
  agentId: string | undefined,
  agentName: string | undefined,
  userMessage: string,
): LangfuseTraceClient | null {
  const lf = getLangfuse();
  if (!lf) return null;
  
  return lf.trace({
    name: 'chat',
    id: `${sessionId}-${Date.now()}`,
    sessionId,
    userId: agentId,
    input: userMessage,
    metadata: { 
      agentName,
      agentId,
      inputTokens: estimateTokens(userMessage),
    },
  });
}

// Log a tool execution as a span
export function logToolSpan(
  trace: LangfuseTraceClient | null,
  toolName: string,
  toolInput: string,
  toolOutput: string,
  durationMs: number,
): void {
  if (!trace) return;
  
  trace.span({
    name: `tool:${toolName}`,
    input: toolInput,
    output: toolOutput,
    metadata: {
      durationMs,
      inputTokens: estimateTokens(toolInput),
      outputTokens: estimateTokens(toolOutput),
    },
  });
}

// Log router/classifier decision
export function logRouterDecision(
  trace: LangfuseTraceClient | null,
  decision: { agentName: string; confidence: number; reason: string } | null,
  durationMs: number,
): void {
  if (!trace) return;
  
  trace.span({
    name: 'router',
    output: decision ? `${decision.agentName} (${Math.round(decision.confidence * 100)}%)` : 'fallback to Alfred',
    metadata: {
      decision,
      durationMs,
    },
  });
}
