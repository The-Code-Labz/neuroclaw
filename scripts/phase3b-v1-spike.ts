// Phase 3b — V1 verification spike (throwaway de-risking script).
//
// Proves the two unknowns from the native-backend roadmap before we plan the
// OpenAI Agents SDK backbone:
//   V1a — OpenAIChatCompletionsModel accepts a CUSTOM OpenAI client with a
//         per-provider baseURL (OpenRouter), and runs a turn (non-stream + stream).
//   V1b — MCPServerStreamableHttp interoperates with OUR existing /mcp server
//         (src/tools/adapters/http-mcp.ts), can list NeuroClaw tools, and an
//         agent can invoke one through it (proves the registry → Agents-SDK path
//         AND that zod-4 tool schemas survive the round-trip over the wire).
//
// Run: npx tsx scripts/phase3b-v1-spike.ts   (dashboard must be running for V1b)

import 'dotenv/config';
import OpenAI from 'openai';
import {
  Agent, run, OpenAIChatCompletionsModel,
  MCPServerStreamableHttp, setTracingDisabled,
} from '@openai/agents';

setTracingDisabled(true); // no OpenAI tracing key needed for a spike

const OR_KEY   = process.env.OPENROUTER_API_KEY!;
const OR_BASE  = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OR_MODEL = process.env.OPENROUTER_MODEL    || 'openai/gpt-4o-mini';
const DASH_PORT  = process.env.DASHBOARD_PORT  || '3141';
const DASH_TOKEN = process.env.DASHBOARD_TOKEN || 'change-me';
const MCP_URL = `http://127.0.0.1:${DASH_PORT}/mcp`;

function line(s: string) { console.log(s); }

async function v1a(): Promise<boolean> {
  line('\n=== V1a: custom-baseURL OpenAI client → OpenAIChatCompletionsModel ===');
  try {
    const client = new OpenAI({ apiKey: OR_KEY, baseURL: OR_BASE });
    const model  = new OpenAIChatCompletionsModel(client, OR_MODEL);
    const agent  = new Agent({ name: 'SpikeA', instructions: 'You are terse.', model });

    // non-streaming
    const res = await run(agent, 'Reply with exactly: PONG');
    line(`  non-stream finalOutput: ${JSON.stringify(res.finalOutput)}`);

    // streaming
    let streamedChunks = 0;
    const stream = await run(agent, 'Count: one two three', { stream: true });
    for await (const ev of stream) {
      if ((ev as any).type === 'raw_model_stream_event') streamedChunks++;
    }
    await stream.completed;
    line(`  stream raw events: ${streamedChunks}, stream finalOutput: ${JSON.stringify(stream.finalOutput)}`);

    const ok = typeof res.finalOutput === 'string' && res.finalOutput.length > 0 && streamedChunks > 0;
    line(`  V1a => ${ok ? 'PASS ✅' : 'FAIL ❌'} (model=${OR_MODEL} via ${OR_BASE})`);
    return ok;
  } catch (e) {
    line(`  V1a => FAIL ❌  ${(e as Error).message}`);
    return false;
  }
}

async function v1b(): Promise<boolean> {
  line('\n=== V1b: MCPServerStreamableHttp ↔ our /mcp server ===');
  let mcp: MCPServerStreamableHttp | undefined;
  try {
    mcp = new MCPServerStreamableHttp({
      url: MCP_URL,
      name: 'neuroclaw',
      requestInit: { headers: { Authorization: `Bearer ${DASH_TOKEN}` } },
      cacheToolsList: true,
    });
    await mcp.connect();
    line(`  connected to ${MCP_URL}`);

    const tools = await mcp.listTools();
    line(`  listTools => ${tools.length} tools; sample: ${tools.slice(0, 5).map((t: any) => t.name).join(', ')}`);
    // zod-4-over-the-wire check: a representative tool must have a non-empty schema
    const sample = tools.find((t: any) => t.inputSchema?.properties && Object.keys(t.inputSchema.properties).length > 0);
    line(`  non-empty-schema tool present: ${sample ? `yes (${(sample as any).name})` : 'NO ❌'}`);

    // Agent invoking a tool THROUGH the MCP server
    const client = new OpenAI({ apiKey: OR_KEY, baseURL: OR_BASE });
    const model  = new OpenAIChatCompletionsModel(client, OR_MODEL);
    const agent  = new Agent({
      name: 'SpikeB',
      instructions: 'You can call NeuroClaw tools. When asked, use search_tools to look things up.',
      model,
      mcpServers: [mcp],
    });

    let toolCalled = false, streamed = 0;
    const stream = await run(agent, 'Use the search_tools tool to find tools about "memory". Then tell me one tool name.', { stream: true });
    for await (const ev of stream) {
      const t = (ev as any).type;
      if (t === 'raw_model_stream_event') streamed++;
      if (t === 'run_item_stream_event' && /tool_call/i.test((ev as any).item?.type || '')) toolCalled = true;
    }
    await stream.completed;
    line(`  tool call observed: ${toolCalled}; stream events: ${streamed}`);
    line(`  finalOutput: ${JSON.stringify(stream.finalOutput)?.slice(0, 200)}`);

    const ok = tools.length > 0 && !!sample && toolCalled;
    line(`  V1b => ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
    return ok;
  } catch (e) {
    line(`  V1b => FAIL ❌  ${(e as Error).message}`);
    return false;
  } finally {
    try { await mcp?.close(); } catch { /* ignore */ }
  }
}

(async () => {
  line(`Phase 3b V1 spike — OpenRouter model: ${OR_MODEL}`);
  const a = await v1a();
  const b = await v1b();
  line(`\n==== RESULT: V1a ${a ? 'PASS' : 'FAIL'} | V1b ${b ? 'PASS' : 'FAIL'} ====`);
  process.exit(a && b ? 0 : 1);
})();
