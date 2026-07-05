/**
 * broker/memoryScrub.ts — scrubber pass for NeuroVault writes (spec v3 §9 / §15).
 *
 * Defense-in-depth: text destined for long-term memory (memories table,
 * vault notes, memory_index summaries, dream-cycle extracts) is run through
 * this helper first. We fetch every secret value from the active storage
 * adapter and pass them to `scrubOutput`.
 *
 * Best-effort: if loading values throws, we return the input unchanged and
 * log a warning rather than blocking the memory write.
 */
import { getStorage } from './storage';
import { scrubOutput } from './scrubber';
import { auditLog } from './audit';
import { logger } from '../utils/logger';

export async function scrubForMemory(
  content: string,
  context: { agent?: string; sessionId?: string } = {},
): Promise<string> {
  if (typeof content !== 'string' || content.length === 0) return content;

  const values: Record<string, string> = {};
  try {
    const list = await getStorage().list();
    for (const meta of list) {
      const v = await getStorage().getValue(meta.name);
      if (v && v.length > 0) values[meta.name] = v;
    }
  } catch (err) {
    logger.warn('broker/memoryScrub: failed to load values, skipping scrub', {
      err: (err as Error).message,
    });
    return content;
  }

  if (Object.keys(values).length === 0) return content;

  const result = scrubOutput(content, values);
  if (result.triggered) {
    auditLog({
      event: 'scrub_triggered',
      agent: context.agent ?? 'memory-writer',
      session_id: context.sessionId ?? 'memory',
      purpose: 'NeuroVault write',
      outcome: 'ok',
      detail: 'secret value found in memory content; replaced before persistence',
    });
  }
  return result.scrubbed;
}
