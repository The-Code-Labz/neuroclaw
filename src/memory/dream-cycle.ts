// Dream Cycle (v1.6) — nightly memory consolidation / "washing system".
//
// Pipeline:
//   1. Gather: sessions / messages / memory_index / tasks / agent_messages
//      from the last DREAM_LOOKBACK_HOURS.
//   2. Per-session LLM analysis → { decisions, patterns, procedures, insights }.
//   3. Memory transformation: episodic → semantic when recurring; episodic →
//      procedural when recurring 3+ times; bump salience for recurring concepts.
//   4. Semantic dedupe: token Jaccard on title+summary; merge instead of discard.
//   5. Prune: low-importance, non-recurring, stale, local-only rows.
//   6. Next-day plan LLM call from aggregated outputs.
//   7. Vault writes are inline via writeVaultNoteTool (subject to per-session and
//      per-hour caps — over-cap rows stay in SQLite).
//   8. Hive Mind logs at every meaningful step.
//
// Entry points:
//   - runDreamCycle()           manual trigger; called by POST /api/dream/run.
//   - startDreamScheduler()     called from dashboard server boot. No-op if
//                               DREAM_ENABLED=false. Schedules at DREAM_RUN_TIME.
//
// Cleanly degrades to SQLite-only when MCP_ENABLED is false (writeVaultNoteTool
// already handles that case — vault mirror is skipped, local index still works).

import { config } from '../config';
import { getDb } from '../db';
import { logger } from '../utils/logger';
import { logHive } from '../system/hive-mind';
import { getClient } from '../agent/openai-client';
import {
  indexMemory, listMemoryIndex, attachVaultNote, type MemoryIndexRow,
} from './memory-service';
import { writeVaultNoteTool } from './memory-tools';
import { initialSalience, clamp01 } from './memory-scorer';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DreamCycleResult {
  ok:          boolean;
  startedAt:   string;
  completedAt: string;
  durationMs:  number;
  scope: {
    sessionsAnalyzed: number;
    messagesScanned:  number;
    memoriesScanned:  number;
    tasksScanned:     number;
    commsScanned:     number;
  };
  output: {
    decisionsExtracted: number;
    patternsDetected:   number;
    proceduresCreated:  number;
    insightsCreated:    number;
    plansCreated:       number;
    memoriesPromoted:   number;
    memoriesMerged:     number;
    memoriesPruned:     number;
  };
  vaultPaths: {
    procedures: string[];
    insights:   string[];
    log:        string | null;
    plan:       string | null;
  };
  errors: string[];
}

interface SessionRow { id: string; title: string | null; created_at: string }
interface MessageRow { session_id: string; role: string; content: string; agent_id: string | null; created_at: string }
interface AnalysisOut {
  decisions:  string[];
  patterns:   string[];
  procedures: { title: string; body: string; tags?: string[] }[];
  insights:   { title: string; body: string; tags?: string[] }[];
}

const SAFE_DEFAULT_ANALYSIS: AnalysisOut = { decisions: [], patterns: [], procedures: [], insights: [] };

// ── Step 1: gather ──────────────────────────────────────────────────────────

interface GatherBundle {
  sessions: SessionRow[];
  messagesBySession: Map<string, MessageRow[]>;
  memories: MemoryIndexRow[];
  tasks: { id: string; title: string; status: string; agent_id: string | null; created_at: string }[];
  comms: { from_name: string; to_name: string; content: string; response: string | null; created_at: string }[];
}

