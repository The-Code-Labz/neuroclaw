# ChatGPT Image Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a FastMCP Python server that wraps ChatGPT's web UI for image generation and editing, exposing four tools NeuroClaw agents can call.

**Architecture:** Persistent Playwright Chromium context stores a logged-in ChatGPT session in a local profile dir. The `chatgpt_setup` / `chatgpt_setup_complete` tool pair handles one-time login. `chatgpt_image_generate` and `chatgpt_image_edit` launch headless browser sessions, submit prompts, wait for the generated image, download it via session cookies, and return the saved path.

**Tech Stack:** Python 3.12, `playwright` (async), `playwright-stealth`, `fastmcp`, `python-dotenv`

---

## File Map

| Action | Path | Purpose |
|---|---|---|
| Create | `pydantic-agents/chatgpt_image_agent/__init__.py` | Package marker |
| Create | `pydantic-agents/chatgpt_image_agent/agent.py` | FastMCP server — all 4 tools |
| Create | `pydantic-agents/docker/Dockerfile.chatgpt-image-agent` | Docker image |
| Modify | `pydantic-agents/requirements.txt` | Add `playwright`, `playwright-stealth` |
| Modify | `pydantic-agents/run-all.sh` | Start chatgpt_image_agent process |
| Modify | `.gitignore` | Ignore `profile/` and `outputs/` dirs |

---

## Task 1: Scaffold — dirs, package marker, gitignore, deps

**Files:**
- Create: `pydantic-agents/chatgpt_image_agent/__init__.py`
- Modify: `.gitignore`
- Modify: `pydantic-agents/requirements.txt`

- [ ] **Step 1: Create the package directory and marker**

```bash
mkdir -p pydantic-agents/chatgpt_image_agent
touch pydantic-agents/chatgpt_image_agent/__init__.py
```

- [ ] **Step 2: Add gitignore entries**

Open `.gitignore` and add these two lines after the existing `pydantic-agents/image_agent/outputs/` line:

```
pydantic-agents/chatgpt_image_agent/outputs/
pydantic-agents/chatgpt_image_agent/profile/
```

- [ ] **Step 3: Add dependencies to requirements.txt**

Open `pydantic-agents/requirements.txt` and append:

```
playwright>=1.44.0
playwright-stealth>=1.0.6
```

- [ ] **Step 4: Install deps and Playwright browser**

```bash
cd pydantic-agents
source .venv/bin/activate
pip install playwright playwright-stealth
playwright install chromium
```

Expected: `playwright install chromium` downloads ~200MB Chromium. Last line reads `Chromium ... downloaded to ...`

- [ ] **Step 5: Commit scaffold**

```bash
git add pydantic-agents/chatgpt_image_agent/__init__.py .gitignore pydantic-agents/requirements.txt
git commit -m "feat(chatgpt-image-agent): scaffold package, gitignore, deps"
```

---

## Task 2: Core agent.py

**Files:**
- Create: `pydantic-agents/chatgpt_image_agent/agent.py`

- [ ] **Step 1: Create agent.py**

Create `pydantic-agents/chatgpt_image_agent/agent.py` with this full content:

