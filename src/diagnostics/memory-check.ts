// memory-check — end-to-end diagnostic for the v1.5 memory pipeline.
// Run via: npm run check:memory
//
// Tests, in order:
//   1. SQLite memory_index write
//   2. Memory retrieval (SQLite path)
//   3. Pre-injection block formatting
//   4. NeuroVault MCP write (if MCP_ENABLED)
//   5. NeuroVault search (if MCP_ENABLED)
//   6. Vault file read-back (if MCP_ENABLED)
//   7. Session summary save
//   8. Compaction trigger logic
//
// Cleans up its own test rows and skips vault deletion (left intentional).

import 'dotenv/config';
import { config } from '../config';
import { getDb } from '../db';
import { indexMemory, listMemoryIndex, searchMemoryIndex } from '../memory/memory-service';
import { retrieve } from '../memory/memory-retriever';
import { buildMemoryContextBlock, saveSessionSummaryTool, writeVaultNoteTool } from '../memory/memory-tools';
import { vaultSearch, vaultReadNote, vaultDeleteFile } from '../memory/vault-client';
import { maybeCompactHistory, type HistoryTurn } from '../memory/context-compactor';
import { initialSalience } from '../memory/memory-scorer';

type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

const colors = { PASS: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', SKIP: '\x1b[90m', reset: '\x1b[0m' };

const checks: { name: string; status: Status; detail?: string }[] = [];

function record(name: string, status: Status, detail?: string): void {
  checks.push({ name, status, detail });
  const c = colors[status];
  console.log(`  ${c}${status.padEnd(4)}${colors.reset}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main(): Promise<void> {
  console.log('\n── NeuroClaw memory pipeline diagnostic ──────────────────────\n');

  console.log('Config:');
  console.log(`  MCP_ENABLED                 = ${config.mcp.enabled}`);
  console.log(`  NEUROVAULT_MCP_URL          = ${config.mcp.neurovaultUrl ? config.mcp.neurovaultUrl.replace(/\/[a-z0-9-]+$/i, '/***') : '(unset)'}`);
  console.log(`  NEUROVAULT_DEFAULT_VAULT    = ${config.mcp.neurovaultDefaultVault}`);
  console.log(`  MEMORY_PREINJECT_ENABLED    = ${config.memory.preinjectEnabled}`);
  console.log(`  MEMORY_IMPORTANCE_THRESHOLD = ${config.memory.importanceThreshold}`);
  console.log(`  COMPACT_ENABLED             = ${config.compaction.enabled}`);
  console.log('');

  // ── (1) SQLite write ──────────────────────────────────────────────────
  console.log('Tests:');
  let testRowId: string | null = null;
  try {
    const row = indexMemory({
      type:       'procedural',
      title:      'memory-check test row',
      summary:    'Synthetic row inserted by memory-check.ts. Cleaned up at end.',
      tags:       ['memory-check', 'diagnostic'],
      importance: 0.85,
      salience:   initialSalience(0.85),
      agent_id:   null,
      session_id: null,
    });
    testRowId = row.id;
    record('memory_index INSERT', 'PASS', `id=${row.id.slice(0, 8)}`);
  } catch (err) {
    record('memory_index INSERT', 'FAIL', (err as Error).message);
  }

  // ── (2) Retrieval ──────────────────────────────────────────────────────
  try {
    const direct = searchMemoryIndex('memory-check', 5);
    if (direct.length === 0) record('searchMemoryIndex direct hit', 'WARN', 'no rows matched — index might be empty');
    else record('searchMemoryIndex direct hit', 'PASS', `${direct.length} hit(s)`);
  } catch (err) {
    record('searchMemoryIndex direct hit', 'FAIL', (err as Error).message);
  }

  try {
    const r = await retrieve({ query: 'memory-check test row', limit: 5 });
    if (r.total === 0) record('retrieve() fan-out', 'WARN', 'no hits across SQLite + vault + LM');
    else record('retrieve() fan-out', 'PASS', `${r.total} ranked hits, top score ${r.raw[0]?.score.toFixed(2)}`);
  } catch (err) {
    record('retrieve() fan-out', 'FAIL', (err as Error).message);
  }

  // ── (3) Pre-injection formatting ──────────────────────────────────────
  try {
    const block = await buildMemoryContextBlock({ query: 'memory-check test row' });
    if (!config.memory.preinjectEnabled) {
      record('buildMemoryContextBlock', 'SKIP', 'MEMORY_PREINJECT_ENABLED=false');
    } else if (!block) {
      record('buildMemoryContextBlock', 'WARN', 'returned empty — no relevant memories matched the query');
    } else if (!/Relevant long-term memory/i.test(block)) {
      record('buildMemoryContextBlock', 'FAIL', 'output missing expected header');
    } else {
      record('buildMemoryContextBlock', 'PASS', `${block.length} chars`);
    }
  } catch (err) {
    record('buildMemoryContextBlock', 'FAIL', (err as Error).message);
  }

  // ── (4-6) Vault round-trip ────────────────────────────────────────────
  let vaultPath: string | null = null;
  if (!config.mcp.enabled || !config.mcp.neurovaultUrl) {
    record('vault write (MCP)', 'SKIP', 'MCP_ENABLED=false or URL unset');
    record('vault search',      'SKIP', 'MCP disabled');
    record('vault read-back',   'SKIP', 'MCP disabled');
  } else {
    try {
      const w = await writeVaultNoteTool({
        title:      `memory-check ${new Date().toISOString().slice(0, 19)}`,
        type:       'insight',
        summary:    'Smoke test note written by memory-check.ts. Safe to delete.',
        content:    'This note exists to verify the NeuroVault MCP write path works end-to-end.',
        tags:       ['memory-check', 'diagnostic'],
        importance: 0.6,
        agent_name: 'memory-check',
        session_id: null,
      });
      if (w.ok && w.vault_path) {
        vaultPath = w.vault_path;
        record('vault write (MCP)', 'PASS', w.vault_path);
      } else {
        record('vault write (MCP)', w.ok ? 'WARN' : 'FAIL', w.error ?? 'no vault_path returned');
      }
    } catch (err) {
      record('vault write (MCP)', 'FAIL', (err as Error).message);
    }

    try {
      const hits = await vaultSearch({ query: 'memory-check', limit: 5 });
      if (hits.length === 0) record('vault search', 'WARN', 'no hits returned (n8n indexing may lag)');
      else                   record('vault search', 'PASS', `${hits.length} hits`);
    } catch (err) {
      record('vault search', 'FAIL', (err as Error).message);
    }

    if (vaultPath) {
      try {
        const content = await vaultReadNote({ note_id: vaultPath });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txt = typeof content === 'string' ? content : JSON.stringify(content);
        const passed = txt.includes('memory-check') || txt.includes('Smoke test');
        record('vault read-back', passed ? 'PASS' : 'WARN', passed ? `${txt.length} chars` : 'content did not contain expected marker');
      } catch (err) {
        record('vault read-back', 'FAIL', (err as Error).message);
      }
    }
  }

  // ── (7) Session summary ───────────────────────────────────────────────
  let sessionSummaryPath: string | null = null;
  try {
    const s = await saveSessionSummaryTool({
      summary:    'memory-check session summary smoke. Synthetic row.',
      title:      'memory-check session summary',
      tags:       ['memory-check'],
      importance: 0.5,
      agent_name: 'memory-check',
      session_id: null,
    });
    if (s.ok) {
      sessionSummaryPath = s.vault_path ?? null;
      record('saveSessionSummaryTool', 'PASS', s.vault_path ?? '(local-only — vault not enabled)');
    } else {
      record('saveSessionSummaryTool', 'FAIL', s.error ?? 'unknown');
    }
  } catch (err) {
    record('saveSessionSummaryTool', 'FAIL', (err as Error).message);
  }

  // ── (8) Compaction trigger logic ──────────────────────────────────────
  let compactPath: string | null = null;
  try {
    // Build a synthetic history that crosses the threshold.
    const history: HistoryTurn[] = [{ role: 'system', text: 'You are a test bot.' }];
    for (let i = 0; i < 40; i++) {
      history.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `Turn ${i}: this is some content to make the history non-trivial. `.repeat(8) });
    }
    const plan = await maybeCompactHistory({ history, newUserText: 'follow-up question', sessionId: null, agentName: 'memory-check' });
    if (!config.compaction.enabled) {
      record('maybeCompactHistory', 'SKIP', 'COMPACT_ENABLED=false');
    } else if (!plan) {
      record('maybeCompactHistory', 'FAIL', '40-turn history did not trigger — check thresholds');
    } else {
      compactPath = plan.summaryWritten.vault_path ?? null;
      record('maybeCompactHistory', 'PASS', `[${plan.from}..${plan.to}] reclaimed ~${plan.tokensReclaimed} tokens; vault=${plan.summaryWritten.vault_path ?? '(none)'}`);
    }
  } catch (err) {
    record('maybeCompactHistory', 'FAIL', (err as Error).message);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────
  // Local SQLite cleanup
  if (testRowId) {
    try { getDb().prepare('DELETE FROM memory_index WHERE id = ?').run(testRowId); } catch { /* ignore */ }
  }
  try {
    getDb().prepare(`DELETE FROM memory_index WHERE title LIKE 'memory-check%' AND created_at > datetime('now','-5 minutes')`).run();
    getDb().prepare(`DELETE FROM memory_index WHERE title LIKE 'Compacted context%' AND created_at > datetime('now','-5 minutes')`).run();
  } catch { /* ignore */ }

  // Vault cleanup — best-effort. Each path is stored from its own check.
  const vaultPathsToDelete: string[] = [vaultPath, sessionSummaryPath, compactPath].filter((p): p is string => !!p);
  if (config.mcp.enabled && config.mcp.neurovaultUrl && vaultPathsToDelete.length > 0) {
    let cleaned = 0;
    for (const p of vaultPathsToDelete) {
      try { await vaultDeleteFile({ path: p }); cleaned++; }
      catch (err) { console.warn(`  cleanup: could not delete ${p} — ${(err as Error).message}`); }
    }
    record('vault cleanup', cleaned === vaultPathsToDelete.length ? 'PASS' : 'WARN',
      `deleted ${cleaned}/${vaultPathsToDelete.length} test files`);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  for (const c of checks) counts[c.status]++;
  console.log('');
  console.log(`Total: ${checks.length}  ·  ${colors.PASS}${counts.PASS} pass${colors.reset}  ${colors.WARN}${counts.WARN} warn${colors.reset}  ${colors.FAIL}${counts.FAIL} fail${colors.reset}  ${colors.SKIP}${counts.SKIP} skip${colors.reset}`);
  console.log('');
  if (counts.FAIL > 0) {
    console.log(`${colors.FAIL}Memory pipeline has failures — see above.${colors.reset}`);
    process.exit(1);
  }
  console.log(counts.WARN > 0
    ? `${colors.WARN}Memory pipeline functional with warnings.${colors.reset}`
    : `${colors.PASS}Memory pipeline healthy.${colors.reset}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(2); });

// listMemoryIndex import is kept available for future expansion of this script.
void listMemoryIndex;
