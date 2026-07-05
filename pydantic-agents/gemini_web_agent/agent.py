"""Gemini web agent — image generation (Nano Banana / Imagen), audio generation
(Lyra), web search, and image editing via gemini.google.com, exposed as FastMCP.

Tools:
  gemini_setup()                             — open visible browser for first-time Google login
  gemini_setup_complete()                    — close setup browser, save session profile
  gemini_import_cookies(cookies_path)        — import Cookie-Editor JSON export (VPS setup)
  gemini_generate_image(prompt)              — text → image file (Nano Banana / Imagen 3)
  gemini_generate_audio(prompt)              — text → audio file (Lyra)
  gemini_search(query)                       — Google-grounded web search → answer + cited sources
  gemini_edit_image(image_path, prompt)      — upload local image + edit prompt → edited image
  gemini_remember_image(image_path, label)   — store image path under a named label
  gemini_recall_image(label)                 — retrieve stored image path by label

Returns:
  generate_image:  "path: /abs/path/image.png\\ndescription: <prompt>"
  generate_audio:  "path: /abs/path/audio.mp3\\ndescription: <prompt>"
  search:          "answer: <text>\\nsources:\\n- [title](url)\\n..."
  edit_image:      "path: /abs/path/result.png\\ndescription: <prompt>"
  remember_image:  "Remembered '<label>' → <abs_path>"
  recall_image:    "/abs/path/image.png"
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

PORT      = int(os.getenv("GEMINI_WEB_AGENT_PORT", "7111"))
HEADLESS  = os.getenv("GEMINI_HEADLESS", "true").lower() != "false"

_AGENT_DIR       = os.path.dirname(os.path.abspath(__file__))
PROFILE_DIR      = os.getenv("GEMINI_PROFILE_DIR")      or "/root/.config/google-chrome"
IMAGE_OUTPUT_DIR = os.getenv("GEMINI_IMAGE_OUTPUT_DIR") or os.path.join(_AGENT_DIR, "outputs", "images")
AUDIO_OUTPUT_DIR = os.getenv("GEMINI_AUDIO_OUTPUT_DIR") or os.path.join(_AGENT_DIR, "outputs", "audio")

os.makedirs(PROFILE_DIR,      exist_ok=True)
os.makedirs(IMAGE_OUTPUT_DIR, exist_ok=True)
os.makedirs(AUDIO_OUTPUT_DIR, exist_ok=True)

_GEMINI_APP_URL = "https://gemini.google.com/app"

# Network domains for Gemini-generated images (Imagen / Nano Banana)
_GEMINI_IMAGE_DOMAINS = (
    "lh3.googleusercontent.com",
    "lh4.googleusercontent.com",
    "lh5.googleusercontent.com",
    "lh6.googleusercontent.com",
    "aisandbox-pa.googleapis.com",
    "generativeai-pa.googleapis.com",
    "imagen-pa.googleapis.com",
)

# Network domains for Gemini-generated audio (Lyra)
_GEMINI_AUDIO_DOMAINS = (
    "storage.googleapis.com",
    "aisandbox-pa.googleapis.com",
    "generativeai-pa.googleapis.com",
    "lyria-pa.googleapis.com",
)

# DOM selectors for images in the response (tried in order)
_IMG_SELECTORS = [
    'model-response img[src*="googleusercontent"]',
    'model-response img[src*="googleapis"]',
    'div[data-chunk-id] img[src*="http"]',
    '[class*="image-gen"] img',
    'response-container img[src*="http"]',
]

# DOM selectors for audio in the response (tried in order)
_AUDIO_SELECTORS = [
    'model-response audio[src]',
    'response-container audio[src]',
    'audio[src*="googleapis"]',
    'audio[src*="googleusercontent"]',
    'audio[src*="http"]',
]

# Input area selectors (tried in order)
_INPUT_SELECTORS = [
    'div[contenteditable="true"][aria-label]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"].ql-editor',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea',
]

# Send button selectors (tried in order)
_SEND_SELECTORS = [
    'button[aria-label="Send message"]',
    'button[data-test-id="send-button"]',
    'button[aria-label*="Send"]',
    'button[jsname*="send"]',
    'button.send-button',
]

# Two-step setup flow state
_setup_playwright: Optional[Playwright] = None
_setup_context:    Optional[BrowserContext] = None

# Persistent generation context — reused across calls so each request continues
# in the same browser session instead of re-authenticating.
_gen_playwright: Optional[Playwright] = None
_gen_context:    Optional[BrowserContext] = None
_gen_lock = asyncio.Lock()

# Image memory store — label → absolute path (in-process only)
_image_memory: dict[str, str] = {}
_memory_lock = asyncio.Lock()

# MIME magic-byte check (PNG and JPEG only; WEBP excluded — Gemini upload may reject it)
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


mcp = FastMCP("gemini-web-agent")


def _profile_exists() -> bool:
    p = Path(PROFILE_DIR)
    return p.exists() and any(p.iterdir())


async def _launch_context(headless: bool = True) -> tuple[Playwright, BrowserContext]:
    pw = await async_playwright().start()
    context = await pw.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=headless,
        args=["--no-sandbox", "--disable-setuid-sandbox"],
    )
    return pw, context


async def _get_gen_context() -> tuple[Playwright, BrowserContext]:
    """Return the persistent generation context, creating it if needed.
    Caller must already hold _gen_lock."""
    global _gen_playwright, _gen_context
    if _gen_context is not None:
        try:
            _ = _gen_context.pages
            return _gen_playwright, _gen_context  # type: ignore[return-value]
        except Exception:
            _gen_playwright = _gen_context = None
    _gen_playwright, _gen_context = await _launch_context(headless=HEADLESS)
    return _gen_playwright, _gen_context  # type: ignore[return-value]


async def _reset_gen_context() -> None:
    """Tear down the persistent generation context so the next call gets a fresh browser.
    Call this whenever a generation fails or times out — prevents a stuck/stale Chromium
    renderer from being reused on every subsequent request."""
    global _gen_playwright, _gen_context
    ctx, pw = _gen_context, _gen_playwright
    _gen_playwright = _gen_context = None
    try:
        if ctx is not None:
            await ctx.close()
    except Exception:
        pass
    try:
        if pw is not None:
            await pw.stop()
    except Exception:
        pass


async def _get_or_open_page(context: BrowserContext) -> Page:
    if context.pages:
        return context.pages[0]
    return await context.new_page()


async def _find_input(page: Page):
    """Return the first matching input element, trying multiple selectors."""
    for sel in _INPUT_SELECTORS:
        try:
            el = await page.wait_for_selector(sel, timeout=3_000)
            if el:
                return el
        except Exception:
            pass
    raise RuntimeError("Could not find Gemini chat input")


async def _ensure_gemini_ready(page: Page) -> None:
    """Ensure the page is on Gemini with an active input.
    Raises RuntimeError('session_expired') if the Google login wall is detected."""
    current = page.url
    on_gemini = (
        "gemini.google.com" in current
        and "accounts.google.com" not in current
        and "signin" not in current
    )
    if on_gemini:
        try:
            await _find_input(page)
            return
        except Exception:
            pass
    await page.goto(_GEMINI_APP_URL, wait_until="domcontentloaded")
    if "accounts.google.com" in page.url or "signin" in page.url:
        raise RuntimeError("session_expired")
    await _find_input(page)


async def _submit_prompt(page: Page, text: str) -> None:
    """Type a prompt into the Gemini input and send it."""
    inp = await _find_input(page)
    await inp.click()
    # Clear any existing text
    await page.keyboard.press("Control+a")
    await page.keyboard.press("Delete")
    await page.keyboard.type(text, delay=20)
    # Try send button first; fall back to Enter
    sent = False
    for sel in _SEND_SELECTORS:
        try:
            btn = await page.wait_for_selector(sel, timeout=2_000)
            if btn:
                await btn.click()
                sent = True
                break
        except Exception:
            pass
    if not sent:
        await page.keyboard.press("Enter")


async def _wait_for_stop_button_gone(page: Page, timeout: float = 5.0) -> None:
    """Wait briefly for the stop-generation button to appear, then for it to vanish."""
    stop_sels = [
        'button[aria-label="Stop response"]',
        'button[aria-label*="Stop"]',
        'button[data-test-id="stop-button"]',
    ]
    # Short wait for stop button to appear (generation starts)
    for sel in stop_sels:
        try:
            await page.wait_for_selector(sel, timeout=int(timeout * 1000))
            # Now wait for it to disappear
            await page.wait_for_selector(sel, state="hidden", timeout=300_000)
            return
        except Exception:
            pass


async def _wait_for_text_response(page: Page) -> str:
    """Wait for Gemini to produce a complete text response and extract it.

    Returns formatted 'answer: <text>\\nsources:\\n- [title](url)' string.
    Returns 'REFUSAL:<text>' if refusal phrases are detected.
    Raises asyncio.TimeoutError after 60s.

    Note: Citation extraction is best-effort. Gemini renders citations as [1][2]
    footnotes with a collapsible Sources section; links in a collapsed section
    may not be present in the DOM at extraction time.
    """
    # Wait for model-response element to appear (up to 30s)
    try:
        await page.wait_for_selector("model-response", timeout=30_000)
    except Exception:
        pass

    # Use existing stop-button monitor to detect generation completion.
    # Without this, the stability check fires immediately on the empty
    # initial response before Gemini starts generating.
    await _wait_for_stop_button_gone(page, timeout=5.0)

    # Stability check: two consecutive identical non-empty polls = done
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 60
    prev_text = ""
    current_text = ""
    while loop.time() < deadline:
        try:
            els = await page.query_selector_all(
                "model-response p, response-container p"
            )
            parts = []
            for el in els:
                t = await el.inner_text()
                if t:
                    parts.append(t)
            current_text = "\n".join(parts).strip()
        except Exception:
            current_text = ""

        if current_text and current_text == prev_text:
            break
        prev_text = current_text
        await asyncio.sleep(1)
    else:
        raise asyncio.TimeoutError()

    if not current_text:
        raise asyncio.TimeoutError()

    # Refusal detection — matches phrases used in _wait_for_and_save_image/_audio
    for phrase in ("i can't", "i'm unable", "i cannot", "i'm not able"):
        if phrase in current_text.lower():
            return f"REFUSAL:{current_text}"

    # Extract citation links from model-response (best-effort; see docstring)
    sources: list[str] = []
    try:
        link_els = await page.query_selector_all(
            'model-response a[href^="http"], response-container a[href^="http"]'
        )
        seen: set[str] = set()
        for link_el in link_els:
            href = await link_el.get_attribute("href") or ""
            if not href or href in seen:
                continue
            seen.add(href)
            title = (await link_el.inner_text()).strip() or href
            sources.append(f"- [{title}]({href})")
    except Exception:
        pass

    result = f"answer: {current_text}"
    if sources:
        result += "\nsources:\n" + "\n".join(sources)
    return result


async def _upload_file_to_gemini(page: Page, file_path: str) -> None:
    """Attach a local image file to the Gemini chat input.

    Strategy 1: Click upload/attach button → intercept file chooser dialog →
    set_files(). Waits up to 10s for a thumbnail/preview to confirm upload.

    Strategy 2 (fallback): Locate hidden input[type=file] and set_input_files()
    directly without clicking any button.

    Raises RuntimeError('upload_failed') if no strategy succeeds.
    """
    _UPLOAD_BTN_SELS = [
        'button[aria-label*="Upload"]',
        'button[aria-label*="Add image"]',
        'button[aria-label*="attach"]',
        'button[aria-label*="Attach"]',
        '[aria-label*="upload"]',
        '[data-test-id*="upload"]',
    ]
    _THUMBNAIL_SELS = [
        '[class*="upload-preview"]',
        '[class*="attachment"]',
        'img[alt*="upload"]',
        '[aria-label*="Uploaded"]',
        'img[src^="blob:"]',
    ]

    async def _wait_for_thumbnail() -> bool:
        for thumb_sel in _THUMBNAIL_SELS:
            try:
                await page.wait_for_selector(thumb_sel, timeout=10_000)
                return True
            except Exception:
                pass
        return False

    # Strategy 1: click button → file chooser
    for sel in _UPLOAD_BTN_SELS:
        try:
            btn = await page.wait_for_selector(sel, timeout=2_000)
            if not btn:
                continue
            try:
                async with page.expect_file_chooser(timeout=3_000) as fc_info:
                    await btn.click()
                file_chooser = await fc_info.value
                await file_chooser.set_files(file_path)
                await _wait_for_thumbnail()
                return
            except Exception:
                pass
        except Exception:
            pass

    # Strategy 2: hidden input[type=file] directly
    try:
        file_input = await page.query_selector('input[type="file"]')
        if file_input:
            await file_input.set_input_files(file_path)
            await _wait_for_thumbnail()
            return
    except Exception:
        pass

    raise RuntimeError("upload_failed")


# ── Image generation (Nano Banana / Imagen 3) ──────────────────────────────

async def _wait_for_and_save_image(page: Page) -> str:
    """Wait for Gemini to produce an image and save it.

    Uses two parallel strategies:
    - Network interceptor: catches the CDN response (fast path).
    - DOM poller: scrolls and scans for blob/http img srcs (fallback).

    Uses asyncio.Event for cross-task signaling (more reliable than
    asyncio.Future.set_result when called from Playwright callbacks).

    Returns absolute path to saved file, or 'REFUSAL:<text>'.
    """
    img_event    = asyncio.Event()
    refusal_event = asyncio.Event()
    img_data:     list[bytes] = []
    refusal_text: list[str]   = []

    async def on_response(response) -> None:
        if img_event.is_set():
            return
        if not any(d in response.url for d in _GEMINI_IMAGE_DOMAINS):
            return
        ct = response.headers.get("content-type", "")
        if not ct.startswith("image/"):
            return
        # Prefer response.body() — CDN URLs are single-use tokens so
        # re-fetching via page.evaluate() usually returns 403.
        try:
            body = await response.body()
            if body and not img_event.is_set():
                img_data.append(body)
                img_event.set()
                return
        except Exception:
            pass
        # Fallback: re-fetch via browser JS
        url = response.url
        try:
            byte_list: list = await page.evaluate("""async (url) => {
                const resp = await fetch(url, {credentials: 'include'});
                if (!resp.ok) return null;
                const buf = await resp.arrayBuffer();
                return Array.from(new Uint8Array(buf));
            }""", url)
            if byte_list and not img_event.is_set():
                img_data.append(bytes(byte_list))
                img_event.set()
        except Exception:
            pass

    page.on("response", on_response)

    async def _poll() -> None:
        while True:
            try:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                pass

            # Check for refusal text
            try:
                els = await page.query_selector_all('model-response p, response-container p')
                for el in els:
                    text = await el.inner_text()
                    if text and any(w in text.lower() for w in
                                    ("i can't", "i'm unable", "i cannot", "i'm not able",
                                     "can't generate", "cannot generate")):
                        if not refusal_event.is_set():
                            refusal_text.append(text)
                            refusal_event.set()
                        return
            except Exception:
                pass

            if not img_event.is_set():
                # Broader selector: pick up any img in model responses,
                # including those with blob: URLs (Gemini's current behaviour).
                broad_sels = _IMG_SELECTORS + [
                    'model-response img',
                    'response-container img',
                ]
                for sel in broad_sels:
                    try:
                        el = await page.query_selector(sel)
                        if not el:
                            continue
                        src = await el.get_attribute("src")
                        if not src:
                            continue
                        # blob: URLs are same-origin and directly fetchable
                        # from within the page context.
                        if src.startswith("blob:") or src.startswith("http"):
                            byte_list: list = await page.evaluate("""async (url) => {
                                try {
                                    const resp = await fetch(url, {credentials: 'include'});
                                    if (!resp.ok) return null;
                                    const ct = resp.headers.get('content-type') || '';
                                    // Accept blob: URLs (no ct) or image/* content
                                    if (ct && !ct.startsWith('image/')) return null;
                                    const buf = await resp.arrayBuffer();
                                    return Array.from(new Uint8Array(buf));
                                } catch (e) { return null; }
                            }""", src)
                            if byte_list and not img_event.is_set():
                                img_data.append(bytes(byte_list))
                                img_event.set()
                                return
                    except Exception:
                        pass

            await asyncio.sleep(2)

    poll_task = asyncio.create_task(_poll())
    try:
        # Wait for either image or refusal, with overall timeout
        wait_img     = asyncio.ensure_future(img_event.wait())
        wait_refusal = asyncio.ensure_future(refusal_event.wait())
        done, pending = await asyncio.wait(
            {wait_img, wait_refusal},
            timeout=270,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
    finally:
        poll_task.cancel()
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass

    if not done:
        raise asyncio.TimeoutError()

    if refusal_event.is_set():
        return f"REFUSAL:{refusal_text[0] if refusal_text else 'content refused'}"

    body = img_data[0]
    # Detect format from magic bytes (PNG, JPEG, WEBP)
    ext = "png"
    if body[:3] == b"\xff\xd8\xff":
        ext = "jpg"
    elif body[:4] == b"RIFF":
        ext = "webp"
    path = os.path.join(IMAGE_OUTPUT_DIR, f"{uuid.uuid4().hex}.{ext}")
    Path(path).write_bytes(body)
    return os.path.abspath(path)


# ── Audio generation (Lyra) ────────────────────────────────────────────────

async def _wait_for_and_save_audio(page: Page) -> str:
    """Wait for Gemini to produce audio and save it.

    Returns absolute path to saved file, or 'REFUSAL:<text>'.
    """
    audio_event   = asyncio.Event()
    refusal_event = asyncio.Event()
    audio_data:   list[bytes] = []
    refusal_text: list[str]   = []

    async def on_response(response) -> None:
        if audio_event.is_set():
            return
        ct = response.headers.get("content-type", "")
        url_match = any(d in response.url for d in _GEMINI_AUDIO_DOMAINS)
        audio_ct = ct.startswith("audio/") or "octet-stream" in ct
        if not (url_match and audio_ct):
            return
        # Prefer response.body() first
        try:
            body = await response.body()
            if body and not audio_event.is_set():
                audio_data.append(body)
                audio_event.set()
                return
        except Exception:
            pass
        # Fallback: re-fetch via browser JS
        try:
            byte_list: list = await page.evaluate("""async (url) => {
                const resp = await fetch(url, {credentials: 'include'});
                if (!resp.ok) return null;
                const buf = await resp.arrayBuffer();
                return Array.from(new Uint8Array(buf));
            }""", response.url)
            if byte_list and not audio_event.is_set():
                audio_data.append(bytes(byte_list))
                audio_event.set()
        except Exception:
            pass

    page.on("response", on_response)

    async def _poll() -> None:
        while True:
            try:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                pass

            # Check for refusal
            try:
                els = await page.query_selector_all('model-response p, response-container p')
                for el in els:
                    text = await el.inner_text()
                    if text and any(w in text.lower() for w in
                                    ("i can't", "i'm unable", "i cannot", "cannot generate")):
                        if not refusal_event.is_set():
                            refusal_text.append(text)
                            refusal_event.set()
                        return
            except Exception:
                pass

            if not audio_event.is_set():
                for sel in _AUDIO_SELECTORS:
                    try:
                        el = await page.query_selector(sel)
                        if not el:
                            continue
                        src = await el.get_attribute("src")
                        if not src or not src.startswith("http"):
                            continue
                        byte_list: list = await page.evaluate("""async (url) => {
                            const resp = await fetch(url, {credentials: 'include'});
                            if (!resp.ok) return null;
                            const buf = await resp.arrayBuffer();
                            return Array.from(new Uint8Array(buf));
                        }""", src)
                        if byte_list and not audio_event.is_set():
                            audio_data.append(bytes(byte_list))
                            audio_event.set()
                            return
                    except Exception:
                        pass

            await asyncio.sleep(2)

    poll_task = asyncio.create_task(_poll())
    try:
        wait_audio   = asyncio.ensure_future(audio_event.wait())
        wait_refusal = asyncio.ensure_future(refusal_event.wait())
        done, pending = await asyncio.wait(
            {wait_audio, wait_refusal},
            timeout=300,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
    finally:
        poll_task.cancel()
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass

    if not done:
        raise asyncio.TimeoutError()

    if refusal_event.is_set():
        return f"REFUSAL:{refusal_text[0] if refusal_text else 'content refused'}"

    body = audio_data[0]
    # Detect format from magic bytes (MP3, WAV, OGG)
    ext = "mp3"
    if body[:4] == b"RIFF":
        ext = "wav"
    elif body[:4] == b"OggS":
        ext = "ogg"
    path = os.path.join(AUDIO_OUTPUT_DIR, f"{uuid.uuid4().hex}.{ext}")
    Path(path).write_bytes(body)
    return os.path.abspath(path)


# ── MCP Tools ──────────────────────────────────────────────────────────────

@mcp.tool()
async def gemini_setup() -> str:
    """Open a visible browser and navigate to Gemini. Log in with Google, then call gemini_setup_complete."""
    global _setup_playwright, _setup_context
    if _setup_context:
        return "Setup browser already open. Log in and call gemini_setup_complete."
    try:
        _setup_playwright, _setup_context = await _launch_context(headless=False)
        page = await _get_or_open_page(_setup_context)
        await page.goto(_GEMINI_APP_URL, wait_until="domcontentloaded")
        return "Browser open — log in to Gemini with your Google account, then call gemini_setup_complete."
    except Exception as exc:
        _setup_playwright = _setup_context = None
        return f"Error: {exc}"


@mcp.tool()
async def gemini_setup_complete() -> str:
    """Close the setup browser and save the Google session profile to disk."""
    global _setup_playwright, _setup_context
    if not _setup_context:
        return "Error: no setup browser open. Call gemini_setup first."
    try:
        await _setup_context.close()
        await _setup_playwright.stop()
        _setup_context = _setup_playwright = None
        return f"Session profile saved to {PROFILE_DIR}. Ready to generate images and audio."
    except Exception as exc:
        _setup_context = _setup_playwright = None
        return f"Error saving profile: {exc}"


@mcp.tool()
async def gemini_import_cookies(
    cookies_path: str = "/home/neuroclaw-v1/references/gemini-cookies/cookies.json",
) -> str:
    """Import Gemini cookies from a Cookie-Editor JSON export into the session profile.
    Use this on a VPS instead of gemini_setup — export cookies from your local browser
    (while logged into gemini.google.com), copy the JSON to the server, then call this tool."""
    if not os.path.exists(cookies_path):
        return f"Error: cookies file not found at {cookies_path}"

    import json as _json

    _same_site_map = {
        "no_restriction": "None",
        "lax":            "Lax",
        "strict":         "Strict",
        "unspecified":    "Lax",
    }

    try:
        raw = _json.loads(Path(cookies_path).read_text())
    except Exception as exc:
        return f"Error reading cookies file: {exc}"

    pw = None
    ctx = None
    try:
        pw, ctx = await _launch_context(headless=True)
        cookies = []
        for c in raw:
            entry: dict = {
                "name":     c["name"],
                "value":    c["value"],
                "domain":   c["domain"],
                "path":     c.get("path", "/"),
                "httpOnly": bool(c.get("httpOnly", False)),
                "secure":   bool(c.get("secure", False)),
                "sameSite": _same_site_map.get(str(c.get("sameSite", "")).lower(), "Lax"),
            }
            exp = c.get("expirationDate")
            if exp and not c.get("session", False):
                entry["expires"] = float(exp)
            cookies.append(entry)
        await ctx.add_cookies(cookies)
        await ctx.close()
        await pw.stop()
        ctx = pw = None
        return f"Imported {len(cookies)} cookies into {PROFILE_DIR}. Ready to generate images and audio."
    except Exception as exc:
        return f"Error importing cookies: {exc}"
    finally:
        if ctx:
            await ctx.close()
        if pw:
            await pw.stop()


@mcp.tool()
async def gemini_load_storage_state(
    storage_state_path: str = "/root/.gemini/storage_state.json",
) -> str:
    """Import gemini.google.com session cookies from a Playwright storage_state.json file.

    Use this when cookies were synced via the AI Cookie Sync browser extension,
    which writes Playwright-format state to /root/.gemini/storage_state.json.
    No manual cookie export needed — the extension keeps that file fresh.
    """
    import json as _json

    if not os.path.exists(storage_state_path):
        return f"Error: file not found: {storage_state_path}"
    try:
        data = _json.loads(Path(storage_state_path).read_text())
    except Exception as exc:
        return f"Error reading file: {exc}"

    if not isinstance(data, dict) or "cookies" not in data:
        return f"Error: not a Playwright storage_state file (keys: {list(data.keys()) if isinstance(data, dict) else type(data).__name__})"

    cookies = data["cookies"]
    if not cookies:
        return "Error: storage_state file contains no cookies"

    pw = None
    ctx = None
    try:
        pw, ctx = await _launch_context(headless=True)
        await ctx.add_cookies(cookies)
        await ctx.close()
        await pw.stop()
        ctx = pw = None
        return f"Imported {len(cookies)} cookies from {storage_state_path} into {PROFILE_DIR}. Ready to generate images and audio."
    except Exception as exc:
        return f"Error importing cookies: {exc}"
    finally:
        if ctx:
            await ctx.close()
        if pw:
            await pw.stop()


@mcp.tool()
async def gemini_generate_image(prompt: str) -> str:
    """Generate an image via Gemini's web UI (Nano Banana / Imagen 3).
    Requires a saved session (run gemini_setup or gemini_import_cookies first).
    Returns: 'path: /abs/path/image.png\\ndescription: <prompt>'"""
    if not _profile_exists():
        return "Error: run gemini_setup or gemini_import_cookies first"

    async with _gen_lock:
        try:
            _, ctx = await _get_gen_context()
            page = await _get_or_open_page(ctx)
            try:
                await _ensure_gemini_ready(page)
            except RuntimeError as e:
                if "session_expired" in str(e):
                    return "Error: session expired — run gemini_setup or gemini_import_cookies"
                raise

            await _submit_prompt(page, f"Generate an image: {prompt}")

            try:
                result = await _wait_for_and_save_image(page)
            except asyncio.TimeoutError:
                await _reset_gen_context()
                return "Error: image generation timed out after 270s"

            if result.startswith("REFUSAL:"):
                return result[8:]
            return f"path: {result}\ndescription: {prompt}"
        except FileNotFoundError:
            return "Error: run playwright install chromium"
        except Exception as exc:
            await _reset_gen_context()
            return f"Error: {exc}"


@mcp.tool()
async def gemini_generate_audio(prompt: str) -> str:
    """Generate audio via Gemini's web UI (Lyra).
    Requires a saved session (run gemini_setup or gemini_import_cookies first).
    Returns: 'path: /abs/path/audio.mp3\\ndescription: <prompt>'"""
    if not _profile_exists():
        return "Error: run gemini_setup or gemini_import_cookies first"

    async with _gen_lock:
        try:
            _, ctx = await _get_gen_context()
            page = await _get_or_open_page(ctx)
            try:
                await _ensure_gemini_ready(page)
            except RuntimeError as e:
                if "session_expired" in str(e):
                    return "Error: session expired — run gemini_setup or gemini_import_cookies"
                raise

            await _submit_prompt(page, f"Generate audio: {prompt}")

            try:
                result = await _wait_for_and_save_audio(page)
            except asyncio.TimeoutError:
                await _reset_gen_context()
                return "Error: audio generation timed out after 300s"

            if result.startswith("REFUSAL:"):
                return result[8:]
            return f"path: {result}\ndescription: {prompt}"
        except FileNotFoundError:
            return "Error: run playwright install chromium"
        except Exception as exc:
            await _reset_gen_context()
            return f"Error: {exc}"


@mcp.tool()
async def gemini_remember_image(image_path: str, label: str) -> str:
    """Store a local image path under a named label for later retrieval.
    Returns: "Remembered '<label>' → <abs_path>" or "Error: ..." """
    if not label.strip():
        return "Error: label cannot be empty"
    abs_path = os.path.abspath(image_path)
    if not os.path.exists(abs_path):
        return f"Error: file not found: {abs_path}"
    async with _memory_lock:
        _image_memory[label] = abs_path
    return f"Remembered '{label}' → {abs_path}"


@mcp.tool()
async def gemini_recall_image(label: str) -> str:
    """Retrieve a stored image path by label.
    Returns: "/abs/path/image.png" or "Error: no image remembered as '<label>'" """
    if not label.strip():
        return "Error: label cannot be empty"
    async with _memory_lock:
        path = _image_memory.get(label)
    if path is None:
        return f"Error: no image remembered as '{label}'"
    return path


@mcp.tool()
async def gemini_search(query: str) -> str:
    """Search the web via Gemini's Google-grounded AI.
    Requires a saved session (run gemini_setup or gemini_import_cookies first).
    Returns: 'answer: <text>\\nsources:\\n- [title](url)\\n...'
    On refusal: 'REFUSAL:<text>'  On timeout: 'Error: search timed out after 60s'"""
    if not _profile_exists():
        return "Error: run gemini_setup or gemini_import_cookies first"

    async with _gen_lock:
        try:
            _, ctx = await _get_gen_context()
            page = await _get_or_open_page(ctx)
            # Navigate to a fresh conversation to avoid context bleed from
            # prior searches or generation calls in the same session.
            await page.goto(_GEMINI_APP_URL, wait_until="domcontentloaded")
            try:
                await _ensure_gemini_ready(page)
            except RuntimeError as e:
                if "session_expired" in str(e):
                    return "Error: session expired — run gemini_setup or gemini_import_cookies"
                raise

            await _submit_prompt(page, query)

            try:
                result = await _wait_for_text_response(page)
            except asyncio.TimeoutError:
                await _reset_gen_context()
                return "Error: search timed out after 60s"

            return result
        except FileNotFoundError:
            return "Error: run playwright install chromium"
        except Exception as exc:
            await _reset_gen_context()
            return f"Error: {exc}"


@mcp.tool()
async def gemini_edit_image(image_path: str, prompt: str) -> str:
    """Upload a local image to Gemini and apply an edit prompt.
    Requires a saved session (run gemini_setup or gemini_import_cookies first).
    image_path: absolute path to a PNG or JPEG file.
    Returns: 'path: /abs/path/result.png\\ndescription: <prompt>'"""
    if not _profile_exists():
        return "Error: run gemini_setup or gemini_import_cookies first"

    abs_path = os.path.abspath(image_path)
    if not os.path.exists(abs_path):
        return f"Error: image file not found: {abs_path}"
    if _get_mime(abs_path) is None:
        return "Error: unsupported image format (PNG and JPEG only)"

    async with _gen_lock:
        try:
            _, ctx = await _get_gen_context()
            page = await _get_or_open_page(ctx)
            # Navigate to a fresh conversation — required so stale context from
            # prior searches or generations doesn't cause Gemini to misinterpret
            # the edit prompt.
            await page.goto(_GEMINI_APP_URL, wait_until="domcontentloaded")
            try:
                await _ensure_gemini_ready(page)
            except RuntimeError as e:
                if "session_expired" in str(e):
                    return "Error: session expired — run gemini_setup or gemini_import_cookies"
                raise

            try:
                await _upload_file_to_gemini(page, abs_path)
            except RuntimeError as e:
                if "upload_failed" in str(e):
                    return "Error: could not attach image — check Gemini UI for upload button changes"
                raise

            # Type prompt WITHOUT calling _submit_prompt() — _submit_prompt does
            # Ctrl+A + Delete which deletes the attachment chip from the
            # contenteditable div before the message is sent.
            inp = await _find_input(page)
            await inp.click()
            await page.keyboard.type(prompt, delay=20)
            sent = False
            for sel in _SEND_SELECTORS:
                try:
                    btn = await page.wait_for_selector(sel, timeout=2_000)
                    if btn:
                        await btn.click()
                        sent = True
                        break
                except Exception:
                    pass
            if not sent:
                await page.keyboard.press("Enter")

            try:
                result = await _wait_for_and_save_image(page)
            except asyncio.TimeoutError:
                await _reset_gen_context()
                return "Error: image generation timed out after 270s"

            if result.startswith("REFUSAL:"):
                return result[8:]
            return f"path: {result}\ndescription: {prompt}"
        except FileNotFoundError:
            return "Error: run playwright install chromium"
        except Exception as exc:
            await _reset_gen_context()
            return f"Error: {exc}"


if __name__ == "__main__":
    mcp.run(transport="http", host=os.getenv("HOST", "127.0.0.1"), port=PORT)
