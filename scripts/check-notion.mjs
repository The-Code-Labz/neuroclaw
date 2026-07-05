import { Composio } from '@composio/core';
const apiKey = process.env.COMPOSIO_API_KEY;
const baseURL = process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev';
const c = new Composio({ apiKey, baseURL, allowTracking: false });

// Try every known agent user id
const userIds = ['alfred','oracle','jarvis','felicity','yoimiya','asia','lina','davinci','miyuki','shorekeeper','kurumi','raphtalia','liese','mayumi','rias','demo','tim','nightwing','friday','batman','cassandra','joker','harley','lucius','asuna','akeno','kuroka','irina','grayfia','A.S.A.G.I'];
console.log('── per-user binding ──');
for (const uid of userIds) {
  try {
    const r = await c.connectedAccounts.list({ userIds: [uid] });
    const items = Array.isArray(r) ? r : (r.items ?? r.data ?? []);
    const notion = items.filter(a => String(a.toolkit?.slug ?? '').toLowerCase() === 'notion');
    if (notion.length) {
      for (const a of notion) {
        console.log(uid, '→', a.id, a.status, a.wordId, 'updated:', a.updatedAt);
      }
    }
  } catch (e) {
    console.log(uid, 'ERR', e.message);
  }
}
