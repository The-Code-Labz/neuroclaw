// Universal tool-output compression middleware (spec 2026-07-10 / Phase 1).
// Sits at the single tool-result boundary reached through `invokeTool`
// (registry.ts), so one implementation covers all 3 adapters (OpenAI plane,
// Claude SDK plane, HTTP MCP) and therefore every provider and both agent +
// chat mode.
//
// THE CRITICAL GUARD: retrieval-class results (memory, KB, uploads, vision) are
// NEVER compressed. Blind compression of a recalled memory is the exact "why did
// it forget what I just told it" regression. Exemption is hybrid:
//   - static tool name denylist (below)
//   - ToolDef.category === 'retrieval'
//   - dynamic tool classes (agent__*, mcp__*, COMPOSIO_*) — exempt BY DEFAULT
//
// Compression is a stateless pure function (Node single-threaded; no shared
// mutable state beyond the telemetry counter), so there is no concurrency risk.

import { config } from '../config';
import { logger } from '../utils/logger';
import { logToolCall } from '../system/hive-mind';
import { getAgentById } from '../db';
import type { ToolContext } from './context';
import {
  liteCompressString,
  headroomCompressString,
  mapStringLeaves,
} from './compression-engines';
import { recordCompressionTelemetry } from './compression-telemetry';
import {
  classifyOutcome,
  isRetrySafe,
  parseRetryAfterMs,
  type ToolCategory,
  type ToolOutcome,
} from './tool-result-class';
import { onToolFailed } from '../system/self-heal/heal-loop';
import { checkSpendBreaker, releaseSpendBreaker, estimateCost } from '../infra/spend-breaker';

export { ToolCategory } from './tool-result-class';

// ── Retry tuning ───────────────────────────────────────────────────────────
const MAX_RETRY_ATTEMPTS = Math.max(1, parseInt(process.env.TOOL_RETRY_MAX_ATTEMPTS ?? '3', 10));
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];
const RETRY_JITTER_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── Exemption ──────────────────────────────────────────────────────────────

/** Static registry tools whose output is signal, not noise. Results pass
 *  through byte-identical. Superset of every retrieval / recall / upload /
 *  vision tool in the registry as of the spec date. */
export const COMPRESSION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  // memory / vault
  'search_memory',
  'write_vault_note',
  // knowledge base
  'search_knowledge_base',
  'list_knowledge_sources',
  // uploaded documents
  'search_document',
  'get_attachment',
  'get_attachment_parsed',
  'list_attachments',
  'list_uploads',
  'get_upload',
  // vision (descriptions are signal)
  'analyze_image',
  // notebook RAG
  'notebook_ask',
  'notebook_create',
  'notebook_add_source',
  'notebook_source_list',
]);

/**
 * Is this tool result exempt from compression? Over-protection is the safe
 * direction — when unsure, exempt.
 */
export function isCompressionExempt(name: string, category?: ToolCategory): boolean {
  if (category === 'retrieval') return true;
  if (COMPRESSION_EXEMPT_TOOLS.has(name)) return true;
  // Dynamic tool classes whose names aren't enumerable at build time. A
  // Composio Notion/Drive search, an MCP-backed RAG agent (agent__Jibril), or
  // an mcp__<server>__search are all retrieval-shaped. Exempt by default until a
  // specific pattern is explicitly vetted and opted IN.
  if (name.startsWith('COMPOSIO_')) return true;
  if (name.startsWith('agent__'))   return true;
  if (name.startsWith('mcp__'))     return true;
  return false;
}

// ── Engine resolution (global default + per-agent override) ──────────────────

interface CompressionOptions {
  lite: boolean;
  headroom: boolean;
  rtk: boolean;
}

function resolveCompressionOptions(ctx: ToolContext): CompressionOptions | null {
  const globalLite = config.optimize.engines.lite;
  const globalHeadroom = config.optimize.engines.headroom;
  const globalRtk = config.tokenOpt.toolCompression;
  if (!globalLite && !globalHeadroom && !globalRtk) return null;

  const agent = ctx.agentId ? getAgentById(ctx.agentId) : null;
  const lite     = agent?.compress_lite     !== null && agent?.compress_lite     !== undefined
                   ? !!agent.compress_lite
                   : globalLite;
  const headroom = agent?.compress_headroom !== null && agent?.compress_headroom !== undefined
                   ? !!agent.compress_headroom
                   : globalHeadroom;
  const rtk      = agent?.compress_rtk      !== null && agent?.compress_rtk      !== undefined
                   ? !!agent.compress_rtk
                   : globalRtk;

  if (!lite && !headroom && !rtk) return null;
  return { lite, headroom, rtk };
}

