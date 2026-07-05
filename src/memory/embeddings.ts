// Vector embeddings for memory_index. Routes to OpenAI directly when
// OPENAI_API_KEY is set; otherwise uses the existing VoidAI-compatible client.
//
// Storage: Float32Array packed as a BLOB on memory_index.embedding. A 1536-dim
// vector is 6 KB per row. SQLite handles BLOBs natively — no extension, no
// vector store, no new infrastructure. Cosine similarity is computed in JS
// over the candidate set; for our scale (sub-10k memories per user) this is
// 0.5-2s per query and fine. If/when we cross 50k, drop in `sqlite-vec`.

import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getBgClient, markVoidaiDown, isVoidaiError } from '../agent/openai-client';

let openaiClient:   OpenAI | null = null;
let orEmbedClient:  OpenAI | null = null;

/** Returns an OpenAI-compatible client for embeddings. */
function getEmbedClient(): any {
  if (config.embeddings.provider === 'openai') {
    if (!openaiClient) {
      openaiClient = new OpenAI({
        apiKey: config.embeddings.apiKey,
        baseURL: config.embeddings.baseURL,
        // Retry transient 429/5xx — embeddings (memory + KB) were failing hard on
        // brief OpenAI hiccups, returning null and silently dropping vectors.
        maxRetries: 3,
      });
    }
    return openaiClient;
  }
  return getBgClient();
}

/** Dedicated OpenRouter client for embedding fallback. */
function getOrEmbedClient(): any {
  if (!orEmbedClient) {
    orEmbedClient = new OpenAI({
      apiKey:         config.openrouter.apiKey,
      baseURL:        config.openrouter.baseURL,
      defaultHeaders: { 'HTTP-Referer': 'https://neuroclaw.io', 'X-Title': 'NeuroClaw' },
      maxRetries:     0,
    });
  }
  return orEmbedClient;
}

/**
 * Embed a string into a Float32 vector. Returns null when:
 *   - embeddings are disabled globally
 *   - the input is too short to be useful (below MEMORY_EMBEDDING_MIN_CHARS)
 *   - the embedding API call fails (logged, never thrown)
 *
 * Callers should treat null as "no embedding available; fall back to the
 * lexical path." Memory writes still succeed.
 */
export async function embedText(text: string): Promise<{ vector: Float32Array; model: string } | null> {
  if (!config.embeddings.enabled) return null;
  const trimmed = (text ?? '').trim();
  if (trimmed.length < config.embeddings.minChars) return null;

  const model = config.embeddings.model;

  const tryEmbed = async (client: any, clientLabel: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (client as any).embeddings.create({ model, input: trimmed });
    const data = res?.data?.[0]?.embedding;
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn('embedText: empty embedding response', { model, client: clientLabel });
      return null;
    }
    return { vector: new Float32Array(data as number[]), model };
  };

  try {
    return await tryEmbed(getEmbedClient(), 'primary');
  } catch (err) {
    if (isVoidaiError(err)) markVoidaiDown();
    logger.warn('embedText: primary failed, trying OpenRouter', { model, err: (err as Error).message });
    if (!config.openrouter.apiKey) {
      return null;
    }
    try {
      // OpenRouter requires provider-prefixed model names (e.g. "openai/text-embedding-3-small")
      const orModel = model.includes('/') ? model : `openai/${model}`;
      const res = await (getOrEmbedClient() as any).embeddings.create({ model: orModel, input: trimmed });
      const data = res?.data?.[0]?.embedding;
      if (!Array.isArray(data) || data.length === 0) {
        logger.warn('embedText: empty OpenRouter embedding response', { orModel });
        return null;
      }
      return { vector: new Float32Array(data as number[]), model: orModel };
    } catch (orErr) {
      logger.warn('embedText: OpenRouter also failed', { model, err: (orErr as Error).message });
      return null;
    }
  }
}

/** Pack a Float32 vector into a Buffer for SQLite BLOB storage. */
export function packVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a SQLite BLOB back into a Float32 vector. */
export function unpackVector(buf: Buffer | null | undefined): Float32Array | null {
  if (!buf || buf.length === 0 || buf.length % 4 !== 0) return null;
  // Copy into a fresh ArrayBuffer so the Float32Array view doesn't alias
  // SQLite's internal buffer (which can be reused on subsequent reads).
  const ab = new ArrayBuffer(buf.length);
  Buffer.from(ab).set(buf);
  return new Float32Array(ab);
}

/**
 * Cosine similarity in [-1, 1]. Vectors must be the same length.
 * Returns 0 for mismatched/empty inputs rather than throwing — easier to
 * fold into ranking pipelines that mix embedded and non-embedded rows.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
