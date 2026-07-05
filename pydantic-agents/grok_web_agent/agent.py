"""Grok web agent — generates images via grok.com (Aurora model), exposed as FastMCP.

Drives grok.com with Playwright so image generation uses the web-tier quota (no
xAI API rate limits) instead of the token-based native API.

Tools:
  grok_web_setup()                         — open visible browser for first-time X login
  grok_web_setup_complete()                — close setup browser, save session profile
  grok_web_generate_image(prompt)          — text → image file via grok.com Aurora
  grok_web_import_cookies(cookies_path)    — import Cookie-Editor JSON export (VPS setup)

Return format (generate_image):
  "path: /abs/path/image.png\\ndescription: <prompt>"
  "Error: <reason>"
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import uuid
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastmcp import FastMCP
from playwright.async_api import async_playwright, BrowserContext, Page, Playwright

load_dotenv()

PORT      = int(os.getenv("GROK_WEB_AGENT_PORT", "7113"))
HEADLESS  = os.getenv("GROK_WEB_HEADLESS", "true").lower() != "false"

_AGENT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROFILE_DIR = os.getenv("GROK_WEB_PROFILE_DIR") or "/root/.config/grok-web"
OUTPUT_DIR  = os.getenv("GROK_WEB_OUTPUT_DIR")  or os.path.join(_AGENT_DIR, "outputs")

os.makedirs(PROFILE_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR,  exist_ok=True)

_GROK_URL = "https://grok.com/imagine"

# ── DOM selectors (tried in order, most-specific first) ───────────────────────

# Input textarea / contenteditable area (Imagine page uses ProseMirror editor)
_INPUT_SELECTORS = [
    'div.tiptap',
    'div.ProseMirror',
    'div[contenteditable="true"][class*="tiptap"]',
    'div[contenteditable="true"][class*="ProseMirror"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Grok"]',
    'textarea[data-testid*="input"]',
    'div[contenteditable="true"][aria-label*="message"]',
    'div[contenteditable="true"][aria-label*="Message"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea',
]

# Send / submit button
_SEND_SELECTORS = [
    'button[aria-label="Submit"]',
    'button[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
    '[class*="send"] button',
]

# Stop-generation indicator — its disappearance signals generation is done
_STOP_SELECTORS = [
    'button[aria-label*="Stop"]',
    'button[data-testid*="stop"]',
    '[class*="stop-generation"] button',
    '[aria-label="Stop generating"]',
]

# Selectors for newly rendered images inside the assistant response.
# Order matters: the redesigned grok.com/imagine page is a gallery of template /
# showcase images (served from imagine-public.x.ai, twimg, grok.com/_next/image).
# The user's ACTUAL generation is now inlined as a base64 data: URI — match that
# FIRST and keep only tight, generation-specific fallbacks so we never capture a
# gallery thumbnail by mistake.
_IMG_SELECTORS = [
    # Grok Imagine inlines generated images as base64 data URIs (no network
    # request, no http/blob src) — primary path, decoded directly below.
    'img[src^="data:image"]',
    # Grok-specific user-asset CDN (if a generation is ever served as a URL).
    'img[src*="assets.grok.com"]',
    'img[src*="cdn.grok.com"]',
    # blob: URLs are always same-origin and fetchable from page context.
    'img[src^="blob:"]',
]

# Network domains that serve the USER'S generated images. Deliberately narrow:
# the redesigned imagine page loads a large public showcase gallery from
# imagine-public.x.ai / twimg, so we must NOT match x.ai/twimg here or we'd
# capture someone else's gallery image. Generations are usually inline data:
# URIs now (caught by the DOM poller); this network path is a fallback only.
_GROK_IMAGE_DOMAINS = (
    "assets.grok.com",
    "cdn.grok.com",
)

# Minimum byte size to consider a network response as a real generated image
# (not a UI icon, loading spinner, etc.)
_MIN_IMAGE_BYTES = 8_192   # 8 KB

# ── Session state ──────────────────────────────────────────────────────────────

_setup_playwright: Optional[Playwright]    = None
_setup_context:    Optional[BrowserContext] = None

_gen_playwright: Optional[Playwright]    = None
_gen_context:    Optional[BrowserContext] = None
_gen_lock = asyncio.Lock()

mcp = FastMCP("grok-web-agent")


# ── Browser lifecycle helpers ──────────────────────────────────────────────────

def _profile_exists() -> bool:
    p = Path(PROFILE_DIR)
    return p.exists() and any(p.iterdir())


async def _launch_context(headless: bool = True) -> tuple[Playwright, BrowserContext]:
    pw = await async_playwright().start()
    ctx = await pw.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=headless,
        args=["--no-sandbox", "--disable-setuid-sandbox"],
    )
    return pw, ctx


async def _get_gen_context() -> tuple[Playwright, BrowserContext]:
    """Return the persistent generation context, creating it if needed.
    Caller must already hold _gen_lock."""
    global _gen_playwright, _gen_context
    if _gen_context is not None:
        try:
            _ = _gen_context.pages   # raises if context was closed
            return _gen_playwright, _gen_context  # type: ignore[return-value]
        except Exception:
            _gen_playwright = _gen_context = None
    _gen_playwright, _gen_context = await _launch_context(headless=HEADLESS)
    return _gen_playwright, _gen_context  # type: ignore[return-value]


async def _reset_gen_context() -> None:
    """Tear down the persistent generation context so the next call gets a fresh browser."""
    global _gen_playwright, _gen_context
    ctx, pw = _gen_context, _gen_playwright
    _gen_playwright = _gen_context = None
    for obj, method in [(ctx, "close"), (pw, "stop")]:
        if obj is not None:
            try:
                await getattr(obj, method)()
            except Exception:
                pass


async def _get_or_open_page(ctx: BrowserContext) -> Page:
    if ctx.pages:
        return ctx.pages[0]
    return await ctx.new_page()


# ── Grok readiness ─────────────────────────────────────────────────────────────

async def _find_input(page: Page):
    """Return the first matching chat input element."""
    for sel in _INPUT_SELECTORS:
        try:
            el = await page.wait_for_selector(sel, timeout=3_000)
            if el:
                return el
        except Exception:
            pass
    raise RuntimeError("Could not find Grok chat input")


async def _ensure_grok_ready(page: Page) -> None:
    """Navigate to grok.com if needed and confirm the chat input is present.
    Raises RuntimeError('session_expired') if an X login wall is detected."""
    current = page.url
    on_grok = (
        "grok.com" in current
        and "x.com/i/oauth2" not in current
        and "twitter.com/login" not in current
        and "x.com/login" not in current
        and "accounts.x.com" not in current
    )
    if on_grok:
        try:
            await _find_input(page)
            return
        except Exception:
            pass
    await page.goto(_GROK_URL, wait_until="domcontentloaded")
    # Detect auth redirect
    if any(x in page.url for x in (
        "x.com/i/oauth2", "twitter.com/login", "x.com/login", "accounts.x.com"
    )):
        raise RuntimeError("session_expired")
    await _find_input(page)


# ── Overlay / dialog dismissal ─────────────────────────────────────────────────

# "What's new" onboarding modal buttons (intermittent on grok.com/imagine) —
# tried before the generic close handles so we positively dismiss it.
_ONBOARD_DISMISS_SELECTORS = [
    'button:has-text("Get Started")',
    'button:has-text("Got it")',
    'button:has-text("Continue")',
    'button:has-text("Skip")',
]

_DIALOG_CLOSE_SELECTORS = [
    'button[aria-label*="Close"]',
    'button[aria-label*="close"]',
    'button[aria-label*="Dismiss"]',
    '[data-testid*="close"]',
    '#dialog-portal button',
    '[role="dialog"] button',
]


async def _dismiss_overlays(page: Page) -> None:
    """Clear intermittent overlays (onboarding "What's new" modal, dialogs) that
    intercept pointer events on grok.com/imagine and otherwise block submit."""
    # Two passes: a modal sometimes re-renders right after the first dismissal.
    for _ in range(2):
        cleared = False
        try:
            await page.keyboard.press("Escape")
            await asyncio.sleep(0.3)
        except Exception:
            pass
        for sel in _ONBOARD_DISMISS_SELECTORS + _DIALOG_CLOSE_SELECTORS:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    await el.click(force=True)
                    await asyncio.sleep(0.3)
                    cleared = True
                    break
            except Exception:
                pass
        if not cleared:
            break


# ── Prompt submission ──────────────────────────────────────────────────────────

async def _submit_prompt(page: Page, text: str) -> None:
    """Type a prompt into the Grok Imagine input and send it."""
    await _dismiss_overlays(page)
    # Ensure Image mode is selected (not Agent/Video)
    try:
        img_tab = await page.wait_for_selector('button:text-is("Image")', timeout=3_000)
        if img_tab:
            await img_tab.click()
            await asyncio.sleep(0.3)
    except Exception:
        pass
    inp = await _find_input(page)
    # ProseMirror doesn't support fill() — use click + select-all + type
    await inp.click(force=True)
    await page.keyboard.press("Control+a")
    await page.keyboard.press("Delete")
    await page.keyboard.type(text, delay=15)
    # Try dedicated send button first, fall back to Enter
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


# ── Image capture ──────────────────────────────────────────────────────────────

async def _wait_for_and_save_image(page: Page) -> str:
    """Wait for Grok to produce a generated image and save it to disk.

    Dual strategy:
    1. Network interceptor — catches the CDN image response (fast path).
       Accepts any content-type: image/* response above _MIN_IMAGE_BYTES from
       a known Grok domain, OR any large image/png or image/jpeg from any domain
       (generated images are much larger than UI sprites).
    2. DOM poller — every 2 s scrolls and looks for <img> elements whose src
       is a fetchable URL (http/blob) not seen before prompt submission.

    Returns:
        Absolute path to the saved file on success.
        "REFUSAL:<text>" if Grok declines to generate.

    Raises:
        asyncio.TimeoutError after 300 s.
    """
    loop = asyncio.get_running_loop()
    img_future:     asyncio.Future[bytes] = loop.create_future()
    refusal_future: asyncio.Future[str]   = loop.create_future()

    # The redesigned /imagine page renders results in a masonry feed that already
    # contains the user's existing gallery/history. DOM order does NOT match
    # visual order, and the feed isn't loaded yet at submit time, so "first new
    # img" reliably grabs a stale history thumbnail. Instead: once the existing
    # feed has rendered, record the CURRENT topmost feed image as a baseline; the
    # image generated for THIS prompt then appears as a DIFFERENT image at the top
    # (newest lands first). If nothing new ever tops the baseline we time out —
    # correct, e.g. when generation is unavailable (lapsed SuperGrok billing).
    async def _top_big_src() -> Optional[str]:
        """Full src of the topmost main-feed-sized data: image, or None.
        Sidebar/history thumbnails render small and are excluded by width."""
        try:
            return await page.evaluate(
                """() => {
                    let best = null;
                    for (const im of document.querySelectorAll('img[src^="data:image"]')) {
                        const r = im.getBoundingClientRect();
                        if (r.width < 200 || im.naturalWidth < 400) continue;
                        const top = r.top + window.scrollY;
                        if (best === null || top < best.top) best = {top, s: im.src};
                    }
                    return best ? best.s : null;
                }"""
            )
        except Exception:
            return None

    async def _result_ready() -> bool:
        """True once a finished generation result is on screen. Grok shows
        'Enhance Quality' / 'Think Harder' actions only under a completed result,
        never while merely browsing the feed — so this marks generation done."""
        try:
            return await page.evaluate(
                """() => [...document.querySelectorAll('button')]
                    .some(b => /enhance|think harder/i.test(b.innerText || ''))"""
            )
        except Exception:
            return False

    # Record the topmost result image the INSTANT we start waiting — this runs
    # right after submit, before the new generation has rendered (~10s), so it
    # captures the prior top (a previous result or None), NOT our new image. We
    # must NOT wait here: generation is fast, and waiting would let the fresh
    # image become the baseline and then be wrongly excluded.
    baseline_src: Optional[str] = await _top_big_src()

    # http/blob snapshot for the fallback path (rare now that results are data:).
    _pre_srcs: set[str] = set()
    try:
        for el in await page.query_selector_all("img[src]"):
            src = await el.get_attribute("src")
            if src and not src.startswith("data:image"):
                _pre_srcs.add(src)
    except Exception:
        pass

    # ── Network interceptor ────────────────────────────────────────────────────
    async def on_response(response) -> None:
        if img_future.done():
            return
        ct = response.headers.get("content-type", "")
        if not ct.startswith("image/"):
            return
        # Only accept the user's generation CDN — NOT any large image. The
        # gallery/showcase images (imagine-public.x.ai, grok.com/_next/image)
        # would otherwise be captured as false positives.
        if not any(d in response.url for d in _GROK_IMAGE_DOMAINS):
            return
        try:
            body = await response.body()
        except Exception:
            return
        if not body or len(body) < _MIN_IMAGE_BYTES:
            return
        if not img_future.done():
            img_future.set_result(body)

    page.on("response", on_response)

    # ── DOM poller ─────────────────────────────────────────────────────────────
    async def _poll() -> None:
        while True:
            # Keep the TOP of the feed rendered (newest generation lands there).
            # Deliberately do NOT scroll to the bottom — that lazy-loads older
            # history we never want.
            try:
                await page.evaluate("window.scrollTo(0, 0)")
            except Exception:
                pass

            # Refusal detection — look for canned refusal phrases in response text
            try:
                text_els = await page.query_selector_all(
                    '[class*="message"] p, [class*="response"] p, article p'
                )
                for el in text_els:
                    txt = await el.inner_text()
                    if txt and any(w in txt.lower() for w in (
                        "i can't", "i'm unable", "i cannot", "i'm not able",
                        "can't generate", "cannot generate", "unable to generate",
                        "not able to create", "can't create",
                    )):
                        if not refusal_future.done():
                            refusal_future.set_result(txt)
                        return
            except Exception:
                pass

            # Primary: capture the topmost main-feed image once (a) a completed
            # result is on screen and (b) the top image differs from the baseline
            # we snapshotted at submit time — i.e. our fresh generation has
            # replaced whatever was there. Position-based (not DOM order) so we
            # never grab a history thumbnail; baseline + result-marker gated so we
            # never return a pre-existing image and never fire mid-generation.
            if not img_future.done():
                top = await _top_big_src()
                if top and top != baseline_src and await _result_ready():
                    try:
                        data = base64.b64decode(top.split(",", 1)[1])
                    except Exception:
                        data = b""
                    if len(data) >= _MIN_IMAGE_BYTES and not img_future.done():
                        img_future.set_result(data)
                        return

            # Fallback: a fresh blob:/assets.grok.com image (same-origin or the
            # user's CDN) — kept in case Grok reverts from inline data: URIs.
            if not img_future.done():
                for sel in ('img[src^="blob:"]', 'img[src*="assets.grok.com"]'):
                    try:
                        for el in await page.query_selector_all(sel):
                            src = await el.get_attribute("src")
                            if not src or src in _pre_srcs:
                                continue
                            byte_list = await page.evaluate(
                                """async (url) => {
                                    try {
                                        const resp = await fetch(url, {credentials: 'include'});
                                        if (!resp.ok) return null;
                                        const ct = resp.headers.get('content-type') || '';
                                        if (ct && !ct.startsWith('image/')) return null;
                                        const arr = new Uint8Array(await resp.arrayBuffer());
                                        if (arr.length < 8192) return null;
                                        return Array.from(arr);
                                    } catch (e) { return null; }
                                }""",
                                src,
                            )
                            if byte_list and not img_future.done():
                                img_future.set_result(bytes(byte_list))
                                return
                    except Exception:
                        pass

            await asyncio.sleep(2)

    poll_task = asyncio.create_task(_poll())
    try:
        done, _ = await asyncio.wait(
            {img_future, refusal_future},
            timeout=300,
        )
    finally:
        poll_task.cancel()
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass

    if not done:
        raise asyncio.TimeoutError()

    if refusal_future in done:
        return f"REFUSAL:{refusal_future.result()}"

    body = img_future.result()

    # Detect format from magic bytes
    if body[:4] == b"\x89PNG":
        ext = "png"
    elif body[:3] == b"\xff\xd8\xff":
        ext = "jpg"
    elif body[:4] == b"RIFF":
        ext = "webp"
    else:
        ext = "png"

    path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4().hex}.{ext}")
    Path(path).write_bytes(body)
    return os.path.abspath(path)


# ── MCP Tools ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def grok_web_setup() -> str:
    """Open a visible browser and navigate to grok.com.

    Log in with your X (Twitter) account, then call grok_web_setup_complete.
    Cannot be called while another setup browser is already open."""
    global _setup_playwright, _setup_context
    if _setup_context:
        return "Setup browser already open. Log in and call grok_web_setup_complete."
    try:
        _setup_playwright, _setup_context = await _launch_context(headless=False)
        page = await _get_or_open_page(_setup_context)
        await page.goto(_GROK_URL, wait_until="domcontentloaded")
        return (
            "Browser open — log in to grok.com with your X account, "
            "then call grok_web_setup_complete."
        )
    except Exception as exc:
        _setup_playwright = _setup_context = None
        return f"Error: {exc}"


@mcp.tool()
async def grok_web_setup_complete() -> str:
    """Close the setup browser and persist the X session profile to disk.

    The saved profile is reused for all subsequent grok_web_generate_image calls."""
    global _setup_playwright, _setup_context
    if not _setup_context:
        return "Error: no setup browser open. Call grok_web_setup first."
    try:
        await _setup_context.close()
        await _setup_playwright.stop()
        _setup_context = _setup_playwright = None
        return f"Session profile saved to {PROFILE_DIR}. Ready to generate images."
    except Exception as exc:
        _setup_context = _setup_playwright = None
        return f"Error saving profile: {exc}"


@mcp.tool()
async def grok_web_import_cookies(
    cookies_path: str = "/home/neuroclaw-v1/references/grok-cookies/cookies.json",
) -> str:
    """Import grok.com session cookies from a Cookie-Editor JSON export.

    Use this on a headless server instead of grok_web_setup:
    1. On your local machine, log in to grok.com in Chrome/Firefox.
    2. Export cookies with the Cookie-Editor extension.
    3. Copy the JSON file to the server path specified here.
    4. Call this tool — it injects the cookies into the Chromium profile.
    """
    if not os.path.exists(cookies_path):
        return f"Error: cookies file not found at {cookies_path}"

    _same_site_map = {
        "no_restriction": "None",
        "lax":            "Lax",
        "strict":         "Strict",
        "unspecified":    "Lax",
    }

    try:
        raw = json.loads(Path(cookies_path).read_text())
    except Exception as exc:
        return f"Error reading cookies file: {exc}"

    pw = ctx = None
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
                "sameSite": _same_site_map.get(
                    str(c.get("sameSite", "")).lower(), "Lax"
                ),
            }
            exp = c.get("expirationDate")
            if exp and not c.get("session", False):
                entry["expires"] = float(exp)
            cookies.append(entry)
        await ctx.add_cookies(cookies)
        await ctx.close()
        await pw.stop()
        ctx = pw = None
        return (
            f"Imported {len(cookies)} cookies into {PROFILE_DIR}. "
            "Ready to generate images."
        )
    except Exception as exc:
        return f"Error importing cookies: {exc}"
    finally:
        if ctx:
            try:
                await ctx.close()
            except Exception:
                pass
        if pw:
            try:
                await pw.stop()
            except Exception:
                pass


@mcp.tool()
async def grok_web_generate_image(prompt: str) -> str:
    """Generate an image via grok.com (Aurora model) using the web UI quota.

    No xAI API key or API rate limits — uses your logged-in X session.
    Requires a saved session: call grok_web_setup or grok_web_import_cookies first.

    Args:
        prompt: Description of the image to generate.

    Returns:
        "path: /abs/path/image.png\\ndescription: <prompt>" on success.
        "Error: <reason>" on failure.
    """
    if not _profile_exists():
        return (
            "Error: no session profile found — "
            "run grok_web_setup or grok_web_import_cookies first"
        )

    async with _gen_lock:
        try:
            _, ctx = await _get_gen_context()
            page = await _get_or_open_page(ctx)

            # Navigate fresh to /imagine so the pre-snapshot only sees templates,
            # not previously generated images.
            await page.goto(_GROK_URL, wait_until="domcontentloaded")
            await asyncio.sleep(2)

            # Check session is alive
            if any(x in page.url for x in (
                "x.com/i/oauth2", "twitter.com/login", "x.com/login", "accounts.x.com"
            )):
                return "Error: session expired — run grok_web_setup or grok_web_load_storage_state"

            # Start image watcher BEFORE submitting so the network interceptor
            # is active when the generation response arrives (images can appear
            # in <10s on the Imagine page — faster than the old chat flow).
            watcher_task = asyncio.create_task(_wait_for_and_save_image(page))
            await asyncio.sleep(0.5)  # Let interceptor register

            await _submit_prompt(page, prompt)

            try:
                result = await asyncio.wait_for(watcher_task, timeout=300)
            except asyncio.TimeoutError:
                watcher_task.cancel()
                await _reset_gen_context()
                return "Error: image generation timed out after 300s"

            if result.startswith("REFUSAL:"):
                return result[8:]

            return f"path: {result}\ndescription: {prompt}"

        except FileNotFoundError:
            return "Error: Playwright Chromium not installed — run: playwright install chromium"
        except Exception as exc:
            await _reset_gen_context()
            return f"Error: {exc}"


@mcp.tool()
async def grok_web_load_storage_state(
    storage_state_path: str = "/root/.grok/storage_state.json",
) -> str:
    """Import grok.com session cookies from a Playwright storage_state.json file.

    Use this when cookies were synced via the AI Cookie Sync browser extension,
    which writes Playwright-format state to /root/.grok/storage_state.json.
    """
    if not os.path.exists(storage_state_path):
        return f"Error: file not found: {storage_state_path}"
    try:
        data = json.loads(Path(storage_state_path).read_text())
    except Exception as exc:
        return f"Error reading file: {exc}"

    if not isinstance(data, dict) or "cookies" not in data:
        return f"Error: not a Playwright storage_state file (keys: {list(data.keys()) if isinstance(data, dict) else type(data).__name__})"

    cookies = data["cookies"]
    if not cookies:
        return "Error: storage_state file contains no cookies"

    pw = ctx = None
    try:
        pw, ctx = await _launch_context(headless=True)
        await ctx.add_cookies(cookies)
        await ctx.close()
        await pw.stop()
        ctx = pw = None
        return f"Imported {len(cookies)} cookies from {storage_state_path} into {PROFILE_DIR}. Ready to generate images."
    except Exception as exc:
        return f"Error importing cookies: {exc}"
    finally:
        for obj, method in [(ctx, "close"), (pw, "stop")]:
            if obj is not None:
                try:
                    await getattr(obj, method)()
                except Exception:
                    pass


if __name__ == "__main__":
    mcp.run(transport="http", host=os.getenv("HOST", "127.0.0.1"), port=PORT)
