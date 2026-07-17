// Higgsfield MCP flow wrapper.
//
// Drives the submit → poll → resolve-URL pipeline over the Higgsfield MCP server
// using a Bearer access token from the token manager. Mirrors openart-client.ts:
//   - one-shot 401 retry (force-refresh the access token, evict the stale
//     Bearer-keyed MCP connection, retry once),
//   - a bounded poll loop over job_status(sync:true) that stays clear of the
//     420s MCP call-timeout wall.
//
// API contract (verified live 2026-07-16):
//   generate_{image,video,audio,3d}({ params: { model, prompt, count, aspect_ratio,
//     medias:[{value,role}], ...extra } })
//     → { results: [ { id, type, status:'pending', ... } ], adjustments }
//   job_status({ jobId, sync:true })   // sync polls internally up to ~25s
//     → { generation: { id, type, status:'completed'|'pending'|'failed'|'canceled',
//                       results: { rawUrl, minUrl }, params, createdAt } }
//
// The job id is results[i].id (one per requested sample). rawUrl is the full-res
// asset; minUrl is a webp thumbnail.

import { getHiggsfieldAccessToken, HIGGSFIELD_MCP_URL } from './higgsfield-auth';
import { logger } from '../utils/logger';

// NOTE: Higgsfield is driven with a DIRECT streamable-HTTP JSON-RPC client rather
// than the shared MCP SDK transport. The SDK's StreamableHTTPClientTransport hangs
// against this server (its persistent SSE GET stream never settles the call),
// whereas one-shot POSTs return in <1s. This client also reads the machine payload
// from `structuredContent` (Higgsfield puts only a prose summary in the text block).

// job_status(sync:true) blocks ~25s server-side per call. Image ~10-20s,
// video ~60-180s. 14 iters × ~25s ≈ up to ~350s — under the 420s MCP wall,
// with headroom for the slowest video model.
const POLL_MAX_ITERS = 14;
const TERMINAL_OK   = new Set(['completed', 'success', 'succeeded']);
const TERMINAL_FAIL = new Set(['failed', 'error', 'cancelled', 'canceled']);

const CALL_TIMEOUT_MS = parseInt(process.env.HIGGSFIELD_CALL_TIMEOUT_MS ?? '60000', 10);

/** Parse a streamable-HTTP response body: SSE frames (`data: {...}`) or plain JSON. */
function parseBody(text: string): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) { try { last = JSON.parse(t.slice(5).trim()); } catch { /* ignore */ } }
  }
  if (last) return last;
  try { return JSON.parse(text); } catch { return null; }
}

let rpcId = 1;

/** One JSON-RPC POST to the Higgsfield MCP endpoint. */
async function rpc(token: string, sid: string | null, body: Record<string, unknown>): Promise<{ json: Record<string, unknown> | null; sid: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
  };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const r = await fetch(HIGGSFIELD_MCP_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const newSid = r.headers.get('mcp-session-id') || sid;
  const text = await r.text();
  if (r.status === 401) { const e = new Error('unauthorized') as Error & { code?: number }; e.code = 401; throw e; }
  if (!r.ok) throw new Error(`Higgsfield MCP HTTP ${r.status}: ${text.slice(0, 200)}`);
  return { json: parseBody(text), sid: newSid };
}

/** Establish an initialized MCP session and return its session id. */
async function initSession(token: string): Promise<string | null> {
  const { sid } = await rpc(token, null, {
    jsonrpc: '2.0', id: rpcId++, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'neuroclaw', version: '1.0' } },
  });
  await rpc(token, sid, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  return sid;
}

/** Concatenate text blocks from an MCP content array. */
function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Extract the useful payload from a tools/call JSON-RPC result — preferring
 *  structuredContent (where Higgsfield puts the machine data). */
function extractResult(json: Record<string, unknown> | null, tool: string): unknown {
  if (!json) throw new Error(`Higgsfield ${tool}: empty response`);
  if (json.error) throw new Error(`Higgsfield ${tool} error: ${JSON.stringify(json.error).slice(0, 200)}`);
  const result = (json.result && typeof json.result === 'object') ? json.result as Record<string, unknown> : {};
  if (result.isError) throw new Error(`Higgsfield ${tool} returned error: ${extractContentText(result.content) || JSON.stringify(result).slice(0, 200)}`);
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const text = extractContentText(result.content);
  if (text) { try { return JSON.parse(text); } catch { return text; } }
  return result.content;
}

/** Call a Higgsfield MCP tool with a Bearer token, retrying ONCE on a 401 with a
 *  force-refreshed token + fresh session. Exported so peers (higgsfield-usage)
 *  reuse the exact token/retry dance. */
export async function higgsfieldCall(tool: string, input: Record<string, unknown>): Promise<unknown> {
  let token = await getHiggsfieldAccessToken();
  const run = async (t: string) => {
    const sid = await initSession(t);
    const { json } = await rpc(t, sid, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: input } });
    return extractResult(json, tool);
  };
  try {
    return await run(token);
  } catch (err) {
    const code = (err as { code?: number }).code;
    const msg = (err instanceof Error ? err.message : String(err));
    const is401 = code === 401 || /\b401\b|unauthorized|invalid_token/i.test(msg);
    if (!is401) throw err;
    token = await getHiggsfieldAccessToken(true);
    return await run(token);
  }
}

/** Normalize whatever higgsfieldCall hands back into an object. */
function asObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.text === 'string') { try { return JSON.parse(o.text); } catch { /* fall through */ } }
    return o;
  }
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { /* ignore */ } }
  return {};
}

