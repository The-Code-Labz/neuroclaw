// Thin re-export of the unified Claude SDK adapter. Kept at this path so
// existing import sites (src/providers/claude-cli.ts) don't need to change.
// The actual tool definitions live in src/tools/registry.ts and are shared
// across all three runtimes (OpenAI, Claude SDK, HTTP MCP).

export { createNeuroclawMcpServer, type NeuroclawMcpOptions } from '../tools/adapters/claude-sdk';
