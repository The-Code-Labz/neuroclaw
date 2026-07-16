// OpenArt MCP flow wrapper.
//
// Drives the model → generate → wait pipeline over the OpenArt MCP server using
// a Bearer access token from the token manager. Handles:
//   - one-shot 401 retry (force-refresh the access token, re-evict the stale
//     Bearer-keyed MCP connection, retry once),
//   - the edit (image2image) presigned-upload dance,
//   - a bounded poll loop that stays clear of the 300s MCP idle-timeout wall.

import { callTool, evictConnection } from '../mcp/mcp-client';
import { downloadBytes } from './media-jobs';
import { getOpenArtAccessToken, OPENART_MCP_URL } from './openart-auth';
import { logger } from '../utils/logger';

const ASPECT_ENUM = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];
const WAIT_SECONDS   = 45;   // per creation_wait call (max the API allows without STILL_RUNNING churn)
const WAIT_MAX_ITERS = 3;    // 3 × 45s ≈ 135s total — clear of the 300s MCP idle-timeout wall

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Call an OpenArt MCP tool with a Bearer token, retrying ONCE on a 401 with a
 *  force-refreshed token (and evicting the stale Bearer-keyed connection).
 *  Exported so peers (e.g. openart-usage) reuse the exact token/retry dance
 *  instead of re-implementing the fragile rotating-RT flow. */
export async function openartCall(tool: string, input: Record<string, unknown>): Promise<unknown> {
  let token = await getOpenArtAccessToken();
  try {
    return await callTool(OPENART_MCP_URL, tool, input, authHeader(token), 'http');
  } catch (err) {
    const code = (err as { code?: number }).code;
    const msg = (err instanceof Error ? err.message : String(err));
    const is401 = code === 401 || /\b401\b|unauthorized|invalid_token/i.test(msg);
    if (!is401) throw err;
    // Evict the connection cached under the (now-stale) Bearer, force a refresh,
    // and retry once under the fresh token.
    evictConnection(OPENART_MCP_URL, authHeader(token), 'http');
    token = await getOpenArtAccessToken(true);
    return await callTool(OPENART_MCP_URL, tool, input, authHeader(token), 'http');
  }
}

function normalizeAspect(ratio: string | undefined): string {
  const r = (ratio || '1:1').trim();
  return ASPECT_ENUM.includes(r) ? r : '1:1';
}

/** Cache of a model+mode's accepted param keys (from openart_model_form_get).
 *  Models declare `additionalProperties:false`, so a retry must only add params
 *  the form actually allows — else the server rejects the whole submit. */
const formKeysCache = new Map<string, Set<string>>();

async function getFormParamKeys(model: string, mode: string): Promise<Set<string>> {
  const key = `${model}:${mode}`;
  const hit = formKeysCache.get(key);
  if (hit) return hit;
  let keys = new Set<string>();
  try {
    const raw = await openartCall('openart_model_form_get', { model, mode });
    const obj = extractStatus(raw) as unknown as { jsonSchema?: { allOf?: Array<{ properties?: Record<string, unknown> }> } };
    const props = obj?.jsonSchema?.allOf?.[0]?.properties;
    if (props) keys = new Set(Object.keys(props));
  } catch (err) {
    logger.warn('openart: model_form_get failed (retry-enrichment skipped)', { model, mode, error: (err as Error).message });
  }
  formKeysCache.set(key, keys);
  return keys;
}

interface OpenArtResource { url?: string; mediaType?: string; metadata?: { format?: string } }

/** Extract the first balanced {...} JSON object from a string. OpenArt's MCP
 *  tools return a text block of `{json}\n<human prose>` — JSON.parse on the whole
 *  thing fails on the trailing prose, so we brace-match the leading object. */
function firstJsonObject(s: string): unknown | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Parse the creation_wait / generate result. callTool returns a parsed object
 *  when the text block is pure JSON, but OpenArt appends human prose after the
 *  JSON, so callTool hands back the raw string — brace-match it. */
function extractStatus(raw: unknown): { status?: string; historyId?: string; resources?: OpenArtResource[]; error?: string; pollAfterSeconds?: number } {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.status === 'string') return o as never;
    if (typeof o.text === 'string') { const j = firstJsonObject(o.text); if (j) return j as never; }
  }
  if (typeof raw === 'string') { const j = firstJsonObject(raw); if (j) return j as never; }
  return {};
}

/** Upload a reference image via the presigned-PUT dance and return the
 *  visualReference object OpenArt expects in params.visualReferences[]. */
