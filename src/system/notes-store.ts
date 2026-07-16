// Shared Notepad store (agent_notes).
//
// PURPOSE: agents routinely need to hand the human a long, continuous document —
// a report, a plan, a full log — but the Discord relay chops messages at the
// platform length limit. The Notepad is the escape hatch: an agent writes (or
// keeps appending to) a single MARKDOWN note that the human reads and copies
// verbatim in the dashboard Notes tab. No length ceiling, no chunking.
//
// Any agent can create a note and any agent can append to any note at any time
// (single-operator deployment — notes are GLOBAL, author is provenance only).
// State lives in SQLite (agent_notes); this module is the one CRUD surface used
// by BOTH the tool handlers and the dashboard API routes.

import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { logger } from '../utils/logger';

export interface NoteRow {
  id: string;
  title: string;
  content: string;
  author: string;
  agent_id: string | null;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

// Summary shape for list views — omits the (potentially large) body.
export interface NoteSummary {
  id: string;
  title: string;
  author: string;
  agent_id: string | null;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
  chars: number;
  preview: string;
}

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const MAX_TITLE = 200;

/** List notes (summaries, newest-updated first; pinned float to the top). */
export function listNotes(opts?: { includeArchived?: boolean }): NoteSummary[] {
  const db = getDb();
  const where = opts?.includeArchived ? '' : 'WHERE archived = 0';
  const rows = db.prepare(
    `SELECT id, title, author, agent_id, pinned, archived, created_at, updated_at,
            length(content) AS chars, substr(content, 1, 240) AS preview
     FROM agent_notes ${where}
     ORDER BY pinned DESC, updated_at DESC`
  ).all() as (NoteSummary & Record<string, unknown>)[];
  return rows.map(r => ({
    id: r.id, title: r.title, author: r.author, agent_id: r.agent_id,
    pinned: r.pinned, archived: r.archived,
    created_at: r.created_at, updated_at: r.updated_at,
    chars: Number(r.chars) || 0,
    preview: String(r.preview || '').replace(/\s+/g, ' ').trim(),
  }));
}

/** Fetch a single note by id (full content). */
export function getNote(id: string): NoteRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_notes WHERE id = ?').get(id) as NoteRow | undefined;
  return row ?? null;
}

/** Case-insensitive lookup by exact title (used by append-by-title). */
export function getNoteByTitle(title: string): NoteRow | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM agent_notes WHERE lower(title) = lower(?) AND archived = 0 ORDER BY updated_at DESC LIMIT 1'
  ).get(title.trim()) as NoteRow | undefined;
  return row ?? null;
}

/** Create a new note. */
export function createNote(input: {
  title?: string; content?: string; author?: string; agentId?: string | null; pinned?: boolean;
}): NoteRow {
  const db = getDb();
  const id = randomUUID();
  const ts = nowIso();
  const title = (input.title ?? '').trim().slice(0, MAX_TITLE) || 'Untitled note';
  db.prepare(
    `INSERT INTO agent_notes (id, title, content, author, agent_id, pinned, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(id, title, input.content ?? '', (input.author ?? 'agent').slice(0, 120), input.agentId ?? null, input.pinned ? 1 : 0, ts, ts);
  logger.debug('notes-store: created', { id, title, author: input.author });
  return getNote(id)!;
}

/** Patch an existing note. Only provided fields change. Returns null if missing. */
export function updateNote(id: string, patch: {
  title?: string; content?: string; pinned?: boolean; archived?: boolean;
}): NoteRow | null {
  const db = getDb();
  const existing = getNote(id);
  if (!existing) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined)   { sets.push('title = ?');    vals.push(patch.title.trim().slice(0, MAX_TITLE) || 'Untitled note'); }
  if (patch.content !== undefined) { sets.push('content = ?');  vals.push(patch.content); }
  if (patch.pinned !== undefined)  { sets.push('pinned = ?');   vals.push(patch.pinned ? 1 : 0); }
  if (patch.archived !== undefined){ sets.push('archived = ?'); vals.push(patch.archived ? 1 : 0); }
  if (sets.length === 0) return existing;
  sets.push('updated_at = ?'); vals.push(nowIso());
  vals.push(id);
  db.prepare(`UPDATE agent_notes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getNote(id);
}

/**
 * Append markdown to a note — the core "one continuous document" primitive.
 * Resolution order: by id, else by exact title. If neither resolves and a title
 * was given, a new note is created (so an agent can "append to my Report note"
 * without first checking whether it exists). A thin, optional attribution rule
 * (── author · timestamp ──) is inserted before the appended block unless the
 * note is empty. Returns the updated/created note.
 */
export function appendNote(input: {
  id?: string; title?: string; content: string; author?: string; agentId?: string | null;
  attribution?: boolean;
}): { note: NoteRow; created: boolean } {
  let target: NoteRow | null = null;
  if (input.id) target = getNote(input.id);
  if (!target && input.title) target = getNoteByTitle(input.title);

  const author = (input.author ?? 'agent').slice(0, 120);
  const body = input.content ?? '';

  if (!target) {
    // Nothing to append to → create it (title required to auto-create).
    const note = createNote({ title: input.title, content: body, author, agentId: input.agentId ?? null });
    return { note, created: true };
  }

  const sep = target.content.trim().length === 0
    ? ''
    : (input.attribution === false
        ? '\n\n'
        : `\n\n---\n*— ${author} · ${nowIso()}*\n\n`);
  const merged = target.content + sep + body;
  const note = updateNote(target.id, { content: merged })!;
  return { note, created: false };
}

/** Hard-delete a note. Returns true if a row was removed. */
export function deleteNote(id: string): boolean {
  const db = getDb();
  const r = db.prepare('DELETE FROM agent_notes WHERE id = ?').run(id);
  return r.changes > 0;
}
