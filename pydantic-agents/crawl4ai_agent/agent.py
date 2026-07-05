"""crawl4ai agent — web crawling and structured extraction, exposed as an MCP server.

Tools:
  crawl_page(url, format)           — single URL → clean markdown or HTML
  deep_crawl(url, ...)              — BFS multi-page crawl → markdown report
  extract_structured(url, schema_json) — LLM schema-driven extraction → JSON
"""

from __future__ import annotations

import json
import os
import re

from dotenv import load_dotenv
from crawl4ai import (
    AsyncWebCrawler,
    BFSDeepCrawlStrategy,
    BrowserConfig,
    CacheMode,
    CrawlerRunConfig,
    LLMConfig,
    LLMExtractionStrategy,
)
from fastmcp import FastMCP

load_dotenv()

PORT = int(os.getenv("PYDANTIC_CRAWL4AI_PORT", "7105"))
MAX_PAGES_CAP = int(os.getenv("CRAWL4AI_DEEP_MAX_PAGES", "50"))
MODEL_NAME = os.getenv("PYDANTIC_AGENT_MODEL", "gpt-5.1")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1")
OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]

mcp = FastMCP("crawl4ai")


def _get_markdown(result) -> str:
    """Safely extract markdown string from a CrawlResult.

    crawl4ai 0.8.x returns result.markdown as a MarkdownGenerationResult object.
    Older versions return a plain string. This handles both.
    """
    md = result.markdown
    if md is None:
        return ""
    if hasattr(md, "raw_markdown"):
        return md.raw_markdown or ""
    return str(md)


@mcp.tool()
async def crawl_page(url: str, format: str = "markdown") -> str:
    """Fetch a single URL and return clean LLM-ready content.

    Args:
        url: The page URL to crawl.
        format: "markdown" (default) for clean markdown, "html" for raw HTML.

    Returns:
        Extracted page content as a string.
    """
    browser_cfg = BrowserConfig(headless=True, verbose=False)
    run_cfg = CrawlerRunConfig(cache_mode=CacheMode.BYPASS)

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        result = await crawler.arun(url=url, config=run_cfg)

    if not result.success:
        return f"Error crawling {url}: {result.error_message}"

    if format == "html":
        return result.html or ""
    return _get_markdown(result)


@mcp.tool()
async def deep_crawl(
    url: str,
    max_pages: int = 10,
    max_depth: int = 2,
    url_filter: str | None = None,
) -> str:
    """BFS multi-page crawl starting from a root URL.

    Crawls up to `max_pages` pages (capped at CRAWL4AI_DEEP_MAX_PAGES env var)
    up to `max_depth` link-hops from the start URL.

    Args:
        url: Root URL to start crawling from.
        max_pages: Maximum number of pages to crawl (default 10, max 50).
        max_depth: Maximum link depth from the root URL (default 2).
        url_filter: Optional regex — only include pages whose URL matches.

    Returns:
        A markdown report with each crawled page's content and URL.
    """
    max_pages = min(max_pages, MAX_PAGES_CAP)

    compiled_filter: re.Pattern | None = None
    if url_filter is not None:
        try:
            compiled_filter = re.compile(url_filter)
        except re.error as exc:
            return f"Invalid url_filter regex: {exc}"

    strategy = BFSDeepCrawlStrategy(max_depth=max_depth, max_pages=max_pages)
    browser_cfg = BrowserConfig(headless=True, verbose=False)
    run_cfg = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        deep_crawl_strategy=strategy,
    )

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        results = await crawler.arun(url=url, config=run_cfg)

    # arun with deep crawl returns a list of CrawlResult
    if not isinstance(results, list):
        results = [results]

    parts: list[str] = []
    for r in results:
        if compiled_filter is not None and not compiled_filter.search(r.url):
            continue
        if not r.success:
            parts.append(f"## {r.url}\n\n*Error: {r.error_message}*\n")
            continue
        content = _get_markdown(r)
        snippet = content[:2000].strip()
        if len(content) > 2000:
            snippet += "\n\n*(truncated)*"
        parts.append(f"## {r.url}\n\n{snippet}\n")

    return "\n---\n".join(parts) if parts else "No pages crawled."


@mcp.tool()
async def extract_structured(url: str, schema_json: str) -> str:
    """Extract structured data from a page using LLM-driven schema extraction.

    Args:
        url: The page URL to extract data from.
        schema_json: A JSON string describing the extraction schema, e.g.:
                     '{"type":"object","properties":{"title":{"type":"string"}}}'

    Returns:
        Extracted data as a JSON string, or an error message.
    """
    try:
        schema_dict = json.loads(schema_json)
    except json.JSONDecodeError as exc:
        return f"Invalid schema JSON: {exc}"

    llm_cfg = LLMConfig(
        provider=f"openai/{MODEL_NAME}",
        api_token=OPENAI_API_KEY,
        base_url=OPENAI_BASE_URL,
    )
    extraction_strategy = LLMExtractionStrategy(
        llm_config=llm_cfg,
        schema=schema_dict,
        extraction_type="schema",
    )

    browser_cfg = BrowserConfig(headless=True, verbose=False)
    run_cfg = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        extraction_strategy=extraction_strategy,
    )

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        result = await crawler.arun(url=url, config=run_cfg)

    if not result.success:
        return f"Error crawling {url}: {result.error_message}"

    return result.extracted_content or "{}"


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
