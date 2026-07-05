"""Web Research agent — single-pass Tavily search + summary, exposed as MCP.

Tool: web_search_summarize_tool(query: str) -> str
  Runs one Tavily search (5 results), asks the LLM to produce a tight
  paragraph + bullet list summary with inline source links.
"""

from __future__ import annotations

import asyncio
import json
import os

from dotenv import load_dotenv
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from tavily import TavilyClient
from fastmcp import FastMCP

load_dotenv()

MODEL_NAME = os.getenv("PYDANTIC_AGENT_MODEL", "gpt-5.1")
PORT = int(os.getenv("PYDANTIC_WEB_RESEARCH_PORT", "7101"))

provider = OpenAIProvider(
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1"),
    api_key=os.environ["OPENAI_API_KEY"],
)
model = OpenAIModel(MODEL_NAME, provider=provider)
tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])

summarizer = Agent(
    model=model,
    system_prompt=(
        "You produce tight web-research summaries. Given a query and a list of "
        "search results, write a 2-3 sentence overview followed by 3-6 bullet "
        "points of key findings. Embed source URLs inline as markdown links."
    ),
)


async def _search(query: str) -> list[dict]:
    res = await asyncio.to_thread(tavily.search, query=query, max_results=5)
    return res.get("results", [])


async def web_search_summarize(query: str) -> str:
    results = await _search(query)
    summary = await summarizer.run(
        f"Query: {query}\n\nResults:\n{json.dumps(results, indent=2)}"
    )
    return summary.output


mcp = FastMCP("web-research")


@mcp.tool()
async def web_search_summarize_tool(query: str) -> str:
    """Search the web and return a concise summary with cited sources."""
    return await web_search_summarize(query)


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