function gather(lookbackHours: number): GatherBundle {
  const db = getDb();
  const cutoff = `datetime('now', '-${Math.max(1, Math.floor(lookbackHours))} hours')`;

  const sessions = db.prepare(`
    SELECT id, title, created_at FROM sessions
    WHERE updated_at > ${cutoff} OR created_at > ${cutoff}
    ORDER BY updated_at DESC
  `).all() as SessionRow[];

  const messagesBySession = new Map<string, MessageRow[]>();
  if (sessions.length > 0) {
    const placeholders = sessions.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT session_id, role, content, agent_id, created_at
      FROM messages
      WHERE session_id IN (${placeholders})
      ORDER BY created_at ASC
    `).all(...sessions.map(s => s.id)) as MessageRow[];
    for (const r of rows) {
      const arr = messagesBySession.get(r.session_id) ?? [];
      arr.push(r);
      messagesBySession.set(r.session_id, arr);
    }
  }

  const memories = db.prepare(`
    SELECT * FROM memory_index
    WHERE created_at > ${cutoff} OR last_accessed > ${cutoff}
    ORDER BY created_at DESC
  `).all() as MemoryIndexRow[];

  const tasks = db.prepare(`
    SELECT id, title, status, agent_id, created_at FROM tasks
    WHERE created_at > ${cutoff} OR updated_at > ${cutoff}
    ORDER BY created_at DESC
  `).all() as GatherBundle['tasks'];

  const comms = db.prepare(`
    SELECT from_name, to_name, content, response, created_at FROM agent_messages
    WHERE created_at > ${cutoff}
    ORDER BY created_at DESC
  `).all() as GatherBundle['comms'];

  return { sessions, messagesBySession, memories, tasks, comms };
}

// ── Step 2: per-session LLM analysis ────────────────────────────────────────

const ANALYSIS_SYSTEM = `You are the nightly memory consolidator for an AI agent system.

Read a single chat session's transcript and extract:
- decisions      = explicit choices the user or agents made (arrays of short strings)
- patterns       = recurring problems / themes / behaviors (arrays of short strings)
- procedures     = step-by-step how-tos worth saving as reusable rules (each is { title, body, tags? })
- insights       = meta-observations / heuristics worth saving (each is { title, body, tags? })

Be selective. Drop noise. If the session was just chitchat or had no durable value, return empty arrays for everything.

Output ONE JSON object exactly matching:
{
  "decisions": [string],
  "patterns": [string],
  "procedures": [{ "title": string, "body": string, "tags": [string] }],
  "insights":   [{ "title": string, "body": string, "tags": [string] }]
}

Respond with ONLY the JSON. No prose, no code fences.`;

async function analyzeSession(session: SessionRow, msgs: MessageRow[]): Promise<AnalysisOut> {
  if (msgs.length < 2) return SAFE_DEFAULT_ANALYSIS;
  const transcript = msgs
    .map(m => `[${m.role}${m.agent_id ? ' · ' + m.agent_id.slice(0, 8) : ''}] ${m.content}`)
    .join('\n\n')
    .slice(0, 16000);

  const model = config.dream.model ?? config.memory.extractModel ?? config.voidai.model;
  try {
    const resp = await getClient().chat.completions.create({
      model,
      max_tokens:      1200,
      temperature:     0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM },
        { role: 'user',   content: `Session: ${session.title ?? session.id}\n\n${transcript}` },
      ],
    });
    const raw = resp.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw) as Partial<AnalysisOut>;
    return {
      decisions:  Array.isArray(parsed.decisions)  ? parsed.decisions.slice(0, 20).map(String)  : [],
      patterns:   Array.isArray(parsed.patterns)   ? parsed.patterns.slice(0, 20).map(String)   : [],
      procedures: Array.isArray(parsed.procedures) ? parsed.procedures.slice(0, 10).filter(p => p && typeof p === 'object').map(p => ({ title: String(p.title ?? '').slice(0, 120), body: String(p.body ?? '').slice(0, 4000), tags: Array.isArray(p.tags) ? p.tags.slice(0, 6).map(String) : [] })).filter(p => p.title && p.body) : [],
      insights:   Array.isArray(parsed.insights)   ? parsed.insights.slice(0, 10).filter(p => p && typeof p === 'object').map(p => ({ title: String(p.title ?? '').slice(0, 120), body: String(p.body ?? '').slice(0, 4000), tags: Array.isArray(p.tags) ? p.tags.slice(0, 6).map(String) : [] })).filter(p => p.title && p.body) : [],
    };
  } catch (err) {
    logger.warn('dream-cycle: session analysis failed', { sessionId: session.id, error: (err as Error).message });
    return SAFE_DEFAULT_ANALYSIS;
  }
}

// ── Step 3: transformation (episodic → semantic / procedural; bump salience) ─

function tokenize(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 60));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface TransformStats { promoted: number; bumped: number }

function transform(memories: MemoryIndexRow[]): TransformStats {
  const db = getDb();
  let promoted = 0;
  let bumped   = 0;

  // Group episodic memories by signature; promote ones with 3+ occurrences.
  const episodics = memories.filter(m => m.type === 'episodic');
  const groups = new Map<string, MemoryIndexRow[]>();
  for (const m of episodics) {
    const sig = Array.from(tokenize(m.title + ' ' + (m.summary ?? ''))).sort().join(' ').slice(0, 80);
    if (!sig) continue;
    const arr = groups.get(sig) ?? [];
    arr.push(m);
    groups.set(sig, arr);
  }
  const upd = db.prepare('UPDATE memory_index SET type = ?, salience = ? WHERE id = ?');
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const newType = group.length >= 3 ? 'procedural' : 'semantic';
    const head = group[0];
    const newSalience = clamp01((head.salience ?? 0) + 0.1 * group.length);
    upd.run(newType, newSalience, head.id);
    promoted++;
    // Mark the rest as merged-into (we keep them but raise salience too — they still happened)
    const bump = db.prepare('UPDATE memory_index SET salience = MIN(1.0, COALESCE(salience, 0) + 0.05) WHERE id = ?');
    for (const sib of group.slice(1)) { bump.run(sib.id); bumped++; }
  }
  return { promoted, bumped };
}

// ── Step 4: semantic dedupe ─────────────────────────────────────────────────

interface DedupStats { merged: number }

function dedupe(memories: MemoryIndexRow[]): DedupStats {
  const db = getDb();
  // Only consider locally-stored rows that are NOT vault-mirrored — never delete vault-anchored memory here.
  const candidates = memories
    .filter(m => !m.vault_note_id)
    .map(m => ({ row: m, tokens: tokenize(m.title + ' ' + (m.summary ?? '')) }));

  const merged: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (merged.includes(a.row.id)) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (merged.includes(b.row.id)) continue;
      if (a.row.type !== b.row.type) continue;
      if (jaccard(a.tokens, b.tokens) < 0.65) continue;
      // Keep the row with higher (salience+importance); merge other into it.
      const aScore = (a.row.salience ?? 0) + (a.row.importance ?? 0);
      const bScore = (b.row.salience ?? 0) + (b.row.importance ?? 0);
      const keep = aScore >= bScore ? a : b;
      const drop = keep === a ? b : a;
      const newSalience = clamp01((keep.row.salience ?? 0) + 0.05);
      db.prepare('UPDATE memory_index SET salience = ? WHERE id = ?').run(newSalience, keep.row.id);
      db.prepare('DELETE FROM memory_index WHERE id = ?').run(drop.row.id);
      merged.push(drop.row.id);
    }
  }
  return { merged: merged.length };
}

// ── Step 5: prune ───────────────────────────────────────────────────────────

interface PruneStats { pruned: number }

function prune(): PruneStats {
  // Conservative: only delete rows that are
  //   (a) NOT in vault (no vault_note_id)
  //   (b) low importance (< 0.4)
  //   (c) low salience (< 0.2)
  //   (d) stale: created > 7d ago, last_accessed null or > 7d ago
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM memory_index
    WHERE vault_note_id IS NULL
      AND importance < 0.4
      AND salience   < 0.2
      AND created_at < datetime('now', '-7 days')
      AND (last_accessed IS NULL OR last_accessed < datetime('now', '-7 days'))
  `).run();
  return { pruned: result.changes };
}

