import { randomUUID } from 'crypto';
import type { ImportedConversation, ImportedExchange } from './types';

interface GptNode {
  id:       string;
  parent:   string | null;
  children: string[];
  message?: {
    author:  { role: string };
    content: { parts: unknown[] };
  };
}

export function parseChatGPT(buffer: Buffer): ImportedConversation[] {
  let data: unknown;
  try { data = JSON.parse(buffer.toString('utf8')); } catch { return []; }
  if (!Array.isArray(data)) return [];

  return (data as unknown[]).flatMap((raw) => {
    const conv = raw as Record<string, unknown>;
    if (!conv || typeof conv.mapping !== 'object' || !conv.mapping) return [];
    const mapping = conv.mapping as Record<string, GptNode>;

    // Walk chain from current_node to root, then reverse for chronological order.
    const chain: GptNode[] = [];
    let nodeId = (conv.current_node as string | null | undefined) ?? null;
    const seen = new Set<string>();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      chain.unshift(mapping[nodeId]);
      nodeId = mapping[nodeId].parent ?? null;
    }

    const exchanges: ImportedExchange[] = [];
    let pendingUser: string | null = null;

    for (const node of chain) {
      const msg = node.message;
      if (!msg) continue;
      const parts = msg.content?.parts ?? [];
      const text = (parts as unknown[])
        .filter((p) => typeof p === 'string')
        .join('')
        .trim();
      if (!text) continue;

      if (msg.author.role === 'user') {
        pendingUser = text;
      } else if (msg.author.role === 'assistant' && pendingUser) {
        exchanges.push({ user: pendingUser, assistant: text });
        pendingUser = null;
      }
    }

    if (!exchanges.length) return [];
    return [{
      id:    (conv.id as string | undefined) ?? randomUUID(),
      title: typeof conv.title === 'string' ? conv.title : undefined,
      exchanges,
    }];
  });
}