```python
"""ChatGPT image agent — generates and edits images via ChatGPT's web UI, exposed as FastMCP.

Tools:
  chatgpt_setup()                          — open visible browser for first-time login
  chatgpt_setup_complete()                 — close setup browser, save session profile
  chatgpt_image_generate(prompt, style)    — text → image file
  chatgpt_image_edit(prompt, image_path)   — image + prompt → edited image file

Returns: "path: /abs/path/image.png\ndescription: <prompt>"
"""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastmcp import FastMCP
from playwright.async_api import async_playwright, BrowserContext, Page, Playwright

load_dotenv()

PORT       = int(os.getenv("CHATGPT_IMAGE_AGENT_PORT", "7110"))
HEADLESS   = os.getenv("CHATGPT_HEADLESS", "true").lower() != "false"

_AGENT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROFILE_DIR = os.getenv("CHATGPT_PROFILE_DIR") or os.path.join(_AGENT_DIR, "profile")
OUTPUT_DIR  = os.getenv("CHATGPT_IMAGE_OUTPUT_DIR") or os.path.join(_AGENT_DIR, "outputs")

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(PROFILE_DIR, exist_ok=True)

# Module-level state for the two-step setup flow.
# chatgpt_setup opens and stores the browser here; chatgpt_setup_complete closes it.
_setup_playwright: Optional[Playwright] = None
_setup_context:    Optional[BrowserContext] = None

mcp = FastMCP("chatgpt-image-agent")


def _style_suffix(style: str) -> str:
    if style == "vivid":
        return " — vivid, saturated, dramatic style"
    if style == "natural":
        return " — natural, photorealistic style"
    return ""


def _profile_exists() -> bool:
    p = Path(PROFILE_DIR)
    return p.exists() and any(p.iterdir())


async def _launch_context(headless: bool = True) -> tuple[Playwright, BrowserContext]:
    """Launch a persistent Chromium context with stealth patches applied."""
    from playwright_stealth import stealth_async  # type: ignore[import]

    pw = await async_playwright().start()
    context = await pw.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=headless,
        args=["--no-sandbox", "--disable-setuid-sandbox"],
    )
    for page in context.pages:
        await stealth_async(page)
    context.on("page", lambda p: asyncio.ensure_future(stealth_async(p)))
    return pw, context


async def _get_or_open_page(context: BrowserContext) -> Page:
    if context.pages:
        return context.pages[0]
    return await context.new_page()


async def _navigate_to_chatgpt(page: Page) -> None:
    """Navigate to chatgpt.com and wait for the chat input. Raises RuntimeError on session expiry."""
    await page.goto("https://chatgpt.com/", wait_until="domcontentloaded")
    if "auth" in page.url or "login" in page.url:
        raise RuntimeError("session_expired")
    await page.wait_for_selector("#prompt-textarea", timeout=30_000)


async def _submit_prompt(page: Page, text: str) -> None:
    """Fill the chat input and click Send."""
    textarea = await page.wait_for_selector("#prompt-textarea", timeout=10_000)
    await textarea.click()
    await textarea.fill(text)
    try:
        btn = await page.wait_for_selector('[data-testid="send-button"]', timeout=3_000)
    except Exception:
        btn = await page.wait_for_selector('button[aria-label*="Send"]', timeout=3_000)
    await btn.click()


async def _wait_for_image(page: Page) -> str:
    """Poll for a generated image in the assistant message. Returns URL or 'REFUSAL:<text>'."""
    primary  = '[data-message-author-role="assistant"] img[src*="oaiusercontent"]'
    fallback = '[data-message-author-role="assistant"] img[src]'

    async def _poll() -> str:
        while True:
            # Check for content-policy refusal
            try:
                el = await page.query_selector('[data-message-author-role="assistant"] p')
                if el:
                    text = await el.inner_text()
                    if text and any(w in text.lower() for w in
                                    ("i can't", "i'm unable", "i cannot", "i'm not able")):
                        return f"REFUSAL:{text}"
            except Exception:
                pass

            # Primary selector: oaiusercontent CDN image
            try:
                el = await page.query_selector(primary)
                if el:
                    src = await el.get_attribute("src")
                    if src and "oaiusercontent" in src:
                        return src
            except Exception:
                pass

            # Fallback: any new img tag in assistant message
            try:
                el = await page.query_selector(fallback)
                if el:
                    src = await el.get_attribute("src")
                    if src and src.startswith("http"):
                        return src
            except Exception:
                pass

            await asyncio.sleep(1)

    return await asyncio.wait_for(_poll(), timeout=120)


async def _download_image(page: Page, url: str) -> str:
    """Fetch image URL using session cookies. Returns absolute path to saved PNG."""
    response = await page.request.get(url)
    if not response.ok:
        raise RuntimeError(f"image download failed — {response.status}")
    body = await response.body()
    path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4().hex}.png")
    with open(path, "wb") as f:
        f.write(body)
    return os.path.abspath(path)


# ── Tools ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def chatgpt_setup() -> str:
    """Open a visible browser and navigate to ChatGPT. Log in, then call chatgpt_setup_complete."""
    global _setup_playwright, _setup_context
    if _setup_context:
        return "Setup browser already open. Log in and call chatgpt_setup_complete."
    try:
        _setup_playwright, _setup_context = await _launch_context(headless=False)
        page = await _get_or_open_page(_setup_context)
        await page.goto("https://chatgpt.com/", wait_until="domcontentloaded")
        return "Browser open — log in to ChatGPT, then call chatgpt_setup_complete."
    except Exception as exc:
        _setup_playwright = _setup_context = None
        return f"Error: {exc}"


@mcp.tool()
async def chatgpt_setup_complete() -> str:
    """Close the setup browser and save the session profile to disk."""
    global _setup_playwright, _setup_context
    if not _setup_context:
        return "Error: no setup browser open. Call chatgpt_setup first."
    try:
        await _setup_context.close()
        await _setup_playwright.stop()
        _setup_context = _setup_playwright = None
        return f"Session profile saved to {PROFILE_DIR}. Ready to generate images."
    except Exception as exc:
        _setup_context = _setup_playwright = None
        return f"Error saving profile: {exc}"


@mcp.tool()
async def chatgpt_image_generate(prompt: str, style: str = "auto") -> str:
    """Generate a new image from a text prompt via ChatGPT.
    style: 'auto' | 'vivid' | 'natural'
    Returns: 'path: /abs/path/image.png\\ndescription: <prompt>'"""
    if not _profile_exists():
        return "Error: run chatgpt_setup first"

    full_prompt = f"Generate an image: {prompt}{_style_suffix(style)}"
    pw: Optional[Playwright] = None
    ctx: Optional[BrowserContext] = None
    try:
        pw, ctx = await _launch_context(headless=HEADLESS)
        page = await _get_or_open_page(ctx)
        try:
            await _navigate_to_chatgpt(page)
        except RuntimeError as e:
            if "session_expired" in str(e):
                return "Error: session expired — run chatgpt_setup"
            raise
        await _submit_prompt(page, full_prompt)
        try:
            img_url = await _wait_for_image(page)
        except asyncio.TimeoutError:
            return "Error: generation timed out after 120s"
        if img_url.startswith("REFUSAL:"):
            return img_url[8:]
        path = await _download_image(page, img_url)
        return f"path: {path}\ndescription: {prompt}"
    except FileNotFoundError:
        return "Error: run playwright install chromium"
    except Exception as exc:
        return f"Error: {exc}"
    finally:
        if ctx:
            await ctx.close()
        if pw:
            await pw.stop()


@mcp.tool()
async def chatgpt_image_edit(prompt: str, image_path: str) -> str:
    """Edit an existing image using a prompt via ChatGPT.
    Returns: 'path: /abs/path/image.png\\ndescription: <prompt>'"""
    if not os.path.exists(image_path):
        return "Error: image_path not found"
    if not _profile_exists():
        return "Error: run chatgpt_setup first"

    pw: Optional[Playwright] = None
    ctx: Optional[BrowserContext] = None
    try:
        pw, ctx = await _launch_context(headless=HEADLESS)
        page = await _get_or_open_page(ctx)
        try:
            await _navigate_to_chatgpt(page)
        except RuntimeError as e:
            if "session_expired" in str(e):
                return "Error: session expired — run chatgpt_setup"
            raise

        # Upload the source image via the attachment button
        try:
            attach_btn = await page.wait_for_selector(
                '[data-testid="attach-file-button"], button[aria-label*="ttach"]',
                timeout=5_000,
            )
        except Exception:
            return "Error: could not find attachment button — ChatGPT UI may have changed"

        tag = await attach_btn.evaluate("el => el.tagName.toLowerCase()")
        if tag == "input":
            await attach_btn.set_input_files(image_path)
        else:
            await attach_btn.click()
            file_input = await page.wait_for_selector('input[type="file"]', timeout=5_000)
            await file_input.set_input_files(image_path)

        await asyncio.sleep(1)  # allow upload to register before submitting
        await _submit_prompt(page, prompt)

        try:
            img_url = await _wait_for_image(page)
        except asyncio.TimeoutError:
            return "Error: generation timed out after 120s"
        if img_url.startswith("REFUSAL:"):
            return img_url[8:]
        path = await _download_image(page, img_url)
        return f"path: {path}\ndescription: {prompt}"
    except FileNotFoundError:
        return "Error: run playwright install chromium"
    except Exception as exc:
        return f"Error: {exc}"
    finally:
        if ctx:
            await ctx.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=PORT)
```

