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

## Run (host venv)

From the repo root:
```bash
npm run pydantic:run
```

Or directly:
```bash
cd pydantic-agents && ./run-all.sh
```

## Run (Docker, recommended for prod)

Each agent runs in its own container with `restart: unless-stopped`, so they
survive host reboots and a crash in one cannot affect the others. Ports are
published on `127.0.0.1` only, so NeuroClaw config does not change.

| Service             | Container         | Host port (loopback) |
|---------------------|-------------------|----------------------|
| deep-research       | pa-deep-research  | 7100                 |
| web-research        | pa-web-research   | 7101                 |
| reviewer-council    | pa-reviewer-council | 7102               |
| notebooklm          | pa-notebooklm     | 7103                 |
| github-agent        | pa-github-agent   | 7104                 |
| crawl4ai            | pa-crawl4ai       | 7105                 |
| image-agent         | pa-image-agent    | 7106                 |

```bash
cd pydantic-agents
cp .env.example .env       # fill in keys (NEVER bake them into images)

# Stop any host-running agents first (they will collide on the ports).
pkill -f 'python -m (deep_research|web_research|reviewer_council|notebooklm|github_agent|crawl4ai_agent|image_agent)\.agent' || true

make up        # build + start all 7 agents detached
make ps        # status
make logs      # tail all
make logs-deep-research   # tail one
make restart   # rolling restart (single agent: docker-compose restart deep-research)
make down      # stop everything (volumes preserved)
make rebuild   # rebuild images + recreate containers (after a code change)
```

### Persistence

- Generated images live in the **named volume** `pa-image-agent-outputs`
  (survives `make down` and `make rebuild`; only `make clean` deletes them).
- `notebooklm` container **bind-mounts** the host's notebooklm CLI venv
  (`/root/.notebooklm-venv`, read-only) and its auth/state dir
  (`/root/.notebooklm`, read-write) — no re-auth needed after restart.
- Each container has its own filesystem and process namespace, so an upgrade,
  crash, or `pip install` inside one agent cannot affect the others.

### How it works

`docker/launcher.py` imports the agent module (selected by `AGENT_MODULE` env
var), grabs its module-level `mcp` FastMCP instance, and calls
`mcp.run(host=0.0.0.0, port=$PORT)`. The upstream agent source is **not
modified** — `if __name__ == "__main__"` blocks (which hardcode
`host=127.0.0.1`) are simply bypassed.

Two images are used to keep things lean:
- `pydantic-agents/base` (python:3.12-slim + requirements.txt) — 6 of 7 agents.
- `pydantic-agents/crawl4ai` (Playwright base image with Chromium bundled) — only
  the crawl4ai agent.

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
