// Standalone MCP stdio server for Claude Desktop and other stdio MCP clients.
// Exposes the curated external tool surface (ask_alfred, list_agents,
// search_memory, find_tasks). No auth required — this process is spawned
// locally by the MCP client and inherits the user's environment.
//
// Usage: npm run mcp:stdio
// Claude Desktop config: { "command": "node", "args": ["dist/mcp/stdio-server.js"] }

import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from '../db';
import { createNeuroclawHttpMcpServer } from '../tools/adapters/http-mcp';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  // Silence logger to stderr so stdout stays clean for MCP framing.
  // MCP protocol uses stdout for JSON-RPC messages — any stdout noise breaks it.
  logger.info  = (msg: string, data?: unknown) => { process.stderr.write(`[info] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`); };
  logger.warn  = (msg: string, data?: unknown) => { process.stderr.write(`[warn] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`); };
  logger.error = (msg: string, data?: unknown) => { process.stderr.write(`[error] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`); };
  logger.debug = (msg: string, data?: unknown) => { process.stderr.write(`[debug] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`); };

  // Initialize SQLite (idempotent — runs schema + migrations).
  getDb();

  const server    = createNeuroclawHttpMcpServer({ clientType: 'external' });
  const transport = new StdioServerTransport();

  await server.connect(transport);
  // server.connect() blocks until the transport closes (client disconnects).
}

main().catch((err) => {
  process.stderr.write(`NeuroClaw MCP stdio server error: ${err}\n`);
  process.exit(1);
});