async function uploadReference(bytes: Buffer, mime: string, label: string): Promise<Record<string, unknown>> {
  const signed = await openartCall('openart_upload_sign', {
    mediaType: 'image', size: bytes.length, contentType: mime, filename: `${label}.${mime.split('/')[1] || 'png'}`,
  });
  const s = (signed && typeof signed === 'object') ? signed as Record<string, unknown> : {};
  const signURL = String(s.signURL ?? s.uploadUrl ?? s.url ?? '');
  const visualReference = s.visualReference as Record<string, unknown> | undefined;
  if (!signURL || !visualReference) {
    throw new Error(`openart_upload_sign returned an unexpected shape: ${JSON.stringify(s).slice(0, 200)}`);
  }
  const put = await fetch(signURL, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes as unknown as BodyInit, signal: AbortSignal.timeout(30_000) });
  if (!put.ok) throw new Error(`reference PUT failed: HTTP ${put.status}`);
  return visualReference;
}

export interface OpenArtRunInput {
  prompt:       string;
  model:        string;
  mode:         'text2image' | 'image2image';
  aspectRatio?: string;
  referenceBytes?: { buf: Buffer; mime: string };
}

/** Submit one generation and poll to a terminal state. Returns the resources on
 *  COMPLETED, or a `{ failed }` reason (e.g. Gemini's NO_IMAGE) so the caller can
 *  decide whether to retry. Throws only on hard/unexpected errors. */
async function submitAndWait(
  model: string, mode: string, params: Record<string, unknown>,
): Promise<{ resources?: OpenArtResource[]; failed?: string }> {
  const submitRaw = await openartCall('openart_generate_image', { model, mode, params });
  const submit = extractStatus(submitRaw);
  const historyId = submit.historyId;
  if (!historyId) throw new Error(`OpenArt submit returned no historyId: ${JSON.stringify(submitRaw).slice(0, 200)}`);

  for (let i = 0; i < WAIT_MAX_ITERS; i++) {
    const w = extractStatus(await openartCall('openart_creation_wait', { historyId, timeoutSeconds: WAIT_SECONDS }));
    if (w.status === 'COMPLETED') return { resources: w.resources };
    if (w.status === 'FAILED')    return { failed: w.error || 'unknown error' };
    if (w.status === 'CANCELLED') throw new Error('OpenArt generation was cancelled');
    logger.info('openart: still running, re-waiting', { historyId, iter: i + 1 });
  }
  throw new Error('OpenArt generation is still running after the wait budget — try again shortly.');
}

/** Run one OpenArt image generation/edit end-to-end and return DOWNLOADED bytes
 *  (base64), ready for deliverAndArchive → gallery. Never returns an OpenArt URL. */
export async function runOpenArtImage(input: OpenArtRunInput): Promise<Array<{ base64: string; mime: string }>> {
  const params: Record<string, unknown> = {
    prompt:      input.prompt,
    imageCount:  1,
    aspectRatio: normalizeAspect(input.aspectRatio),
  };
  if (input.mode === 'image2image') {
    if (!input.referenceBytes) throw new Error('image2image requires a reference image');
    const ref = await uploadReference(input.referenceBytes.buf, input.referenceBytes.mime, 'nc-edit-ref');
    params.visualReferences = [ref];
  }

  let res = await submitAndWait(input.model, input.mode, params);

  // NO_IMAGE recovery: Gemini-backed models (nano-banana = gemini-3.1-flash-image)
  // intermittently refuse a prompt with reason NO_IMAGE. Retry ONCE — enabling
  // autoEnhancePrompt when the model's form allows it (it rewrites a weak prompt
  // into a proper image description, which is exactly what NO_IMAGE needs). Only
  // add the param if the form permits it (models declare additionalProperties:false).
  if (res.failed) {
    logger.warn('openart: generation FAILED, attempting one retry', { model: input.model, mode: input.mode, reason: res.failed });
    const allowed = await getFormParamKeys(input.model, input.mode);
    const retryParams = { ...params };
    if (allowed.has('autoEnhancePrompt')) retryParams.autoEnhancePrompt = true;
    res = await submitAndWait(input.model, input.mode, retryParams);
    if (res.failed) {
      throw new Error(`OpenArt generation failed after retry (${res.failed}). ${input.model} declined this prompt — try rephrasing or a different model.`);
    }
  }

  const resources = res.resources;
  if (!resources || resources.length === 0) {
    throw new Error('OpenArt completed but returned no image resources.');
  }

  const imageUrls = resources
    .filter(r => (r.mediaType ?? 'image') === 'image' && typeof r.url === 'string')
    .map(r => r.url as string);
  if (imageUrls.length === 0) throw new Error('OpenArt completed but returned no image resources.');

  // 🔒 bytes-only: download each result → base64 (gallery routing, never a URL).
  const out: Array<{ base64: string; mime: string }> = [];
  for (const url of imageUrls) {
    const item = await downloadBytes(url, 'image');
    out.push({ base64: item.base64, mime: item.mime });
  }
  return out;
}
