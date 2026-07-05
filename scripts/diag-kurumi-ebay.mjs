// Verify Kurumi's session now includes ebay in the toolkit allowlist
// by simulating exactly what the agent providers do: read the DB row,
// parse composio_toolkits, then mint a session with that list.
import 'dotenv/config';
import { getComposioMcp, parseAgentToolkits, clearComposioSessionCache } from '../dist/composio/client.js';
import { getDb } from '../dist/db.js';

clearComposioSessionCache();

const db = getDb();
const row = db.prepare("SELECT composio_user_id, composio_toolkits FROM agents WHERE name = 'Kurumi'").get();
console.log('DB row:', row);

const userId   = row.composio_user_id;
const toolkits = parseAgentToolkits(row.composio_toolkits);
console.log('parsed toolkits arg →', toolkits);

(async () => {
  const ep = await getComposioMcp(userId, toolkits);
  console.log('mcp.url           =', ep.url);
  console.log('toolkits applied  =', JSON.stringify(ep.toolkits));
  console.log('ebay in allowlist?', ep.toolkits.includes('ebay'));

  async function rpc(payload) {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...ep.headers },
      body: JSON.stringify(payload),
    });
    const t = await res.text();
    try { return JSON.parse(t); }
    catch { const m = t.match(/data:\s*(\{[\s\S]*?\})\s*$/m); return m ? JSON.parse(m[1]) : { raw: t }; }
  }

  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const tools = list?.result?.tools ?? [];
  console.log(`\n${tools.length} tools in MCP tools/list:`);
  console.log(`  googlesheets:  ${tools.filter(t => /^GOOGLESHEETS_/.test(t.name)).length}`);
  console.log(`  ebay:          ${tools.filter(t => /^EBAY_/.test(t.name)).length}`);
  console.log(`  meta:          ${tools.filter(t => /^COMPOSIO_/.test(t.name)).length}`);

  const ebayTools = tools.filter(t => /^EBAY_/.test(t.name)).map(t => t.name);
  if (ebayTools.length) {
    console.log('\nSample eBay tool names:', ebayTools.slice(0, 8).join(', '));
  } else {
    console.log('\nNo EBAY_* tools surfaced yet — expected.');
    console.log('eBay still needs an OAuth connected account under userId=kurumi.');
    console.log('Since `ebay` is not in TIER_MAP, it falls through to T2 (ask-at-connect) — Kurumi can self-create via COMPOSIO_MANAGE_CONNECTIONS.');
  }
})().catch(e => { console.error(e); process.exit(1); });
