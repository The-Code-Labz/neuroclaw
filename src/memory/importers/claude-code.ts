import type { ImportedConversation } from './types';
import { buildFromMessages } from './shared';

export function parseClaudeCode(buffer: Buffer): ImportedConversation[] {
  const text = buffer.toString('utf8').trim();

  // Try JSONL: multiple lines each parseable as JSON.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    try {
      const messages = lines.map((l) => JSON.parse(l) as { role?: unknown; content?: unknown });
      const result = buildFromMessages(messages);
      if (result.length) return result;
    } catch { /* fall through */ }
  }

  // Try single JSON.
  try {
    const data: unknown = JSON.parse(text);
    if (Array.isArray(data)) {
      return buildFromMessages(data as Array<{ role?: unknown; content?: unknown }>);
    }
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.messages)) {
        return buildFromMessages(obj.messages as Array<{ role?: unknown; content?: unknown }>);
      }
    }
  } catch { /* fall through */ }

  return [];
}
