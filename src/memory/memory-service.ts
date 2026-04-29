import { randomUUID } from 'crypto';
import { getDb, logAudit } from '../db';

// TODO [memory]: Replace with vector store (pgvector, Chroma, Pinecone) for semantic retrieval
// TODO [memory extractor]: Auto-extract key facts from each conversation after it ends
// TODO [memory consolidation]: Periodically merge and summarise old memories to reduce storage
// TODO [Obsidian memory]: Sync important memories to Obsidian vault via local REST plugin

export interface Memory {
  id:         string;
  session_id: string | null;
  content:    string;
  type:       string;
  importance: number;
  created_at: string;
}

export function saveMemory(content: string, type = 'general', sessionId?: string, importance = 5): Memory {
  const id = randomUUID();
  const db = getDb();
  db.prepare(`
    INSERT INTO memories (id, session_id, content, type, importance)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sessionId ?? null, content, type, importance);
  logAudit('memory_saved', 'memory', id, { type });
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory;
}

export function getMemories(limit = 50): Memory[] {
  return getDb()
    .prepare('SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?')
    .all(limit) as Memory[];
}

export function searchMemories(query: string): Memory[] {
  return getDb()
    .prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY importance DESC LIMIT 20')
    .all(`%${query}%`) as Memory[];
}
