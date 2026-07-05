---
title: Pydantic AI bridge
order: 30
---

# Pydantic AI bridge

NeuroClaw can register external Pydantic AI agents (Python) as first-class agents — routable from Discord/CLI/dashboard as `@AgentName` AND auto-exposed as tools every local agent can call mid-task.

## How it works

Pydantic AI agents run as standalone Python processes that expose themselves as MCP HTTP servers (via `fastmcp`). NeuroClaw's MCP server registry probes them and caches their tools. A `provider='mcp'` value on the `agents` table marks an agent as MCP-backed; `chatStreamMcp()` proxies the user message directly to a chosen MCP tool — no local LLM hop. The same backed agent is auto-synthesized as an `agent__<name>` tool in the unified tool registry, so any local agent can delegate to it mid-turn.

## Quick setup

Two example agents ship in `pydantic-agents/` (deep-research, web-research). To run them:

```bash
cd pydantic-agents
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in OPENAI_API_KEY and TAVILY_API_KEY
cd .. && npm run pydantic:run
```

Both agents bind to `localhost:7100` (deep-research) and `localhost:7101` (web-research).

## Register in the dashboard

1. **MCP Servers** tab → add server
   - Deep Research: `http://localhost:7100/mcp`, transport `http`
   - Web Research:  `http://localhost:7101/mcp`, transport `http`
   Probe each — both should reach status `ready` with 1 tool cached.
2. **Agents** tab → create agent
   - Provider: `mcp`
   - MCP Server: pick one
   - Tool: `deep_research_tool` or `web_search_summarize_tool`
   - Input field: `query`

The agent now appears as `@DeepResearch` (or whatever you named it) in CLI/Discord and as `agent__deepresearch(query)` in every other agent's tool list.

## Bring your own Pydantic agent

Anything that exposes itself as an MCP HTTP server works — not just the two examples. Drop a Python module in `pydantic-agents/<your_agent>/`, register it in `run-all.sh`, point the dashboard at the URL, done.

For framework patterns (tools, dependencies, evals), see the **Pydantic AI Framework** section in this wiki.