// ── Step 6: next-day plan ───────────────────────────────────────────────────

const PLAN_SYSTEM = `You are NeuroClaw's nightly planner. From today's aggregated decisions, patterns, procedures, insights, and unresolved tasks, produce a focused plan for tomorrow.

Output a single JSON object:
{
  "title":  string,                 // short, punchy
  "summary": string,                // 2-3 sentences
  "priorities": [string],           // 3-7 high-leverage items for tomorrow
  "tasks": [{ "title": string, "rationale": string }],
  "unresolved": [string],           // open questions / blockers carried over
  "optimizations": [string]         // workflow / system improvements observed
}

Respond with ONLY the JSON. No prose, no code fences.`;

interface PlanOut {
  title:         string;
  summary:       string;
  priorities:    string[];
  tasks:         { title: string; rationale: string }[];
  unresolved:    string[];
  optimizations: string[];
}

async function generatePlan(input: { decisions: string[]; patterns: string[]; procedures: string[]; insights: string[]; openTasks: string[] }): Promise<PlanOut | null> {
  const model = config.dream.model ?? config.memory.extractModel ?? config.voidai.model;
  const userMsg = JSON.stringify(input, null, 2);
  try {
    const resp = await getClient().chat.completions.create({
      model,
      max_tokens:      900,
      temperature:     0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PLAN_SYSTEM },
        { role: 'user',   content: userMsg },
      ],
    });
    const raw = resp.choices[0]?.message?.content ?? '';
    const p = JSON.parse(raw) as Partial<PlanOut>;
    return {
      title:         String(p.title   ?? `Plan — ${new Date().toISOString().slice(0, 10)}`).slice(0, 120),
      summary:       String(p.summary ?? '').slice(0, 600),
      priorities:    Array.isArray(p.priorities)    ? p.priorities.slice(0, 12).map(String) : [],
      tasks:         Array.isArray(p.tasks)         ? p.tasks.slice(0, 12).filter(t => t && typeof t === 'object').map(t => ({ title: String(t.title ?? '').slice(0, 200), rationale: String(t.rationale ?? '').slice(0, 400) })).filter(t => t.title) : [],
      unresolved:    Array.isArray(p.unresolved)    ? p.unresolved.slice(0, 12).map(String) : [],
      optimizations: Array.isArray(p.optimizations) ? p.optimizations.slice(0, 12).map(String) : [],
    };
  } catch (err) {
    logger.warn('dream-cycle: plan generation failed', { error: (err as Error).message });
    return null;
  }
}

