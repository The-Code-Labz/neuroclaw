// KB embeddings. Reuses memory/embeddings.embedText but enforces the locked
// model + dimension so new KB vectors stay comparable to the existing ones.
import { embedText } from '../memory/embeddings';
import { config } from '../config';
import { logger } from '../utils/logger';

const EXPECTED_DIM = 1536;

/** Normalize "openai/text-embedding-3-small" → "text-embedding-3-small". */
function normalizeModel(m: string): string {
  return m.includes('/') ? m.split('/').pop()! : m;
}

/**
 * Fail-loud config check. Call once at boot when KB is enabled.
 * Guards against the two silent-failure modes: embeddings globally disabled,
 * and a live model that won't match the KB's existing embedded vectors.
 */
export function assertKbEmbeddingHealthy(): void {
  if (!config.kb.enabled) return;
  if (!config.embeddings.enabled) {
    throw new Error('kb: KB_ENABLED=true but MEMORY_EMBEDDINGS_ENABLED is false — KB rows would never get embeddings. Enable embeddings or disable KB.');
  }
  if (normalizeModel(config.embeddings.model) !== normalizeModel(config.kb.embeddingModel)) {
    throw new Error(`kb: live embedding model "${config.embeddings.model}" != KB model "${config.kb.embeddingModel}". New vectors would not match the KB's existing embedded vectors.`);
  }
}

/**
 * Fail-loud config check for the Supabase memory backend. Call at boot when
 * MEMORY_BACKEND=supabase. Same two failure modes as the KB guard: embeddings
 * off, or a live model that won't match the imported memory BLOBs (which are
 * all text-embedding-3-small / 1536).
 */
export function assertMemoryEmbeddingHealthy(): void {
  if (config.memory.backend !== 'supabase') return;
  if (!config.embeddings.enabled) {
    throw new Error('mem: MEMORY_BACKEND=supabase but MEMORY_EMBEDDINGS_ENABLED is false — new memories would never get embeddings.');
  }
  if (normalizeModel(config.embeddings.model) !== 'text-embedding-3-small') {
    throw new Error(`mem: live embedding model "${config.embeddings.model}" != text-embedding-3-small. New memory vectors would not match the imported BLOBs.`);
  }
}

/** Embed text for the KB. Returns a number[] for the pgvector RPC, or null. */
export async function embedKbText(text: string): Promise<number[] | null> {
  const res = await embedText(text);
  if (!res) return null;
  if (res.vector.length !== EXPECTED_DIM) {
    logger.warn('kb: unexpected embedding dim', { got: res.vector.length, expected: EXPECTED_DIM });
    return null;
  }
  if (normalizeModel(res.model) !== normalizeModel(config.kb.embeddingModel)) {
    logger.warn('kb: embedding model mismatch at runtime', { got: res.model, expected: config.kb.embeddingModel });
    return null;
  }
  return Array.from(res.vector);
}