// ── Measurement helper ───────────────────────────────────────────────────────

function measureBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

// ── Engine: Lite (whitespace/format normalize) ───────────────────────────────

function applyLite(value: unknown): unknown {
  return mapStringLeaves(value, liteCompressString);
}

// ── Engine: Headroom (JSON/tabular compaction) ───────────────────────────────

function applyHeadroom(value: unknown): unknown {
  return mapStringLeaves(value, headroomCompressString);
}

// ── Engine: rtk (existing text compression) ──────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

const KEEP_VERBATIM_RE = new RegExp(
  [
    'error', 'warn', 'fail', 'panic', 'exception', 'fatal', 'traceback',
    'assert', 'abort', 'denied', 'refused',
    'enoent', 'eacces', 'econn',
    // stack-trace continuation shapes (no keyword of their own)
    '\\bat\\s', 'file\\s+"', 'line\\s+\\d+',
    // non-zero exit annotations / HTTP 4xx-5xx status lines
    'exit\\s*code\\s*[1-9]', 'exited\\s+with', '\\b[45]\\d{2}\\b',
  ].join('|'),
  'i',
);

function isKeepLine(line: string): boolean {
  return KEEP_VERBATIM_RE.test(line);
}

/**
 * Compress a single noisy text block. Pure function.
 * Rules: strip ANSI + CR-redraw noise → collapse consecutive duplicate lines →
 * truncate long homogeneous runs (head+tail) while protecting ±N lines around
 * diagnostic lines → final byte-cap backstop preserving the tail.
 */
export function compressText(input: string): string {
  const minBytes = config.tokenOpt.compressionMinBytes;
  if (Buffer.byteLength(input) <= minBytes) return input;

  // 1. strip ANSI escapes
  let text = input.replace(ANSI_RE, '');
  // 2. collapse carriage-return redraws — keep only the final segment per line
  text = text
    .split('\n')
    .map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l))
    .join('\n');

  const lines = text.split('\n');
  const ctxN = config.tokenOpt.keepVerbatimContext;

  // Mark lines that must survive (diagnostics ± context window)
  const protectedIdx = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (isKeepLine(lines[i])) {
      for (let j = Math.max(0, i - ctxN); j <= Math.min(lines.length - 1, i + ctxN); j++) {
        protectedIdx.add(j);
      }
    }
  }

  // 3. collapse consecutive duplicate lines
  const deduped: string[] = [];
  const dedupProtected: boolean[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = deduped.length - 1;
    if (prev >= 0 && stripCount(deduped[prev]) === line) {
      deduped[prev] = `${line}  (×${dupCount(deduped[prev]) + 1})`;
      dedupProtected[prev] = dedupProtected[prev] || protectedIdx.has(i);
    } else {
      deduped.push(line);
      dedupProtected.push(protectedIdx.has(i));
    }
  }

  // 4. truncate long homogeneous UNPROTECTED runs to head + tail
  const HOMOGENEOUS_THRESHOLD = 40; // a run longer than this gets elided
  const HEAD = 8;
  const TAIL = 8;
  const out: string[] = [];
  let i = 0;
  while (i < deduped.length) {
    if (dedupProtected[i]) { out.push(deduped[i]); i++; continue; }
    // gather a maximal unprotected run
    let j = i;
    while (j < deduped.length && !dedupProtected[j]) j++;
    const run = deduped.slice(i, j);
    if (run.length > HOMOGENEOUS_THRESHOLD) {
      out.push(...run.slice(0, HEAD));
      out.push(`… <${run.length - HEAD - TAIL} lines omitted> …`);
      out.push(...run.slice(run.length - TAIL));
    } else {
      out.push(...run);
    }
    i = j;
  }

  let result = out.join('\n');

  // 5. final byte-cap backstop — overrides keep-verbatim if a protected block
  //    alone still blows the cap. Preserve the TAIL (errors surface last).
  const maxBytes = config.tokenOpt.compressionMaxBytes;
  if (Buffer.byteLength(result) > maxBytes) {
    const head = result.slice(0, Math.floor(maxBytes * 0.25));
    const tail = result.slice(result.length - Math.floor(maxBytes * 0.7));
    result = `${head}\n… <output truncated to byte cap> …\n${tail}`;
  }

  return result;
}

