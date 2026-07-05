[**NeuroClaw API Reference v1.0.0**](../../../README.md)

***

[NeuroClaw API Reference](../../../README.md) / [mcp/mcp-client](../README.md) / McpTransport

# Type Alias: McpTransport

> **McpTransport** = `"auto"` \| `"http"` \| `"sse"`

Defined in: [mcp/mcp-client.ts:15](https://github.com/The-Code-Labz/neuroclaw/blob/791fe5ba77fb43ab2d60adf130958117a3fa88ce/src/mcp/mcp-client.ts#L15)

Wire transport selector. 'auto' picks SSE for URLs ending in `/sse` or
 `/sse/` (n8n's MCP node, FastAPI MCP examples), otherwise Streamable HTTP.
