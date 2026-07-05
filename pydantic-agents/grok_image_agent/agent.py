"""Grok image agent — edits and composes images via xAI Grok, exposed as FastMCP.

Tools:
  grok_image_edit(prompt, image_path, quality)     — edit a single image
  grok_image_compose(prompt, image_paths, quality) — compose/blend multiple images
  grok_remember_image(image_path, label)           — store image under a named label
  grok_recall_image(label)                         — retrieve stored image path

Returns: "path: /abs/path/image.png\\ndescription: <prompt>" or "Error: ..."
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastmcp import FastMCP
from openai import AsyncOpenAI

load_dotenv()

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

PORT = int(os.getenv("GROK_IMAGE_AGENT_PORT", "7112"))

_AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.environ.get("GROK_IMAGE_OUTPUT_DIR") or os.path.join(_AGENT_DIR, "outputs")

# Session memory — module-level, shared across all callers (single-user setup)
_memory: dict[str, str] = {}
_last_image: Optional[str] = None
_memory_lock = asyncio.Lock()

mcp = FastMCP("grok-image-agent")


@dataclass
class XaiCredentials:
    bearer: str
    base_url: str


def resolve_xai_credentials() -> Optional[XaiCredentials]:
    auth_path = Path.home() / ".hermes" / "auth.json"
    try:
        store = json.loads(auth_path.read_text())
        pool = store.get("credential_pool", {}).get("xai-oauth", [])
        if pool:
            entry = next(
                (e for e in pool if e.get("last_status") == "ok" and e.get("access_token")),
                pool[0],
            )
            bearer = str(entry.get("access_token", "")).strip()
            base_url = (
                str(entry.get("base_url", "https://api.x.ai/v1")).strip().rstrip("/")
            )
            if bearer:
                return XaiCredentials(bearer=bearer, base_url=base_url)
    except FileNotFoundError:
        logger.warning("~/.hermes/auth.json not found, trying XAI_API_KEY")
    except PermissionError:
        logger.warning(
            "Cannot read ~/.hermes/auth.json (permission denied), trying XAI_API_KEY"
        )
    except (json.JSONDecodeError, ValueError):
        logger.warning("~/.hermes/auth.json is malformed, trying XAI_API_KEY")

    key = os.environ.get("XAI_API_KEY", "").strip()
    if key:
        logger.warning("Using XAI_API_KEY fallback (Hermes auth not available)")
        return XaiCredentials(bearer=key, base_url="https://api.x.ai/v1")

    return None


_MAGIC: list[tuple[bytes, str]] = [
    (b"\x89PNG", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
]


def _get_mime(path: str) -> Optional[str]:
    """Return 'image/png' or 'image/jpeg' if the file header matches; None otherwise."""
    try:
        with open(path, "rb") as f:
            header = f.read(8)
        for magic, mime in _MAGIC:
            if header.startswith(magic):
                return mime
        return None
    except OSError:
        return None


async def _describe_image_from_path(client: AsyncOpenAI, image_path: str) -> str:
    """Validate, load, and describe an image via grok-4.3 vision.

    Raises ValueError with a user-friendly message for file/type errors.
    Lets API exceptions propagate for the caller to handle.
    """
    if not os.path.exists(image_path):
        raise ValueError(f"image not found: {image_path}")
    mime = _get_mime(image_path)
    if mime is None:
        raise ValueError(f"unsupported file type: {image_path}")
    b64 = base64.b64encode(Path(image_path).read_bytes()).decode()
    resp = await client.chat.completions.create(
        model="grok-4.3",
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Describe this image in exhaustive detail: "
                        "composition, colors, style, subjects, background, lighting, mood."
                    ),
                },
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                },
            ],
        }],
    )
    content = resp.choices[0].message.content
    if not content:
        raise ValueError("vision model returned empty description")
    return content


async def _generate_and_save(client: AsyncOpenAI, prompt: str, quality: str) -> str:
    """Call grok image generation and save the result to OUTPUT_DIR.

    Returns the absolute path to the saved PNG.
    Raises ValueError if the API returns no image data.
    """
    model = (
        "grok-imagine-image-quality" if quality == "hd" else "grok-imagine-image"
    )
    resp = await client.images.generate(model=model, prompt=prompt, n=1)
    image_obj = resp.data[0]
    path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4().hex}.png")
    if getattr(image_obj, "b64_json", None):
        Path(path).write_bytes(base64.b64decode(image_obj.b64_json))
    elif getattr(image_obj, "url", None):
        # The xAI image CDN (imgen.x.ai) returns 403 to the default Python-urllib
        # User-Agent; a browser UA is required to fetch the generated image.
        # (urllib.request.urlretrieve has no way to set headers, hence urlopen.)
        def _fetch(u: str) -> bytes:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()

        Path(path).write_bytes(await asyncio.to_thread(_fetch, image_obj.url))
    else:
        raise ValueError("No image data in API response")
    return os.path.abspath(path)


@mcp.tool()
async def grok_image_edit(
    prompt: str, image_path: str, quality: str = "standard"
) -> str:
    """Edit an image using a natural-language prompt via Grok vision + image generation.

    quality: 'standard' (default) or 'hd'
    Returns: 'path: /abs/path/image.png\\ndescription: <prompt>' or 'Error: ...'
    """
    try:
        creds = resolve_xai_credentials()
        if not creds:
            return (
                "Error: no xAI credentials — "
                "set XAI_API_KEY or run hermes auth add xai-oauth"
            )
        client = AsyncOpenAI(api_key=creds.bearer, base_url=creds.base_url)

        try:
            description = await _describe_image_from_path(client, image_path)
        except ValueError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error: vision step failed: {type(e).__name__}: {e}"

        gen_prompt = f"Image content: {description}. Edit instruction: {prompt}"

        try:
            saved_path = await _generate_and_save(client, gen_prompt, quality)
        except Exception as e:
            return f"Error: generation failed: {type(e).__name__}: {e}"

        async with _memory_lock:
            global _last_image
            _last_image = saved_path

        return f"path: {saved_path}\ndescription: {prompt}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


_ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"]


@mcp.tool()
async def grok_image_compose(
    prompt: str, image_paths: list[str], quality: str = "standard"
) -> str:
    """Composite or blend multiple images guided by a natural-language prompt.

    image_paths: ordered list of absolute paths (order matters — referenced as
                 'First image', 'Second image', etc. in the generation prompt).
    quality: 'standard' (default) or 'hd'
    Returns: 'path: /abs/path/image.png\\ndescription: <prompt>' or 'Error: ...'
    """
    try:
        creds = resolve_xai_credentials()
        if not creds:
            return (
                "Error: no xAI credentials — "
                "set XAI_API_KEY or run hermes auth add xai-oauth"
            )
        client = AsyncOpenAI(api_key=creds.bearer, base_url=creds.base_url)

        descriptions: list[str] = []
        for i, path in enumerate(image_paths):
            try:
                desc = await _describe_image_from_path(client, path)
            except ValueError as e:
                return f"Error: {e}"
            except Exception as e:
                return f"Error: vision step failed on image {i + 1}: {type(e).__name__}: {e}"
            label = _ORDINALS[i] if i < len(_ORDINALS) else f"Image {i + 1}"
            descriptions.append(f"{label} image: {desc}")

        gen_prompt = (
            ". ".join(descriptions) + f". Composition instruction: {prompt}"
        )

        try:
            saved_path = await _generate_and_save(client, gen_prompt, quality)
        except Exception as e:
            return f"Error: generation failed: {type(e).__name__}: {e}"

        async with _memory_lock:
            global _last_image
            _last_image = saved_path

        return f"path: {saved_path}\ndescription: {prompt}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


@mcp.tool()
async def grok_remember_image(image_path: str, label: str) -> str:
    """Store an image path under a named label for later retrieval."""
    try:
        async with _memory_lock:
            _memory[label] = image_path
        return f"Remembered '{label}': {image_path}"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


@mcp.tool()
async def grok_recall_image(label: str = "") -> str:
    """Retrieve a stored image path. Omit label to get the last generated image."""
    try:
        if label:
            if label not in _memory:
                return f"Error: no image remembered as '{label}'"
            return _memory[label]
        if _last_image is None:
            return "Error: no image in memory yet"
        return _last_image
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"

# ── Startup ────────────────────────────────────────────────────────────────────

try:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
except Exception as _exc:
    logger.error("Cannot create outputs dir %s: %s", OUTPUT_DIR, _exc)
    sys.exit(1)


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)

