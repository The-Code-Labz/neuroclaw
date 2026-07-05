import { chunkMarkdown } from '../src/kb/kb-chunker';

const md = '# Title\n\n' + 'word '.repeat(800) + '\n\n## Section\n\nShort para.';
const chunks = chunkMarkdown(md, 500);
const tooBig = chunks.filter(c => c.length > 500);
if (chunks.length < 2) { console.error('FAIL: expected multiple chunks, got', chunks.length); process.exit(1); }
if (tooBig.length) { console.error('FAIL: chunk exceeds maxChars', tooBig.map(c => c.length)); process.exit(1); }
console.log('OK: chunks =', chunks.length, 'max len =', Math.max(...chunks.map(c => c.length)));
