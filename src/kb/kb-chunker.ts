// Header/size-aware markdown chunking. Keeps chunks <= maxChars (~500 tokens)
// and prefers splitting on markdown headers, then blank lines, then hard length.
import { config } from '../config';

export function chunkMarkdown(md: string, maxChars = config.kb.chunkMaxChars): string[] {
  const text = (md ?? '').trim();
  if (!text) return [];
  // Split into blocks on headers (keep the header with its section) and blank lines.
  const blocks = text.split(/\n(?=#{1,6}\s)/g).flatMap(sec => sec.split(/\n{2,}/g));
  const chunks: string[] = [];
  let cur = '';
  const push = () => { const t = cur.trim(); if (t) chunks.push(t); cur = ''; };

  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue;
    if (b.length > maxChars) {
      push();
      // Hard-split an oversized block on whitespace.
      for (let i = 0; i < b.length; i += maxChars) chunks.push(b.slice(i, i + maxChars).trim());
      continue;
    }
    if (cur.length + b.length + 2 > maxChars) push();
    cur += (cur ? '\n\n' : '') + b;
  }
  push();
  return chunks.filter(Boolean);
}
