"""Image agent — generates and edits images via the VoidAI gpt-image-2 API, exposed as FastMCP.

Tool: image_agent(query: str) -> str
  - No file path in query → calls generate_image (text → new image)
  - File path present in query → calls edit_image (image + prompt → edited image)

Returns: "path: /abs/path/to/image.png\ndescription: ..."
"""

from __future__ import annotations

import asyncio
import base64
import os
import sys as _sys
_sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from shared.image_delivery import deliver_image
import urllib.request
import uuid
from dataclasses import dataclass

from dotenv import load_dotenv
from fastmcp import FastMCP
from openai import AsyncOpenAI
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel as OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider

load_dotenv()

PORT = int(os.getenv("PYDANTIC_IMAGE_AGENT_PORT", "7106"))

_AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.getenv("IMAGE_AGENT_OUTPUT_DIR") or os.path.join(_AGENT_DIR, "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

VALID_SIZES = {"1024x1024", "1024x1792", "1792x1024"}

provider = OpenAIProvider(
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1"),
    api_key=os.environ["OPENAI_API_KEY"],
)
model = OpenAIModel(os.getenv("PYDANTIC_AGENT_MODEL", "gpt-4.1"), provider=provider)

image_client = AsyncOpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.getenv("OPENAI_BASE_URL", "https://api.voidai.app/v1"),
)


def _normalize_size(size: str) -> tuple[str, str]:
    """Return (normalized_size, note). Note is non-empty if value was invalid."""
    if size in VALID_SIZES:
        return size, ""
    return "1024x1024", f"(unrecognized size '{size}'; defaulted to 1024x1024)"



async def _save_png(image_obj) -> str:
    """Save image response object (b64_json or url) to outputs dir. Returns abs path."""
    filename = f"{uuid.uuid4().hex}.png"
    path = os.path.join(OUTPUT_DIR, filename)
    if getattr(image_obj, "b64_json", None):
        with open(path, "wb") as f:
            f.write(base64.b64decode(image_obj.b64_json))
    elif getattr(image_obj, "url", None):
        await asyncio.to_thread(urllib.request.urlretrieve, image_obj.url, path)
    else:
        raise ValueError("No image data in API response")
    return os.path.abspath(path)


@dataclass
class ImageDeps:
    pass


image_ai_agent = Agent(
    model,
    system_prompt=(
        "You are an image generation assistant with two tools:\n"
        "- generate_image: call this when the query has NO file path — creates a new image from a text prompt.\n"
        "- edit_image: call this when the query CONTAINS a local file path — edits that image using a prompt.\n\n"
        "Always call the appropriate tool first. After the tool returns a file path, reply with exactly:\n"
        "path: <the returned path>\n"
        "description: <one sentence describing what the image shows>\n\n"
        "If the tool returns an error string starting with 'Error:', relay it as-is with no description line."
    ),
    deps_type=ImageDeps,
    retries=2,
)


@image_ai_agent.tool
async def generate_image(
    ctx: RunContext[ImageDeps],
    prompt: str,
    size: str = "1024x1024",
) -> str:
    """Generate a new image from a text prompt. Returns the absolute path to the saved PNG."""
    size, _ = _normalize_size(size)
    try:
        response = await image_client.images.generate(
            model="gpt-image-2",
            prompt=prompt,
            size=size,
            n=1,
        )
    except Exception as exc:
        return f"Error: {exc}"
    try:
        path = await _save_png(response.data[0])
    except Exception as exc:
        return f"Error saving image: {exc}"
    return path


@image_ai_agent.tool
async def edit_image(
    ctx: RunContext[ImageDeps],
    image_path: str,
    prompt: str,
    size: str = "1024x1024",
) -> str:
    """Edit an existing image using a text prompt. Returns the absolute path to the saved PNG."""
    if not os.path.exists(image_path):
        return f"Error: image_path does not exist: {image_path}"
    size, _ = _normalize_size(size)
    try:
        with open(image_path, "rb") as f:
            response = await image_client.images.edit(
                model="gpt-image-2",
                image=f,
                prompt=prompt,
                size=size,
                n=1,
            )
    except Exception as exc:
        return f"Error: {exc}"
    try:
        path = await _save_png(response.data[0])
    except Exception as exc:
        return f"Error saving image: {exc}"
    return path


mcp = FastMCP("image-agent")


@mcp.tool()
async def image_agent(query: str) -> str:
    """Generate or edit images from natural language.
    Include a local file path in the query to edit an existing image."""
    try:
        result = await image_ai_agent.run(query, deps=ImageDeps())
        output = result.output
        # Post-process: insert delivery URLs after the path: line
        out_lines: list[str] = []
        for line in output.splitlines():
            if line.startswith("path: ") and not any(l.startswith("path: ") for l in out_lines):
                path_val = line[6:].strip()
                delivery = deliver_image(path_val)
                out_lines.append(f"path: {delivery.local_path}")
                if delivery.local_url:
                    out_lines.append(f"local_url: {delivery.local_url}")
                if delivery.public_url:
                    out_lines.append(f"public_url: {delivery.public_url}")
            else:
                out_lines.append(line)
        return "\n".join(out_lines)
    except Exception as exc:
        return f"Error: {exc}"


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
