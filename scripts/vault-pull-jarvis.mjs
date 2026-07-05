#!/usr/bin/env node
/**
 * Pull all Jarvis-related files from the batfamily vault.
 * Uses the VaultMind MCP directly via SSE transport.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const VAULT_URL = 'https://n8n.your-domain.com/mcp/vaultmind-mcp';

async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  // unwrap content blocks
  const content = res?.content;
  if (Array.isArray(content)) {
    const texts = content.filter(c => c.type === 'text').map(c => c.text);
    try { return JSON.parse(texts.join('')); } catch { return texts.join(''); }
  }
  return res;
}

async function main() {
  const transport = new SSEClientTransport(new URL(VAULT_URL));
  const client = new Client({ name: 'jarvis-pull', version: '1.0' });
  await client.connect(transport);

  // 1. List vaults to get batfamily vault_id
  console.log('=== Listing vaults ===');
  const vaultsRaw = await callTool(client, 'list_vaults', {});
  console.log(JSON.stringify(vaultsRaw, null, 2));

  // Find batfamily
  let batfamilyId = null;
  const vaultList = vaultsRaw?.data?.vaults ?? vaultsRaw?.vaults ?? (Array.isArray(vaultsRaw) ? vaultsRaw : []);
  for (const v of vaultList) {
    console.log(`Vault: ${v.name} (${v.id})`);
    if (v.name?.toLowerCase() === 'batfamily') batfamilyId = v.id;
  }

  if (!batfamilyId) {
    console.error('batfamily vault not found. Available vaults above.');
    await client.close();
    return;
  }
  console.log(`\nbatfamily vault_id: ${batfamilyId}\n`);

  // 2. Search for all Jarvis files
  console.log('=== Searching: jarvis ===');
  const searchResults = await callTool(client, 'search_vault', {
    vault_id: batfamilyId,
    q: 'jarvis',
    limit: 50,
  });
  console.log(JSON.stringify(searchResults, null, 2));

  // 3. Try to list all files under agents/jarvis
  console.log('\n=== Listing files ===');
  const files = await callTool(client, 'list_files', { vault_id: batfamilyId });
  const allFiles = files?.data?.files ?? files?.files ?? (Array.isArray(files) ? files : []);
  const jarvisFiles = allFiles.filter(f => 
    f?.path?.toLowerCase().includes('jarvis') || 
    f?.name?.toLowerCase().includes('jarvis')
  );
  console.log(`Total files in vault: ${allFiles.length}`);
  console.log(`Jarvis files found: ${jarvisFiles.length}`);
  console.log(JSON.stringify(jarvisFiles, null, 2));

  // 4. Read each Jarvis file
  for (const file of jarvisFiles) {
    const path = file.path ?? file.name ?? file.id;
    if (!path) continue;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`FILE: ${path}`);
    console.log('='.repeat(60));
    try {
      const content = await callTool(client, 'read_file', { vault_id: batfamilyId, path });
      const text = content?.data?.content ?? content?.content ?? content;
      console.log(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
    } catch (e) {
      console.error(`Failed to read ${path}: ${e.message}`);
    }
  }

  await client.close();
}

main().catch(console.error);
