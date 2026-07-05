import 'dotenv/config';
import { getMemoryStore } from '../src/memory/memory-store';
import { embedText } from '../src/memory/embeddings';
(async () => {
  const store = await getMemoryStore();
  console.log('backend: sqlite (default)');
  const stats = await store.getStats();
  console.log('getStats:', JSON.stringify(stats));
  const byType = await store.countByType();
  console.log('countByType (top 3):', JSON.stringify(byType.slice(0,3)));
  const lex = await store.searchMemoryIndex('supabase migration', 3);
  console.log('searchMemoryIndex hits:', lex.length, lex[0] && '| top:', lex[0]?.title?.slice(0,50));
  const q = await embedText('supabase knowledge base');
  if (q) {
    const vec = await store.matchByVector(Array.from(q.vector), 3);
    console.log('matchByVector hits:', vec.length, vec[0] && `| top sim ${vec[0].similarity.toFixed(3)}: ${vec[0].title?.slice(0,50)}`);
  }
})();