- [ ] **Step 2: Verify server starts cleanly**

```bash
cd pydantic-agents
source .venv/bin/activate
python -m chatgpt_image_agent.agent &
sleep 3
curl -s http://127.0.0.1:7110/health || curl -s http://127.0.0.1:7110/
kill %1
```

Expected: No Python import errors. Server starts and accepts connections (any HTTP response, even 404, means it's up).

- [ ] **Step 3: Verify tool list is exposed**

```bash
cd pydantic-agents
source .venv/bin/activate
python -m chatgpt_image_agent.agent &
sleep 3
curl -s -X POST http://127.0.0.1:7110/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | python3 -m json.tool
kill %1
```

Expected: JSON response listing `chatgpt_setup`, `chatgpt_setup_complete`, `chatgpt_image_generate`, `chatgpt_image_edit`.

- [ ] **Step 4: Commit**

```bash
git add pydantic-agents/chatgpt_image_agent/agent.py
git commit -m "feat(chatgpt-image-agent): add FastMCP server with generate/edit/setup tools"
```

---

## Task 3: Dockerfile

**Files:**
- Create: `pydantic-agents/docker/Dockerfile.chatgpt-image-agent`

- [ ] **Step 1: Create Dockerfile**

Create `pydantic-agents/docker/Dockerfile.chatgpt-image-agent`:

```dockerfile
# chatgpt-image-agent — Playwright Chromium + Python fastmcp server.
# Requires a CHATGPT_PROFILE_DIR volume mount with a pre-logged-in session.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# Chromium runtime libraries needed by Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 libnspr4 libx11-6 \
    libxext6 libxss1 libxcb1 libx11-xcb1 fonts-liberation wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt \
    && playwright install chromium

COPY . /app

ENV PYTHONPATH=/app \
    CHATGPT_IMAGE_AGENT_PORT=7110 \
    CHATGPT_HEADLESS=true

CMD ["python", "-u", "/app/chatgpt_image_agent/agent.py"]
```

- [ ] **Step 2: Commit**

```bash
git add pydantic-agents/docker/Dockerfile.chatgpt-image-agent
git commit -m "feat(chatgpt-image-agent): add Dockerfile"
```

---

## Task 4: Wire into run-all.sh

**Files:**
- Modify: `pydantic-agents/run-all.sh`

- [ ] **Step 1: Replace the contents of run-all.sh with this**

```bash
#!/usr/bin/env bash
# Starts every Pydantic AI agent in pydantic-agents/. Each agent runs in
# its own python process and exposes itself as an MCP server on its own
# port (see .env). Foreground; Ctrl+C kills both.

set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then set -a; source .env; set +a; fi

# shellcheck source=/dev/null
source "$(dirname "$0")/.venv/bin/activate"

python -m deep_research.agent &
DR_PID=$!
python -m web_research.agent &
WR_PID=$!
python -m notebooklm.agent &
NLM_PID=$!
python -m github_agent.agent &
GH_PID=$!
python -m reviewer_council.agent &
RC_PID=$!
python -m crawl4ai_agent.agent &
CA_PID=$!
python -m image_agent.agent &
IA_PID=$!
python -m chatgpt_image_agent.agent &
CGI_PID=$!

trap "kill $DR_PID $WR_PID $NLM_PID $GH_PID $RC_PID $CA_PID $IA_PID $CGI_PID 2>/dev/null || true" EXIT INT TERM

if ! wait -n; then
    rc=$?
    kill $DR_PID $WR_PID $NLM_PID $GH_PID $RC_PID $CA_PID $IA_PID $CGI_PID 2>/dev/null || true
    exit "$rc"
fi
wait
```

- [ ] **Step 2: Verify run-all.sh still parses**

```bash
bash -n pydantic-agents/run-all.sh
```

Expected: No output (bash syntax check passes).

- [ ] **Step 3: Commit**

```bash
git add pydantic-agents/run-all.sh
git commit -m "feat(chatgpt-image-agent): add to run-all.sh"
```

---

## Task 5: First-time setup & smoke test

This task is manual — it requires a running browser and a ChatGPT account.

- [ ] **Step 1: Start the agent server**

```bash
cd pydantic-agents
source .venv/bin/activate
python -m chatgpt_image_agent.agent
```

Leave this running in a terminal tab.

- [ ] **Step 2: Register the MCP server in NeuroClaw dashboard**

1. Open NeuroClaw dashboard → **MCP Servers** tab
2. Add server: `http://localhost:7110`
3. Verify all four tools appear: `chatgpt_setup`, `chatgpt_setup_complete`, `chatgpt_image_generate`, `chatgpt_image_edit`

- [ ] **Step 3: Run first-time login**

In the NeuroClaw CLI or dashboard chat (as Alfred or any agent), call:

```
@Alfred call chatgpt_setup
```

Expected: A visible Chromium window opens and navigates to chatgpt.com. Alfred responds with: `"Browser open — log in to ChatGPT, then call chatgpt_setup_complete."`

- [ ] **Step 4: Log in and save the session**

1. In the Chromium window, log in to ChatGPT manually
2. Once logged in and on the main chat page, call:

```
@Alfred call chatgpt_setup_complete
```

Expected: Browser closes. Alfred responds with: `"Session profile saved to .../profile. Ready to generate images."`

- [ ] **Step 5: Generate a test image**

```
@Alfred call chatgpt_image_generate with prompt "a red panda sitting on a cloud"
```

Expected: After 10–60s, Alfred returns something like:
```
path: /home/.../pydantic-agents/chatgpt_image_agent/outputs/<uuid>.png
description: a red panda sitting on a cloud
```

Verify the file exists and is a valid PNG:

```bash
file pydantic-agents/chatgpt_image_agent/outputs/*.png
```

Expected: `PNG image data, ...`

- [ ] **Step 6: Register NeuroClaw agents in dashboard**

1. Dashboard → **Agents** → Create agent:
   - Name: `ChatGPT Image`
   - Provider: `mcp`
   - MCP Server: `http://localhost:7110`
   - Tool: `chatgpt_image_generate`
2. Create second agent:
   - Name: `ChatGPT Edit`
   - Provider: `mcp`
   - MCP Server: `http://localhost:7110`
   - Tool: `chatgpt_image_edit`

- [ ] **Step 7: Add Da Vinci routing hint**

Open Da Vinci's system prompt in the dashboard and append:

```
For premium quality images or when the user explicitly requests ChatGPT images: use agent__chatgpt_image_generate.
```

---

## Task 6: Add env vars to .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add ChatGPT image agent env vars**

Open `.env.example` and add a section (find where other pydantic agent ports are documented):

```bash
# ChatGPT Image Agent (pydantic-agents/chatgpt_image_agent/)
CHATGPT_IMAGE_AGENT_PORT=7110
CHATGPT_HEADLESS=true
# CHATGPT_PROFILE_DIR=./pydantic-agents/chatgpt_image_agent/profile
# CHATGPT_IMAGE_OUTPUT_DIR=./pydantic-agents/chatgpt_image_agent/outputs
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "feat(chatgpt-image-agent): document env vars in .env.example"
```
