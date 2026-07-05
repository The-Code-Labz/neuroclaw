"""GitHub agent — Pydantic AI agent with GitHub API tools, exposed as FastMCP.

The agent can:
  - get_repo_info: metadata (size, stars, language, dates)
  - get_repo_structure: recursive directory tree
  - get_file_content: raw file contents from any path

Exposed as a single MCP tool: github_analyze(query, github_url)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

import httpx
from dotenv import load_dotenv
from fastmcp import FastMCP
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel as OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider

load_dotenv()

PORT = int(os.getenv("PYDANTIC_GITHUB_AGENT_PORT", "7104"))
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

provider = OpenAIProvider(
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1"),
    api_key=os.environ["OPENAI_API_KEY"],
)
model = OpenAIModel(os.getenv("PYDANTIC_AGENT_MODEL", "gpt-4.1"), provider=provider)


@dataclass
class GitHubDeps:
    client: httpx.AsyncClient
    github_token: str | None = None


github_agent = Agent(
    model,
    system_prompt=(
        "You are a coding expert with access to GitHub to help the user manage their "
        "repository and get information from it. Your only job is to assist with this. "
        "Don't ask the user before taking an action, just do it. Always look at the "
        "repository with the provided tools before answering unless you already have. "
        "When answering about a repo, start with the full repo URL in brackets then "
        "your answer on a new line."
    ),
    deps_type=GitHubDeps,
    retries=2,
)


def _parse_repo_url(github_url: str) -> tuple[str, str] | str:
    match = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?(?:/.*)?$", github_url)
    if not match:
        return "Invalid GitHub URL format"
    return match.group(1), match.group(2)


def _auth_headers(token: str | None) -> dict:
    return {"Authorization": f"token {token}"} if token else {}


@github_agent.tool
async def get_repo_info(ctx: RunContext[GitHubDeps], github_url: str) -> str:
    """Get repository metadata: description, size, stars, language, and timestamps."""
    parsed = _parse_repo_url(github_url)
    if isinstance(parsed, str):
        return parsed
    owner, repo = parsed

    resp = await ctx.deps.client.get(
        f"https://api.github.com/repos/{owner}/{repo}",
        headers=_auth_headers(ctx.deps.github_token),
    )
    if resp.status_code != 200:
        return f"Failed to get repository info: {resp.text}"

    d = resp.json()
    return (
        f"Repository: {d['full_name']}\n"
        f"Description: {d['description']}\n"
        f"Size: {d['size'] / 1024:.1f}MB\n"
        f"Stars: {d['stargazers_count']}\n"
        f"Language: {d['language']}\n"
        f"Created: {d['created_at']}\n"
        f"Last Updated: {d['updated_at']}"
    )


@github_agent.tool
async def get_repo_structure(ctx: RunContext[GitHubDeps], github_url: str) -> str:
    """Get the full recursive directory structure of a GitHub repository."""
    parsed = _parse_repo_url(github_url)
    if isinstance(parsed, str):
        return parsed
    owner, repo = parsed
    headers = _auth_headers(ctx.deps.github_token)

    resp = await ctx.deps.client.get(
        f"https://api.github.com/repos/{owner}/{repo}/git/trees/main?recursive=1",
        headers=headers,
    )
    if resp.status_code != 200:
        resp = await ctx.deps.client.get(
            f"https://api.github.com/repos/{owner}/{repo}/git/trees/master?recursive=1",
            headers=headers,
        )
    if resp.status_code != 200:
        return f"Failed to get repository structure: {resp.text}"

    excluded = {".git/", "node_modules/", "__pycache__/"}
    lines = []
    for item in resp.json()["tree"]:
        if not any(ex in item["path"] for ex in excluded):
            prefix = "📁 " if item["type"] == "tree" else "📄 "
            lines.append(f"{prefix}{item['path']}")

    return "\n".join(lines)


@github_agent.tool
async def get_file_content(ctx: RunContext[GitHubDeps], github_url: str, file_path: str) -> str:
    """Get the raw content of a specific file from a GitHub repository."""
    parsed = _parse_repo_url(github_url)
    if isinstance(parsed, str):
        return parsed
    owner, repo = parsed
    headers = _auth_headers(ctx.deps.github_token)

    for branch in ("main", "master"):
        resp = await ctx.deps.client.get(
            f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{file_path}",
            headers=headers,
        )
        if resp.status_code == 200:
            return resp.text

    return f"Failed to get file content: {resp.text}"


mcp = FastMCP("github-agent")


@mcp.tool()
async def github_analyze(query: str, github_url: str) -> str:
    """Analyze a GitHub repository. Provide a natural language query and the repo URL."""
    async with httpx.AsyncClient() as client:
        deps = GitHubDeps(client=client, github_token=GITHUB_TOKEN)
        result = await github_agent.run(query, deps=deps)
        return result.output


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
