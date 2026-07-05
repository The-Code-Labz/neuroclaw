// Phase 3c V-spike: confirm the @anthropic-ai/claude-agent-sdk `query()` loop
// runs against the LiteLLM Anthropic-compatible gateway (/v1/messages) driving a
// NON-Claude model (gemini via OpenRouter), executing a real in-process MCP tool
// over a multi-turn tool_result round-trip — and surface the duplicate
// `message_start` gotcha if it occurs.
//
// Run: npx tsx scripts/claude-gateway-spike.ts
// Read-only spike — no integration into alfred.ts, no service change.

import 'dotenv/config';
import { query, createSdkMcpServer, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const BASE  = process.env.LITELLM_BASE_URL!;
const KEY   = process.env.LITELLM_API_KEY!;
const MODEL = process.env.CLAUDE_GATEWAY_MODEL?.trim() || 'openrouter/google/gemini-2.5-flash';
const CLI   = '/root/.local/bin/claude';

if (!BASE || !KEY) { console.error('Missing LITELLM_BASE_URL / LITELLM_API_KEY'); process.exit(1); }

// Minimal MCP server with ONE deterministic tool so we can unambiguously detect
// a real tool_use → tool_result → final-answer round-trip through the gateway.
let toolInvoked = 0;
const server = createSdkMcpServer({
  name: 'spike',
  version: '0.0.1',
  tools: [
    tool('get_weather', 'Get the current weather for a city', { city: z.string() }, async (args) => {
      toolInvoked++;
      const a = args as { city: string };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ city: a.city, tempC: 21, sky: 'clear' }) }] };
    }),
  ],
});

async function main() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);

  // Gateway env: point the bundled CLI at LiteLLM /v1/messages with x-api-key auth.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: BASE,
    ANTHROPIC_API_KEY:  KEY,
    ANTHROPIC_AUTH_TOKEN: KEY, // some CLI versions prefer bearer; harmless alongside x-api-key
    // Try to suppress the Claude Code features that emit gateway-incompatible
    // params (reasoning_effort, context_management) on the /v1/messages request.
    MAX_THINKING_TOKENS:                      '0',
    DISABLE_AUTOCOMPACT:                      '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_MICROCOMPACT:                     '1',
  };

  const counts: Record<string, number> = {};
  const rawEventTypes: Record<string, number> = {};
  let messageStartCount = 0;
  let openMessage = false;            // true between a message_start and its message_stop
  let adjacentDuplicateStart = false; // two message_start with no message_stop between (the real gotcha)
  let sawToolUse = false;
  let finalText = '';
  let errored: string | null = null;

  console.log(`[spike] model=${MODEL} base=${BASE}`);
  const iter = query({
    prompt: 'What is the weather in Tokyo? Use the get_weather tool, then tell me the temperature in one sentence.',
    options: {
      model:                   MODEL,
      systemPrompt:            'You are a terse assistant. Use tools when asked.',
      maxTurns:                6,
      tools:                   [],
      includePartialMessages:  true,
      env:                     childEnv,
      abortController:         abort,
      settingSources:          [],
      mcpServers:              { spike: server },
      allowedTools:            ['mcp__spike__*'],
      pathToClaudeCodeExecutable: CLI,
    },
  });

  try {
    for await (const msg of iter as AsyncIterable<SDKMessage>) {
      counts[msg.type] = (counts[msg.type] ?? 0) + 1;
      if (msg.type === 'stream_event') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ev: any = (msg as any).event;
        if (ev?.type) rawEventTypes[ev.type] = (rawEventTypes[ev.type] ?? 0) + 1;
        if (ev?.type === 'message_start') {
          messageStartCount++;
          if (openMessage) adjacentDuplicateStart = true; // started a new message before the prior one stopped
          openMessage = true;
        }
        if (ev?.type === 'message_stop') openMessage = false;
        if (ev?.type === 'content_block_start' && ev?.content_block?.type === 'tool_use') sawToolUse = true;
        if (ev?.type === 'content_block_delta' && ev?.delta?.type === 'text_delta') finalText += ev.delta.text;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = msg;
      if (msg.type === 'assistant' && m.error) errored = `assistant.error=${m.error}`;
      if (msg.type === 'result') {
        if (m.subtype && m.subtype !== 'success') errored = `result.subtype=${m.subtype}`;
        if (!finalText && typeof m.result === 'string') finalText = m.result;
      }
    }
  } catch (e) {
    errored = (e as Error).message;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }

  console.log('\n========== SPIKE RESULT ==========');
  console.log('SDKMessage type counts:', counts);
  console.log('raw stream event types:', rawEventTypes);
  console.log('message_start events   :', messageStartCount, '(across', messageStartCount, 'assistant turns — balanced is normal)');
  console.log('ADJACENT dup start     :', adjacentDuplicateStart, adjacentDuplicateStart ? '  <-- gotcha #1 MANIFESTED; SDK still parsed it' : '  (not present this run)');
  console.log('tool_use observed      :', sawToolUse);
  console.log('tool handler invoked   :', toolInvoked, 'time(s)');
  console.log('final text             :', JSON.stringify(finalText.slice(0, 400)));
  console.log('error                  :', errored ?? 'none');
  const pass = !errored && sawToolUse && toolInvoked >= 1 && /21|temperat/i.test(finalText);
  console.log('VERDICT                :', pass ? 'PASS — agentic tool loop works through the gateway' : 'NEEDS REVIEW');
  console.log('==================================');
  process.exit(pass ? 0 : 2);
}

main();