function dupCount(line: string): number {
  const m = line.match(/ {2}\(×(\d+)\)$/);
  return m ? parseInt(m[1], 10) : 1;
}
function stripCount(line: string): string {
  return line.replace(/ {2}\(×\d+\)$/, '');
}

// ── Result-tree compression (JSON-structure-safe) ────────────────────────────

const COMPRESS_STRING_MIN = 400; // only walk into strings worth compressing

/**
 * Walk a tool result and compress long string leaf values in place (structure
 * preserved — we never truncate the JSON envelope). Handles the common noisy
 * shapes: a bare string, or an object with stdout/stderr/html/text/content
 * fields. Returns a NEW value; input is not mutated.
 */
function compressResultTree(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') {
    return value.length >= COMPRESS_STRING_MIN ? compressText(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => compressResultTree(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = compressResultTree(v, depth + 1);
    }
    return out;
  }
  return value;
}

function applyRtk(value: unknown): unknown {
  return compressResultTree(value);
}

// ── Pipeline entry point ─────────────────────────────────────────────────────

/**
 * Apply compression to a tool result unless the tool is exempt or the layer is
 * disabled. Runs the ordered engine pipeline: Lite → Headroom → rtk. Records
 * per-engine byte telemetry. Safe on any result shape.
 */
export function maybeCompressToolResult(
  name: string,
  category: ToolCategory,
  result: unknown,
  ctx: ToolContext,
): unknown {
  if (isCompressionExempt(name, category)) {
    recordCompressionTelemetry('exempt', 0, 0);
    return result;
  }
  // Never touch error envelopes — they're already small and diagnostic.
  if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
    return result;
  }

  const opts = resolveCompressionOptions(ctx);
  if (!opts) return result;

  const bytesIn = measureBytes(result);
  const minBytes = config.tokenOpt.compressionMinBytes;
  if (bytesIn <= minBytes) return result;

  let value = result;

  if (opts.lite) {
    const next = applyLite(value);
    recordCompressionTelemetry('lite', bytesIn, measureBytes(next));
    value = next;
  }
  if (opts.headroom) {
    const before = measureBytes(value);
    const next = applyHeadroom(value);
    recordCompressionTelemetry('headroom', before, measureBytes(next));
    value = next;
  }
  if (opts.rtk) {
    const before = measureBytes(value);
    const next = applyRtk(value);
    recordCompressionTelemetry('rtk', before, measureBytes(next));
    value = next;
  }

  const bytesOut = measureBytes(value);
  if (bytesOut >= bytesIn) return result;

  if (bytesIn - bytesOut > 4000) {
    logger.debug('tool-compression: shrank result', { tool: name, bytesIn, bytesOut });
  }
  return value;
}

// ── Unified tool-call wrapper (Step 0 — single choke point) ──────────────────

/**
 * The one place every tool result flows through. All 4 adapter call sites
 * (claude-sdk, openai, http-mcp, meta-tools/call_tool) route here so that:
 *   1. the tool_call trace is emitted uniformly (closes the historical
 *      logToolCall-missing-at-http-mcp gap), and
 *   2. classification → retry → output compression + retrieval exemption are
 *      applied EXACTLY once, universally, for every provider and both agent +
 *      chat mode.
 *
 * `run` is the already-gated, already-validated handler invocation — this
 * wrapper deliberately does NOT re-gate or re-validate; each site owns its
 * own (differing) pre-flight. Keeping the wrapper narrow keeps blast radius low.
 *
 * Ordering (F8): classify → retry-loop-if-needed → maybeCompressToolResult ONCE
 * on the settled result.
 */
