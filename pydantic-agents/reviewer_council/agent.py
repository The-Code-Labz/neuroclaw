"""Reviewer Council — three narrow JSON reviewers for the orchestrator's
build → review → patch loop.

Tools (all return strict JSON):
  review_code_quality(request, artifact)         -> verdict
  review_runtime(request, artifact, logs="")     -> verdict
  review_completion(request, artifact)           -> verdict

Verdict schema:
  {"passed": bool, "severity": "none"|"low"|"medium"|"high"|"critical",
   "issues": [{"location": str, "problem": str, "fix": str, "severity": str}],
   "summary": str}
"""

from __future__ import annotations

import json
import os

from dotenv import load_dotenv
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from fastmcp import FastMCP

load_dotenv()

MODEL_NAME = os.getenv("PYDANTIC_AGENT_MODEL", "gpt-5.1")
PORT = int(os.getenv("PYDANTIC_REVIEWER_COUNCIL_PORT", "7102"))

provider = OpenAIProvider(
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1"),
    api_key=os.environ["OPENAI_API_KEY"],
)
model = OpenAIModel(MODEL_NAME, provider=provider)

JSON_RULES = (
    "\n\nOutput STRICT JSON only — no prose, no code fences. Schema:\n"
    '{"passed": bool, "severity": "none"|"low"|"medium"|"high"|"critical",'
    ' "issues": [{"location": str, "problem": str, "fix": str, "severity": str}],'
    ' "summary": str}\n'
    "Set passed=false if any issue has severity high or critical. "
    "Empty issues array is valid when passed=true."
)

code_quality = Agent(
    model=model,
    system_prompt=(
        "You are a CODE QUALITY reviewer. You evaluate ONE narrow dimension only: "
        "code-level quality of the artifact. Look for bugs, weak typing, duplication, "
        "dead code, unsafe patterns, missing error handling at system boundaries, "
        "naming that obscures intent. Do NOT comment on UX, completeness, or whether "
        "the user's request was answered — those are other reviewers' jobs."
    )
    + JSON_RULES,
)

runtime = Agent(
    model=model,
    system_prompt=(
        "You are a RUNTIME reviewer. You evaluate ONE narrow dimension only: would "
        "this artifact actually run / execute / render correctly? Look for undefined "
        "references, type mismatches, broken imports, unhandled async errors, "
        "infinite loops, resource leaks, missing dependencies. If logs are provided, "
        "use them as ground truth. Do NOT comment on style or completeness."
    )
    + JSON_RULES,
)

completion = Agent(
    model=model,
    system_prompt=(
        "You are a COMPLETION reviewer. You evaluate ONE narrow dimension only: "
        "does the artifact actually fulfill the user's original request? Check every "
        "explicit requirement and reasonable implicit one. Missing requirements = "
        "severity high. Do NOT comment on code quality or runtime issues — only "
        "whether the user got what they asked for."
    )
    + JSON_RULES,
)


def _coerce_json(raw: str) -> str:
    s = raw.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.lower().startswith("json"):
            s = s[4:]
        s = s.strip()
    try:
        json.loads(s)
        return s
    except json.JSONDecodeError:
        return json.dumps(
            {
                "passed": False,
                "severity": "low",
                "issues": [
                    {
                        "location": "reviewer",
                        "problem": "invalid JSON output",
                        "fix": "retry",
                        "severity": "low",
                    }
                ],
                "summary": "reviewer returned malformed JSON",
            }
        )


async def _run(agent: Agent, request: str, artifact: str, extra: str = "") -> str:
    prompt = f"## User request\n{request}\n\n## Artifact under review\n{artifact}"
    if extra:
        prompt += f"\n\n## Additional context\n{extra}"
    result = await agent.run(prompt)
    return _coerce_json(result.output)


mcp = FastMCP("reviewer-council")


@mcp.tool()
async def review_code_quality(request: str, artifact: str) -> str:
    """Review artifact for code-quality issues. Returns strict JSON verdict."""
    return await _run(code_quality, request, artifact)


@mcp.tool()
async def review_runtime(request: str, artifact: str, logs: str = "") -> str:
    """Review artifact for runtime/execution issues. Optional logs as ground truth."""
    extra = f"Logs:\n{logs}" if logs else ""
    return await _run(runtime, request, artifact, extra=extra)


@mcp.tool()
async def review_completion(request: str, artifact: str) -> str:
    """Review whether artifact fulfills the user's original request."""
    return await _run(completion, request, artifact)


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
