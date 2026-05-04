# Pydantic AI Agents

External Python agents NeuroClaw can talk to over MCP. Each agent is a standalone
process that exposes itself as an MCP HTTP server. Register the URL in NeuroClaw's
dashboard (MCP Servers tab), then create an Agent with provider=`mcp` pointing
at one of the server's tools.

## Install

```bash
cd pydantic-agents
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in OPENAI_API_KEY and TAVILY_API_KEY
```

## Run

From the repo root:
```bash
npm run pydantic:run
```

Or directly:
```bash
cd pydantic-agents && ./run-all.sh
```

## Register in NeuroClaw

1. Open the dashboard → MCP Servers → Add server
   - Deep Research: `http://localhost:7100/mcp`
   - Web Research:  `http://localhost:7101/mcp`
   - Transport: `http`
2. Probe — confirm tool list appears.
3. Open Agents → Create agent
   - Provider: `mcp`
   - MCP Server: pick one
   - Tool: `deep_research_tool` or `web_search_summarize_tool`
   - Input field: `query`

The agent now appears as `@DeepResearch` in Discord/CLI and as `agent__deepresearch(query)` in every other agent's tool list.