export async function invokeTool(params: {
  name: string;
  args: unknown;
  ctx: ToolContext;
  category?: ToolCategory;
  /** Emit the tool_call trace. Default true. Set false when the caller already
   *  logged (e.g. handleCallTool logs once before fanning out to 4 paths). */
  trace?: boolean;
  run: () => Promise<unknown>;
}): Promise<unknown> {
  if (params.trace !== false) {
    logToolCall(params.name, params.args, params.ctx);
  }

  const { name, category, ctx, run } = params;
  const userId = ctx.sessionId ?? ctx.agentId ?? 'anonymous';
  const retrySafe = isRetrySafe(name, category);
  const estCost = estimateCost(name);
  const maxAttempts = MAX_RETRY_ATTEMPTS;

  let lastResult: unknown;
  let lastError: unknown;
  let lastOutcome: ToolOutcome = 'success';
  let sawInternalRetry = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = undefined;
    lastError = undefined;
    let inFlightId: string | undefined;

    try {
      // Spend-breaker: count EACH attempt against the daily ceiling (F5).
      if (estCost > 0) {
        const gate = checkSpendBreaker({ userId, tool: name, estUsd: estCost });
        if (!gate.allowed) {
          lastOutcome = 'rate_limited';
          lastError = new Error(`Studio spend breaker: ${gate.reason ?? 'rate_limited'}`);
          break;
        }
        inFlightId = gate.inFlightId;
      }

      lastResult = await run();
      lastOutcome = classifyOutcome(lastResult);
      if (
        lastResult &&
        typeof lastResult === 'object' &&
        (lastResult as { retriedInternally?: boolean }).retriedInternally === true
      ) {
        sawInternalRetry = true;
      }

      if (lastOutcome === 'success') {
        if (inFlightId) releaseSpendBreaker(inFlightId);
        return maybeCompressToolResult(name, category, lastResult, ctx);
      }
    } catch (err) {
      lastError = err;
      lastOutcome = classifyOutcome(undefined, err);
      if (err && typeof err === 'object' && (err as { retriedInternally?: boolean }).retriedInternally === true) {
        sawInternalRetry = true;
      }
    } finally {
      if (inFlightId) releaseSpendBreaker(inFlightId);
    }

    // The provider helper already exhausted its own retry budget — do not stack
    // another 3 boundary attempts on top (F4).
    if (sawInternalRetry) {
      logger.info('tool-boundary: skipping retry — provider already retried internally', { tool: name, attempt });
      break;
    }

    // No more attempts.
    if (attempt >= maxAttempts) break;

    // Permanent failures and unsafe mutating transients are not retried.
    if (lastOutcome === 'permanent' || !retrySafe) break;

    // Spaced backoff: 30s → 60s → 120s + jitter. rate_limited honors Retry-After.
    let delayMs = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    if (lastOutcome === 'rate_limited') {
      const retryAfter = parseRetryAfterMs(lastError, lastResult);
      if (retryAfter !== undefined && retryAfter > 0) delayMs = retryAfter;
    }
    delayMs += Math.floor(Math.random() * RETRY_JITTER_MS);

    logger.warn('tool-boundary: retryable outcome, backing off', {
      tool: name, attempt, outcome: lastOutcome, retrySafe, delayMs,
    });
    await delay(delayMs);
  }

  // Settled failure: feed the tool phase into the self-heal storm-breaker.
  if (lastOutcome !== 'success') {
    const rawError =
      lastError instanceof Error
        ? lastError.message
        : lastResult && typeof lastResult === 'object'
          ? String((lastResult as { error?: string }).error ?? '')
          : String(lastError ?? '');
    const decision = onToolFailed({
      toolName: name,
      error: rawError || `${name} settled as ${lastOutcome}`,
      outcome: lastOutcome,
      runId: ctx.runId ?? undefined,
    });
    if (decision.suppress) {
      const suppressed = {
        ok: false,
        error: `Self-heal storm-breaker suppressed repeated ${lastOutcome} failures for ${name}. Try again shortly.`,
      };
      return maybeCompressToolResult(name, category, suppressed, ctx);
    }
  }

  if (lastError) throw lastError;
  return maybeCompressToolResult(name, category, lastResult, ctx);
}