function formatPlanBody(p: PlanOut): string {
  const lines: string[] = [];
  lines.push(p.summary, '');
  if (p.priorities.length)   { lines.push('## Priorities'); for (const x of p.priorities) lines.push(`- ${x}`); lines.push(''); }
  if (p.tasks.length)        { lines.push('## Suggested tasks'); for (const t of p.tasks) lines.push(`- **${t.title}** — ${t.rationale}`); lines.push(''); }
  if (p.unresolved.length)   { lines.push('## Unresolved'); for (const x of p.unresolved) lines.push(`- ${x}`); lines.push(''); }
  if (p.optimizations.length){ lines.push('## Optimizations'); for (const x of p.optimizations) lines.push(`- ${x}`); lines.push(''); }
  return lines.join('\n').trimEnd() + '\n';
}

// ── Daily log summary ───────────────────────────────────────────────────────

function formatDailyLog(scope: DreamCycleResult['scope'], output: DreamCycleResult['output']): string {
  return [
    `Sessions analyzed: ${scope.sessionsAnalyzed}`,
    `Messages scanned: ${scope.messagesScanned}`,
    `Memories scanned: ${scope.memoriesScanned}`,
    `Tasks scanned: ${scope.tasksScanned}`,
    `Comms scanned: ${scope.commsScanned}`,
    '',
    `Decisions extracted: ${output.decisionsExtracted}`,
    `Patterns detected: ${output.patternsDetected}`,
    `Procedures created: ${output.proceduresCreated}`,
    `Insights created: ${output.insightsCreated}`,
    `Memories promoted (episodic→semantic/procedural): ${output.memoriesPromoted}`,
    `Memories merged (semantic dedupe): ${output.memoriesMerged}`,
    `Memories pruned: ${output.memoriesPruned}`,
    `Plans created: ${output.plansCreated}`,
  ].join('\n');
}

// ── Public entry ────────────────────────────────────────────────────────────

let running = false;

