"""Deep Research agent — multi-pass Tavily search + synthesis, exposed as an MCP server.

Tool: deep_research_tool(query: str) -> str
  1. Decomposes the query into 3 sub-questions.
  2. Runs Tavily search for each sub-question in parallel.
  3. Asks the LLM to synthesize a comprehensive markdown report citing sources.
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
PORT = int(os.getenv("PYDANTIC_DEEP_RESEARCH_PORT", "7100"))

provider = OpenAIProvider(
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1"),
    api_key=os.environ["OPENAI_API_KEY"],
)
model = OpenAIModel(MODEL_NAME, provider=provider)
tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])

planner = Agent(
    model=model,
    system_prompt=(
        "You break a research question into exactly 3 focused sub-questions that, "
        "when answered together, would give a complete picture. Reply with a JSON "
        "array of 3 strings and nothing else."
    ),
)

synthesizer = Agent(
    model=model,
    system_prompt=(
        "You write comprehensive markdown research reports. You will be given a "
        "user query and a list of web-search results (title, url, snippet). "
        "Produce a well-structured report with section headers, key findings, "
        "and a Sources section that cites every URL you used."
    ),
)


async def _search(question: str) -> list[dict]:
    res = await asyncio.to_thread(
        tavily.search, query=question, max_results=5, search_depth="advanced"
    )
    return res.get("results", [])


def _parse_subquestions(raw: str, fallback: str) -> list[str]:
    """Tolerate code-fenced or otherwise messy LLM output."""
    s = raw.strip()
    if s.startswith("```"):
        # strip ```json\n...``` or ```\n...```
        s = s.strip("`")
        if s.lower().startswith("json"):
            s = s[4:]
        s = s.strip()
    try:
        parsed = json.loads(s)
        if isinstance(parsed, list) and parsed:
            return [str(q) for q in parsed]
    except json.JSONDecodeError:
        pass
    return [fallback]


async def deep_research(query: str) -> str:
    plan_result = await planner.run(query)
    sub_questions = _parse_subquestions(plan_result.output, fallback=query)

    search_results = await asyncio.gather(*(_search(q) for q in sub_questions))
    flat: list[dict] = []
    for q, results in zip(sub_questions, search_results):
        for r in results:
            flat.append({
                "sub_question": q,
                "title": r.get("title"),
                "url": r.get("url"),
                "content": r.get("content"),
            })

    synthesis_input = (
        f"User query: {query}\n\n"
        f"Sub-questions explored:\n"
        + "\n".join(f"- {q}" for q in sub_questions)
        + "\n\n"
        f"Search results:\n{json.dumps(flat, indent=2)}"
    )
    report = await synthesizer.run(synthesis_input)
    return report.output


mcp = FastMCP("deep-research")


@mcp.tool()
async def deep_research_tool(query: str) -> str:
    """Run a multi-pass deep research investigation. Returns a markdown report with cited sources."""
    return await deep_research(query)


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
