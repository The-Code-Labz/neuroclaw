---
title: MCP servers (Pydantic side)
order: 40
external_url: https://ai.pydantic.dev/mcp/
---

# Pydantic AI — MCP servers (external)

Pydantic AI agents can both **consume** MCP servers (calling remote tools) and **expose themselves** as MCP servers (so other agents — including NeuroClaw — can call them).

The example agents in `pydantic-agents/` use `fastmcp` to expose themselves over HTTP. NeuroClaw's MCP server registry then registers them and the bridge wires them up as first-class agents.

→ Read the official docs at ai.pydantic.dev/mcp/
