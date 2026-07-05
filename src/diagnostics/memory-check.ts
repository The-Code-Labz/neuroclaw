// memory-check — end-to-end diagnostic for the v1.5 memory pipeline.
// Run via: npm run check:memory
//
// Tests, in order:
//   1. memory_index write (active MemoryStore backend)
//   2. Memory retrieval
//   3. Pre-injection block formatting
//   4. Session summary save
//   5. Compaction trigger logic
//
// Memory lives in the configured backend (Supabase pgvector by default; SQLite
// is the rollback anchor). Cleans up its own SQLite test rows.

import 'dotenv/config';
import { config } from '../config';
import { getDb } from '../db';
import { indexMemory, listMemoryIndex, searchMemoryIndex } from '../memory/memory-service';
import { retrieve } from '../memory/memory-retriever';
import { buildMemoryContextBlock, saveSessionSummaryTool } from '../memory/memory-tools';
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
  console.log(`  MEMORY_BACKEND              = ${config.memory.backend}`);
  console.log(`  MEMORY_PREINJECT_ENABLED    = ${config.memory.preinjectEnabled}`);
  console.log(`  MEMORY_IMPORTANCE_THRESHOLD = ${config.memory.importanceThreshold}`);
  console.log(`  COMPACT_ENABLED             = ${config.compaction.enabled}`);
  console.log('');

  // ── (1) SQLite write ──────────────────────────────────────────────────
  console.log('Tests:');
  let testRowId: string | null = null;
  try {
    const row = await indexMemory({
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
    const direct = await searchMemoryIndex('memory-check', 5);
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

  // ── (4) Session summary ───────────────────────────────────────────────
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
      record('saveSessionSummaryTool', 'PASS', s.memory_id ? `memory_id=${s.memory_id.slice(0, 8)}` : 'stored');
    } else {
      record('saveSessionSummaryTool', 'FAIL', s.error ?? 'unknown');
    }
  } catch (err) {
    record('saveSessionSummaryTool', 'FAIL', (err as Error).message);
  }

  // ── (5) Compaction trigger logic ──────────────────────────────────────
  try {
    // Build a synthetic history that crosses the threshold.
    // In ratio mode (contextWindow > 0) we need ~triggerRatio tokens,
    // so we generate enough text to hit the threshold.
    const history: HistoryTurn[] = [{ role: 'system', text: 'You are a test bot.' }];
    const cw = config.compaction.contextWindow;
    const targetTokens = cw > 0 ? Math.floor(cw * config.compaction.triggerRatio) : config.compaction.tokenThreshold;
    const tokensPerTurn = 120; // rough estimate for our synthetic text
    const turnsNeeded = Math.max(6, Math.ceil((targetTokens + 500) / tokensPerTurn));
    const repeatsPerTurn = Math.max(2, Math.ceil(turnsNeeded / 40)); // scale content if many turns

    for (let i = 0; i < turnsNeeded; i++) {
      history.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `Turn ${i}: this is some content to make the history non-trivial and ensure the auto-compactor has enough token mass to evaluate. `.repeat(repeatsPerTurn) });
    }
    const plan = await maybeCompactHistory({ history, newUserText: 'follow-up question', sessionId: null, agentName: 'memory-check' });
    if (!config.compaction.enabled) {
      record('maybeCompactHistory', 'SKIP', 'COMPACT_ENABLED=false');
    } else if (!plan) {
      record('maybeCompactHistory', 'WARN', `${turnsNeeded}-turn history did not trigger — estimated tokens below threshold (ratio mode may need longer text)`);
    } else {
      record('maybeCompactHistory', 'PASS', `[${plan.from}..${plan.to}] reclaimed ~${plan.tokensReclaimed} tokens; remaining ~${plan.tokensRemaining}`);
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