export async function runDreamCycle(): Promise<DreamCycleResult> {
  if (running) {
    return {
      ok: false,
      startedAt:   new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs:  0,
      scope:  { sessionsAnalyzed: 0, messagesScanned: 0, memoriesScanned: 0, tasksScanned: 0, commsScanned: 0 },
      output: { decisionsExtracted: 0, patternsDetected: 0, proceduresCreated: 0, insightsCreated: 0, plansCreated: 0, memoriesPromoted: 0, memoriesMerged: 0, memoriesPruned: 0 },
      vaultPaths: { procedures: [], insights: [], log: null, plan: null },
      errors: ['dream cycle is already running'],
    };
  }
  running = true;

  const startedAt = new Date().toISOString();
  const tStart = Date.now();
  const errors: string[] = [];
  const result: DreamCycleResult = {
    ok: true, startedAt, completedAt: '', durationMs: 0,
    scope:  { sessionsAnalyzed: 0, messagesScanned: 0, memoriesScanned: 0, tasksScanned: 0, commsScanned: 0 },
    output: { decisionsExtracted: 0, patternsDetected: 0, proceduresCreated: 0, insightsCreated: 0, plansCreated: 0, memoriesPromoted: 0, memoriesMerged: 0, memoriesPruned: 0 },
    vaultPaths: { procedures: [], insights: [], log: null, plan: null },
    errors,
  };

  try { logHive('dream_cycle_start', `Dream cycle started (lookback ${config.dream.lookbackHours}h)`); } catch { /* best-effort */ }
  logger.info('dream-cycle: starting', { lookbackHours: config.dream.lookbackHours });

  try {
    // ── Step 1: gather ─────────────────────────────────────────────
    const bundle = gather(config.dream.lookbackHours);
    let totalMessages = 0;
    for (const arr of bundle.messagesBySession.values()) totalMessages += arr.length;
    result.scope.sessionsAnalyzed = bundle.sessions.length;
    result.scope.messagesScanned  = totalMessages;
    result.scope.memoriesScanned  = bundle.memories.length;
    result.scope.tasksScanned     = bundle.tasks.length;
    result.scope.commsScanned     = bundle.comms.length;

    // ── Step 2: per-session analysis ───────────────────────────────
    const aggDecisions: string[] = [];
    const aggPatterns:  string[] = [];
    const aggProcedures: { title: string; body: string; tags?: string[] }[] = [];
    const aggInsights:   { title: string; body: string; tags?: string[] }[] = [];
    for (const s of bundle.sessions) {
      const msgs = bundle.messagesBySession.get(s.id) ?? [];
      const a = await analyzeSession(s, msgs);
      aggDecisions.push(...a.decisions);
      aggPatterns.push(...a.patterns);
      aggProcedures.push(...a.procedures);
      aggInsights.push(...a.insights);
    }
    result.output.decisionsExtracted = aggDecisions.length;
    result.output.patternsDetected   = aggPatterns.length;

    // ── Step 7 (inline write): procedures ──────────────────────────
    let createdCount = 0;
    for (const p of aggProcedures) {
      try {
        const w = await writeVaultNoteTool({
          title:      p.title,
          type:       'procedural',
          summary:    p.body.slice(0, 240),
          content:    p.body,
          tags:       (p.tags ?? []).concat(['dream-cycle']),
          importance: 0.75,
          agent_name: 'dream-cycle',
        });
        if (w.ok) {
          createdCount++;
          result.output.proceduresCreated++;
          if (w.vault_path) result.vaultPaths.procedures.push(w.vault_path);
        }
      } catch (err) {
        errors.push(`procedure write "${p.title}": ${(err as Error).message}`);
      }
    }
    if (createdCount > 0) try { logHive('procedures_created', `${createdCount} procedure(s) extracted`, undefined, { count: createdCount }); } catch { /* best-effort */ }

    let insightCreatedCount = 0;
    for (const i of aggInsights) {
      try {
        const w = await writeVaultNoteTool({
          title:      i.title,
          type:       'insight',
          summary:    i.body.slice(0, 240),
          content:    i.body,
          tags:       (i.tags ?? []).concat(['dream-cycle']),
          importance: 0.7,
          agent_name: 'dream-cycle',
        });
        if (w.ok) {
          insightCreatedCount++;
          result.output.insightsCreated++;
          if (w.vault_path) result.vaultPaths.insights.push(w.vault_path);
        }
      } catch (err) {
        errors.push(`insight write "${i.title}": ${(err as Error).message}`);
      }
    }
    if (createdCount + insightCreatedCount > 0) {
      try { logHive('memories_created', `${createdCount + insightCreatedCount} memories created from analysis`, undefined, { procedures: createdCount, insights: insightCreatedCount }); } catch { /* best-effort */ }
    }

    // Re-fetch memories after the writes so transform/dedupe see the new rows.
    const refreshed = listMemoryIndex({ limit: 1000 });

    // ── Step 3: transformation ─────────────────────────────────────
    const trans = transform(refreshed);
    result.output.memoriesPromoted = trans.promoted;
    if (trans.promoted > 0) try { logHive('memories_promoted', `${trans.promoted} memories promoted (episodic → semantic/procedural)`, undefined, trans); } catch { /* best-effort */ }

    // ── Step 4: dedupe ─────────────────────────────────────────────
    const refreshedAfterTransform = listMemoryIndex({ limit: 1000 });
    const dedup = dedupe(refreshedAfterTransform);
    result.output.memoriesMerged = dedup.merged;
    if (dedup.merged > 0) try { logHive('memories_merged', `${dedup.merged} duplicate memories merged (semantic Jaccard)`, undefined, dedup); } catch { /* best-effort */ }

    // ── Step 5: prune ──────────────────────────────────────────────
    const pr = prune();
    result.output.memoriesPruned = pr.pruned;
    if (pr.pruned > 0) try { logHive('memories_pruned', `${pr.pruned} stale low-importance local memories pruned`, undefined, pr); } catch { /* best-effort */ }

    // ── Step 6: next-day plan ──────────────────────────────────────
    const openTasks = bundle.tasks.filter(t => t.status === 'todo' || t.status === 'doing').map(t => t.title);
    const plan = await generatePlan({
      decisions:  aggDecisions,
      patterns:   aggPatterns,
      procedures: aggProcedures.map(p => p.title),
      insights:   aggInsights.map(i => i.title),
      openTasks,
    });
    if (plan) {
      try {
        const w = await writeVaultNoteTool({
          title:      plan.title,
          type:       'plan',
          summary:    plan.summary,
          content:    formatPlanBody(plan),
          tags:       ['dream-cycle', 'plan', 'next-day'],
          importance: 0.65,
          agent_name: 'dream-cycle',
        });
        if (w.ok) {
          result.output.plansCreated = 1;
          if (w.vault_path) result.vaultPaths.plan = w.vault_path;
          try { logHive('plan_created', `Next-day plan: ${plan.title}`, undefined, { vault_path: w.vault_path, priorities: plan.priorities.length, tasks: plan.tasks.length }); } catch { /* best-effort */ }
        }
      } catch (err) {
        errors.push(`plan write: ${(err as Error).message}`);
      }
    }

    // ── Step 7 finalize: daily log summary ─────────────────────────
    try {
      const logBody = formatDailyLog(result.scope, result.output);
      const w = await writeVaultNoteTool({
        title:      `Dream cycle — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        type:       'session_summary',
        summary:    `Consolidated ${result.scope.sessionsAnalyzed} session(s); created ${result.output.proceduresCreated} procedures, ${result.output.insightsCreated} insights, ${result.output.plansCreated} plans.`,
        content:    logBody,
        tags:       ['dream-cycle', 'daily-log'],
        importance: 0.55,
        agent_name: 'dream-cycle',
      });
      if (w.ok && w.vault_path) result.vaultPaths.log = w.vault_path;
    } catch (err) {
      errors.push(`daily log write: ${(err as Error).message}`);
    }

    // ── Step 8: completion log ─────────────────────────────────────
    result.completedAt = new Date().toISOString();
    result.durationMs  = Date.now() - tStart;
    try { logHive('dream_cycle_complete', `Dream cycle complete (${result.durationMs}ms)`, undefined, result); } catch { /* best-effort */ }
    logger.info('dream-cycle: complete', {
      durationMs:        result.durationMs,
      sessionsAnalyzed:  result.scope.sessionsAnalyzed,
      proceduresCreated: result.output.proceduresCreated,
      insightsCreated:   result.output.insightsCreated,
      memoriesPromoted:  result.output.memoriesPromoted,
      memoriesMerged:    result.output.memoriesMerged,
      memoriesPruned:    result.output.memoriesPruned,
      plansCreated:      result.output.plansCreated,
    });
    void attachVaultNote; void initialSalience; void indexMemory; // keep imports intentional for future expansion
    return result;
  } catch (err) {
    result.ok = false;
    result.completedAt = new Date().toISOString();
    result.durationMs  = Date.now() - tStart;
    errors.push((err as Error).message);
    try { logHive('dream_cycle_failed', `Dream cycle failed: ${(err as Error).message}`); } catch { /* best-effort */ }
    logger.error('dream-cycle: failed', { error: (err as Error).message });
    return result;
  } finally {
    running = false;
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

function msUntilNext(timeOfDay: string): number {
  const m = timeOfDay.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 24 * 3_600_000;
  const hour = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const min  = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  const now  = new Date();
  const next = new Date(now);
  next.setHours(hour, min, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNext(): void {
  const ms = msUntilNext(config.dream.runTime);
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    try { await runDreamCycle(); }
    catch (err) { logger.warn('dream-cycle: scheduled run threw', { error: (err as Error).message }); }
    scheduleNext();
  }, ms);
  logger.info('dream-cycle: scheduled next run', {
    runTime: config.dream.runTime,
    inMinutes: Math.round(ms / 60000),
  });
}

export function startDreamScheduler(): void {
  if (!config.dream.enabled) {
    logger.info('Dream cycle: disabled (DREAM_ENABLED=false)');
    return;
  }
  scheduleNext();
}

export function stopDreamScheduler(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
