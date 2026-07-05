"""NotebookLM agent — wraps the notebooklm CLI as a FastMCP server.

Tools exposed:
  notebooklm_list()          — list all notebooks
  notebooklm_create(title)   — create a notebook
  notebooklm_use(id)         — set active notebook context
  notebooklm_status()        — show current notebook context
  notebooklm_ask(question)   — RAG query against the active notebook
  notebooklm_source_add(url) — add a URL, YouTube link, or file path
  notebooklm_source_list()   — list sources in active notebook
  notebooklm_generate(type, instructions) — generate artifacts (audio/report/quiz/etc.)
"""

from __future__ import annotations

import os
import subprocess
from dotenv import load_dotenv
from fastmcp import FastMCP

load_dotenv()

PORT = int(os.getenv("PYDANTIC_NOTEBOOKLM_PORT", "7103"))
NLM_BIN = os.getenv("NOTEBOOKLM_BIN", "/root/bin/notebooklm")

mcp = FastMCP("notebooklm")


def _run(*args: str, timeout: int = 120) -> str:
    result = subprocess.run(
        [NLM_BIN, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    out = result.stdout.strip()
    err = result.stderr.strip()
    if result.returncode != 0 and not out:
        return f"Error (exit {result.returncode}): {err or '(no output)'}"
    return out or err or "(no output)"


@mcp.tool()
def notebooklm_list() -> str:
    """List all NotebookLM notebooks."""
    return _run("list", "--json")


@mcp.tool()
def notebooklm_create(title: str) -> str:
    """Create a new NotebookLM notebook with the given title."""
    return _run("create", title)


@mcp.tool()
def notebooklm_use(notebook_id: str) -> str:
    """Set the active notebook context by notebook ID."""
    return _run("use", notebook_id)


@mcp.tool()
def notebooklm_status() -> str:
    """Show the current active notebook context."""
    return _run("status")


@mcp.tool()
def notebooklm_ask(question: str) -> str:
    """Ask the active notebook a question using RAG over its sources."""
    return _run("ask", question, timeout=120)


@mcp.tool()
def notebooklm_source_add(url_or_path: str) -> str:
    """Add a source to the active notebook. Accepts URLs, YouTube links, or local file paths."""
    return _run("source", "add", url_or_path, timeout=180)


@mcp.tool()
def notebooklm_source_list() -> str:
    """List all sources in the active notebook."""
    return _run("source", "list")


@mcp.tool()
def notebooklm_generate(artifact_type: str, instructions: str = "") -> str:
    """Generate a notebook artifact. artifact_type: audio | video | report | quiz | flashcards | infographic | mind-map | slide-deck. Optional instructions for customization."""
    args = ["generate", artifact_type]
    if instructions:
        args.append(instructions)
    return _run(*args, timeout=900)


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
