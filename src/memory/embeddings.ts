// Vector embeddings for memory_index. Uses the existing OpenAI client
// (which routes to whichever base URL is configured — VoidAI or direct).
//
// Storage: Float32Array packed as a BLOB on memory_index.embedding. A 1536-dim
// vector is 6 KB per row. SQLite handles BLOBs natively — no extension, no
// vector store, no new infrastructure. Cosine similarity is computed in JS
// over the candidate set; for our scale (sub-10k memories per user) this is
// 0.5-2s per query and fine. If/when we cross 50k, drop in `sqlite-vec`.

import { config } from '../config';
import { logger } from '../utils/logger';
import { getClient } from '../agent/openai-client';

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
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (getClient() as any).embeddings.create({
      model,
      input: trimmed,
    });
    const data = res?.data?.[0]?.embedding;
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn('embedText: empty embedding response', { model });
      return null;
    }
    return { vector: new Float32Array(data as number[]), model };
  } catch (err) {
    logger.warn('embedText: provider call failed', { model, err: (err as Error).message });
    return null;
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
