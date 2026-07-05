import 'dotenv/config';
import { embedKbText, assertKbEmbeddingHealthy } from '../src/kb/kb-embeddings';

(async () => {
  assertKbEmbeddingHealthy();
  const v = await embedKbText('NeuroClaw knowledge base smoke test sentence.');
  if (!v) { console.error('FAIL: null embedding (embeddings disabled or API error)'); process.exit(1); }
  console.log('OK: dim =', v.length, 'first =', v[0]);
})();
