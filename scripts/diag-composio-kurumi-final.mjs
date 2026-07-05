// Use the actual NeuroClaw client wrapper (mirrors what an agent gets at runtime).
import 'dotenv/config';
import { getComposioMcp, clearComposioSessionCache } from '../dist/composio/client.js';

clearComposioSessionCache();

const USER = 'kurumi';

async function rpc(url, headers, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(payload),
  });
  const t = await res.text();
  try { return JSON.parse(t); }
  catch { const m = t.match(/data:\s*(\{[\s\S]*?\})\s*$/m); return m ? JSON.parse(m[1]) : { raw: t }; }
}

(async () => {
  const ep = await getComposioMcp(USER, null);
  console.log('mcp.url   =', ep.url);
  console.log('toolkits  =', ep.toolkits);

  const list = await rpc(ep.url, ep.headers, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const tools = list?.result?.tools ?? [];
  console.log(`\n${tools.length} tools in MCP tools/list:`);
  console.log(`  googlesheets: ${tools.filter(t => /^GOOGLESHEETS_/.test(t.name)).length}`);
  console.log(`  meta:          ${tools.filter(t => /^COMPOSIO_/.test(t.name)).length}`);

  console.log('\nExecuting GOOGLESHEETS_SEARCH_SPREADSHEETS...');
  const exec = await rpc(ep.url, ep.headers, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'GOOGLESHEETS_SEARCH_SPREADSHEETS', arguments: { max_results: 3, search_type: 'both' } },
  });
  console.log(JSON.stringify(exec, null, 2).slice(0, 1500));
})().catch(e => { console.error(e); process.exit(1); });
