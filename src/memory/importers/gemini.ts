import { randomUUID } from 'crypto';
import type { ImportedConversation, ImportedExchange } from './types';

interface GeminiEntry {
  author: string;
  text:   string;
}

interface GeminiConversation {
  conversation_id?: string;
  entries?:         GeminiEntry[];
}

export function parseGemini(buffer: Buffer): ImportedConversation[] {
  let data: unknown;
  try { data = JSON.parse(buffer.toString('utf8')); } catch { return []; }
  if (!data || typeof data !== 'object') return [];

  const conversations = (data as Record<string, unknown>).conversations;
  if (!Array.isArray(conversations)) return [];

  return (conversations as GeminiConversation[]).flatMap((conv) => {
    if (!Array.isArray(conv?.entries)) return [];

    const exchanges: ImportedExchange[] = [];
    let pendingUser: string | null = null;

    for (const entry of conv.entries) {
      const text = (entry?.text ?? '').trim();
      if (!text) continue;
      if (entry.author === 'USER') {
        pendingUser = text;
      } else if (entry.author === 'MODEL' && pendingUser) {
        exchanges.push({ user: pendingUser, assistant: text });
        pendingUser = null;
      }
    }

    if (!exchanges.length) return [];
    return [{ id: conv.conversation_id ?? randomUUID(), exchanges }];
  });
}
