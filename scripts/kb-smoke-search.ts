import 'dotenv/config';
import { searchKnowledgeBase, listSources } from '../src/kb/kb-search';

(async () => {
  console.log('sources:', await listSources());
  const r = await searchKnowledgeBase('KB ingest smoke paragraph', { limit: 3 });
  console.log('search:', JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
  console.log('OK: results =', r.results.length);
})();
