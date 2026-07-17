// Smoke test: seeded design_generation_error retries with spacing instead of
// dead-ending. Run with: npx tsx tests/tool-result-classification.smoke.ts

import { invokeTool } from '../src/tools/tool-middleware';
import type { ToolContext } from '../src/tools/context';

const ctx: ToolContext = { sessionId: 'smoke-session', agentId: 'smoke-agent', runId: 'smoke-run' };

async function main() {
  let attempts = 0;
  const started = Date.now();

  const result = await invokeTool({
    name: 'mcp__canva__generate-design',
    args: { query: 'smoke' },
    ctx,
    trace: false,
    run: async () => {
      attempts++;
      const elapsed = Date.now() - started;
      console.log(`[${elapsed}ms] attempt ${attempts}`);
      if (attempts < 2) {
        // Simulate the transient Canva ML-backend blip.
        return { ok: false, error: 'Canva returned design_generation_error; please retry.' };
      }
      return { ok: true, design_id: 'Dsmoke123', message: 'generated' };
    },
  });

  console.log('Result:', JSON.stringify(result));
  console.log(`Total attempts: ${attempts}`);
  if (attempts !== 2) {
    console.error('FAIL: expected 2 attempts (1 retry + 1 success)');
    process.exit(1);
  }
  const total = Date.now() - started;
  if (total < 25_000) {
    console.error('FAIL: retry was not spaced (expected ~30s backoff)');
    process.exit(1);
  }
  console.log(`PASS: retries were spaced (~${Math.round(total / 1000)}s total)`);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
