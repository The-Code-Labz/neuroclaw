import { randomUUID } from 'crypto';
import type { ImportedConversation, ImportedExchange } from './types';
import { buildFromMessages } from './shared';

export function parseGeneric(buffer: Buffer): ImportedConversation[] {
  let data: unknown;
  try { data = JSON.parse(buffer.toString('utf8')); } catch { return []; }

  // Shape 1: [{role, content}] message array.
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    if (typeof first?.role === 'string') {
      return buildFromMessages(data as Array<{ role?: unknown; content?: unknown }>);
    }

    // Shape 2: [{user, assistant}] pre-paired exchanges.
    if (typeof first?.user === 'string' || typeof first?.assistant === 'string') {
      const exchanges: ImportedExchange[] = (data as Record<string, unknown>[])
        .filter((p) => typeof p.user === 'string' && typeof p.assistant === 'string')
        .map((p) => ({
          user:      (p.user as string).trim(),
          assistant: (p.assistant as string).trim(),
        }))
        .filter((e) => e.user && e.assistant);
      return exchanges.length ? [{ id: randomUUID(), exchanges }] : [];
    }
  }

  // Shape 3: single object with a messages array.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      return buildFromMessages(obj.messages as Array<{ role?: unknown; content?: unknown }>);
    }
  }

  return [];
}
