import 'dotenv/config';
import { ingestKbContent } from '../src/kb/kb-ingest';

(async () => {
  const r = await ingestKbContent({
    text: '# Smoke\n\n' + 'NeuroClaw KB ingest smoke paragraph. '.repeat(20),
    sourceId: 'smoke.local', url: 'https://smoke.local/test', title: 'Smoke',
  });
  console.log('ingest:', r);
  if (!r.ok || r.chunks < 1) process.exit(1);
  console.log('OK: enqueued embedding jobs for', r.chunks, 'chunk(s).');
})();
