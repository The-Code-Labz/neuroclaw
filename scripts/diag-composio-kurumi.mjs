// Diagnose why Kurumi's googlesheets connection is invisible to her MCP session.
//   1) List all connected accounts (no filter)        — see what the SDK actually returns.
//   2) List connected accounts for userIds=['kurumi'] — see if the SDK matches her tag.
//   3) composio.create('kurumi', { manageConnections:false }) — mint her session.
//   4) Hit the MCP server with tools/list and look for GOOGLESHEETS_*.
//   5) Try to actually execute GOOGLESHEETS_SEARCH_SPREADSHEETS via MCP.

import 'dotenv/config';
import { Composio } from '@composio/core';

const apiKey  = process.env.COMPOSIO_API_KEY;
const baseURL = process.env.COMPOSIO_BASE_URL || undefined;
if (!apiKey) { console.error('COMPOSIO_API_KEY missing'); process.exit(1); }

const composio = new Composio({ apiKey, baseURL, allowTracking: true });

function shortConn(a) {
  return {
    id:       a.id,
    toolkit:  a.toolkit?.slug ?? a.toolkit ?? a.appName,
    status:   a.status ?? a.state,
    userId:   a.user_id ?? a.userId ?? a.user?.id ?? a.entity_id ?? a.entityId ?? null,
    authCfg:  a.auth_config?.id ?? a.authConfig?.id ?? null,
  };
}

(async () => {
  console.log('\n──[1] listing ALL connected accounts (no filter)──');
  let allRes;
  try { allRes = await composio.connectedAccounts.list({}); }
  catch (e) { console.error('list({}) error:', e.message); process.exit(1); }
  const allItems = Array.isArray(allRes) ? allRes : (allRes.items ?? allRes.data ?? []);
  console.log(`returned ${allItems.length} accounts:`);
  for (const a of allItems) console.log('  ', shortConn(a));

  console.log('\n──[2] listing with userIds=["kurumi"]──');
  const kRes = await composio.connectedAccounts.list({ userIds: ['kurumi'] });
  const kItems = Array.isArray(kRes) ? kRes : (kRes.items ?? kRes.data ?? []);
  console.log(`returned ${kItems.length} accounts:`);
  for (const a of kItems) console.log('  ', shortConn(a));

  console.log('\n──[3] minting MCP session: composio.create("kurumi", { manageConnections:false })──');
  const session = await composio.create('kurumi', { manageConnections: false });
  console.log('  session.sessionId =', session.sessionId);
  console.log('  mcp.url           =', session.mcp?.url);
  console.log('  mcp.headers keys  =', session.mcp?.headers ? Object.keys(session.mcp.headers) : null);

  console.log('\n──[4] MCP tools/list against session──');
  const tlRes = await fetch(session.mcp.url, {
    method:  'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...session.mcp.headers },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const tlText = await tlRes.text();
  let tlJson;
  try { tlJson = JSON.parse(tlText); }
  catch {
    // Composio returns SSE; extract the data: line(s)
    const m = tlText.match(/data:\s*(\{[\s\S]*?\})\s*$/m);
    if (m) tlJson = JSON.parse(m[1]);
  }
  const tools = tlJson?.result?.tools ?? [];
  console.log(`  got ${tools.length} tools; googlesheets ones:`);
  for (const t of tools.filter(t => /googlesheets/i.test(t.name))) console.log('    ', t.name);

  console.log('\n──[5] executing GOOGLESHEETS_SEARCH_SPREADSHEETS via MCP──');
  const exRes = await fetch(session.mcp.url, {
    method:  'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...session.mcp.headers },
    body:    JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'GOOGLESHEETS_SEARCH_SPREADSHEETS', arguments: { max_results: 5, search_type: 'both' } },
    }),
  });
  const exText = await exRes.text();
  let exJson;
  try { exJson = JSON.parse(exText); }
  catch { const m = exText.match(/data:\s*(\{[\s\S]*?\})\s*$/m); if (m) exJson = JSON.parse(m[1]); }
  console.log('  result:', JSON.stringify(exJson, null, 2).slice(0, 1500));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
