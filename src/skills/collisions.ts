// src/skills/collisions.ts
//
// Pure-TS skill description collision detection. Pillar 4 of the MED skill
// plan — passive, hint-only. We compute Jaccard similarity over normalized
// word sets and surface the top neighbors for any given skill.
//
// Why Jaccard over TF-IDF or cosine:
//   - Zero dependencies; runs in tens of milliseconds even with 100+ skills.
//   - Transparent algorithm — easy to explain to a skill author who's looking
//     at a "Similar to: <other> (87%)" hint and wondering what it means.
//   - The signal we need is binary-ish: "are these two descriptions saying
//     basically the same thing?" Jaccard answers that without false rigour.
//
// We deliberately do NOT block creation on collisions. The author always wins.
// This module exists to surface the information the video calls out (the
// "daily-planner vs daily-standup" problem), not to nag.

import { listSkills, type SkillRecord } from './skill-loader';

// Tiny stopword list — covers the words that show up in almost every "use
// when…" description and would otherwise inflate Jaccard scores artificially.
// Not exhaustive. Curated for skill-description vocabulary specifically.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'use', 'used', 'using', 'when', 'with', 'will', 'should',
  'you', 'your', 'user', 'users', 'asks', 'ask', 'wants', 'want', 'needs',
  'need', 'i', 'we', 'they', 'task', 'tasks',
]);

/** Tokenize a skill description into a normalized word set.
 *  Lowercase, strip non-alphanumerics, drop short tokens and stopwords. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** Jaccard similarity between two token sets. 0 = disjoint, 1 = identical. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface CollisionHit {
  name:       string;
  similarity: number;          // 0..1, Jaccard
  description: string;
}

export interface CheckCollisionInput {
  /** Skill name being authored. Excluded from results (a skill can't collide with itself). */
  name?:        string;
  /** Description text to compare against the catalog. */
  description:  string;
  /** Minimum similarity to surface. Default 0.5. */
  threshold?:   number;
  /** Maximum number of hits to return. Default 3. */
  limit?:       number;
}

/** Check a candidate description against every skill in the live catalog.
 *  Returns the top-N neighbors above the threshold, sorted by similarity desc. */
export function checkCollision(inp: CheckCollisionInput): CollisionHit[] {
  const threshold = inp.threshold ?? 0.5;
  const limit     = inp.limit     ?? 3;
  if (!inp.description || inp.description.trim().length === 0) return [];

  const candidateTokens = tokenize(inp.description);
  if (candidateTokens.size === 0) return [];

  const hits: CollisionHit[] = [];
  for (const s of listSkills()) {
    if (inp.name && s.name === inp.name) continue;
    if (!s.description) continue;
    const sim = jaccard(candidateTokens, tokenize(s.description));
    if (sim >= threshold) {
      hits.push({ name: s.name, similarity: sim, description: s.description });
    }
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}

/** Build a full pairwise collision matrix across the catalog. Useful for a
 *  one-shot "audit my whole catalog" call. O(N²) pairs but N is small. */
export interface CollisionPair {
  a:          string;
  b:          string;
  similarity: number;
}

export function listAllCollisions(threshold = 0.5): CollisionPair[] {
  const skills = listSkills().filter((s: SkillRecord) => s.description && s.description.trim().length > 0);
  const tokens: Array<{ name: string; toks: Set<string> }> = skills.map(s => ({
    name: s.name,
    toks: tokenize(s.description),
  }));

  const out: CollisionPair[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const sim = jaccard(tokens[i].toks, tokens[j].toks);
      if (sim >= threshold) {
        out.push({ a: tokens[i].name, b: tokens[j].name, similarity: sim });
      }
    }
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}