function mimeFromUrl(url: string, type: string): string {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.png'))  return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif'))  return 'image/gif';
  if (clean.endsWith('.mp4'))  return 'video/mp4';
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.mov'))  return 'video/quicktime';
  if (clean.endsWith('.glb'))  return 'model/gltf-binary';
  if (clean.endsWith('.wav'))  return 'audio/wav';
  if (clean.endsWith('.mp3'))  return 'audio/mpeg';
  if (clean.endsWith('.ogg'))  return 'audio/ogg';
  // fall back by output type
  if (type === 'image') return 'image/png';
  if (type === 'video') return 'video/mp4';
  if (type === 'audio') return 'audio/wav';
  return 'application/octet-stream';
}

export interface HiggsfieldRunInput {
  type:         'image' | 'video' | 'audio' | '3d';
  prompt:       string;
  model:        string;
  aspectRatio?: string;
  count?:       number;
  /** Reference media: media_id from media_import_url/media_upload, or a prior job_id.
   *  NOT an https URL. Enables image-to-video / edit flows (phase 2). */
  medias?:      Array<{ value: string; role: string }>;
  /** Model-specific extras (resolution, voice_id, format, …). */
  extraParams?: Record<string, unknown>;
}

export interface HiggsfieldResult { url: string; mime: string; type: string; jobId: string }

/** Call a tool on an already-initialized session (avoids re-init per poll). */
async function callOnSession(token: string, sid: string | null, tool: string, input: Record<string, unknown>): Promise<unknown> {
  const { json } = await rpc(token, sid, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: input } });
  return extractResult(json, tool);
}

/** Poll one job to a terminal state and return its full-res URL. */
async function pollJob(token: string, sid: string | null, jobId: string, type: string): Promise<HiggsfieldResult> {
  for (let i = 0; i < POLL_MAX_ITERS; i++) {
    const st = asObject(await callOnSession(token, sid, 'job_status', { jobId, sync: true }));
    const gen = (st.generation && typeof st.generation === 'object')
      ? st.generation as Record<string, unknown>
      : st; // some shapes may return the generation at the top level
    const status = String((gen.status ?? '') as string).toLowerCase();
    if (TERMINAL_OK.has(status)) {
      const results = (gen.results && typeof gen.results === 'object') ? gen.results as Record<string, unknown> : {};
      const url = String(results.rawUrl ?? results.url ?? results.minUrl ?? '');
      if (!url) throw new Error(`Higgsfield job ${jobId} completed but returned no result URL`);
      return { url, mime: mimeFromUrl(url, type), type, jobId };
    }
    if (TERMINAL_FAIL.has(status)) {
      const reason = String((gen.error ?? gen.failure_reason ?? 'unknown') as string);
      throw new Error(`Higgsfield ${type} job failed: ${reason}`);
    }
    logger.info('higgsfield: job still running', { jobId, type, iter: i + 1, status });
  }
  throw new Error(`Higgsfield ${type} job is still running after the poll budget — try again shortly.`);
}

/** Submit one Higgsfield generation and poll each resulting job to a terminal
 *  state. Returns the full-res result URL(s), ready for gallery/Media delivery. */
export async function runHiggsfield(input: HiggsfieldRunInput): Promise<HiggsfieldResult[]> {
  const params: Record<string, unknown> = {
    model:  input.model,
    prompt: input.prompt,
    count:  input.count ?? 1,
  };
  if (input.aspectRatio) params.aspect_ratio = input.aspectRatio;
  if (input.medias && input.medias.length) params.medias = input.medias;
  if (input.extraParams) Object.assign(params, input.extraParams);

  // One session for submit + all polls (fresh token, one 401-retry).
  let token = await getHiggsfieldAccessToken();
  let sid: string | null;
  let submit: Record<string, unknown>;
  try {
    sid = await initSession(token);
    submit = asObject(await callOnSession(token, sid, `generate_${input.type}`, { params }));
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 401 && !/\b401\b|unauthorized/i.test((err as Error).message ?? '')) throw err;
    token = await getHiggsfieldAccessToken(true);
    sid = await initSession(token);
    submit = asObject(await callOnSession(token, sid, `generate_${input.type}`, { params }));
  }

  const results = Array.isArray(submit.results) ? submit.results as Array<Record<string, unknown>> : [];
  const jobIds = results.map(r => String(r.id ?? '')).filter(Boolean);
  if (jobIds.length === 0) {
    throw new Error(`Higgsfield submit returned no job id: ${JSON.stringify(submit).slice(0, 200)}`);
  }

  const out: HiggsfieldResult[] = [];
  for (const jobId of jobIds) out.push(await pollJob(token, sid, jobId, input.type));
  return out;
}

/** Import an https image URL into Higgsfield, returning its media_id — the
 *  reference form required by image-to-image (edit) generations. Higgsfield's
 *  `medias` param does NOT accept raw URLs; the source must be imported first.
 *  Verified live 2026-07-16: media_import_url({url}) → { media_id, type, ... }. */
export async function higgsfieldImportMedia(url: string): Promise<string> {
  const r = asObject(await higgsfieldCall('media_import_url', { url }));
  const mediaId = String(r.media_id ?? r.id ?? '');
  if (!mediaId) throw new Error(`Higgsfield media import returned no media_id: ${JSON.stringify(r).slice(0, 160)}`);
  return mediaId;
}

/** Preflight the credit cost of a generation without submitting (get_cost:true). */
export async function higgsfieldCost(type: string, model: string, prompt: string, extra?: Record<string, unknown>): Promise<number | null> {
  try {
    const r = asObject(await higgsfieldCall(`generate_${type}`, { params: { model, prompt, get_cost: true, ...extra } }));
    const cost = (r.cost && typeof r.cost === 'object') ? r.cost as Record<string, unknown> : {};
    const n = Number(cost.credits_exact ?? cost.credits);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
