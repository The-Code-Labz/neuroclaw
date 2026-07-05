import { randomUUID } from 'crypto';
import type { ImportedConversation, ImportedExchange } from './types';

// Extracts plain text from a content field that is either a raw string or
// an array of content blocks (Claude-style: [{type:'text', text:'...'}]).
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => (b as Record<string, unknown>)?.type === 'text')
      .map((b: unknown) => String((b as Record<string, unknown>).text ?? ''))
      .join('')
      .trim();
  }
  return '';
}

// Converts a flat [{role, content}] array into a single ImportedConversation
// by pairing consecutive user→assistant turns. Turns that don't form a
// complete pair (e.g. trailing user turn) are dropped.
export function buildFromMessages(
  messages: Array<{ role?: unknown; content?: unknown }>,
  convId = randomUUID(),
): ImportedConversation[] {
  const exchanges: ImportedExchange[] = [];
  let pendingUser: string | null = null;

  for (const msg of messages) {
    const text = extractText(msg.content);
    if (!text) continue;
    if (msg.role === 'user') {
      pendingUser = text;
    } else if (msg.role === 'assistant' && pendingUser) {
      exchanges.push({ user: pendingUser, assistant: text });
      pendingUser = null;
    }
  }

  return exchanges.length ? [{ id: convId, exchanges }] : [];
}
