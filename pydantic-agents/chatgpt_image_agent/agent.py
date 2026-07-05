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
import base64
import os
import uuid
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastmcp import FastMCP
from playwright.async_api import async_playwright, BrowserContext, Page, Playwright

import sys as _sys
import os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))))
from shared.image_delivery import deliver_image

load_dotenv()

PORT       = int(os.getenv("CHATGPT_IMAGE_AGENT_PORT", "7110"))
HEADLESS   = os.getenv("CHATGPT_HEADLESS", "true").lower() != "false"

_AGENT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROFILE_DIR = os.getenv("CHATGPT_PROFILE_DIR") or os.path.join(_AGENT_DIR, "profile")
OUTPUT_DIR  = os.getenv("CHATGPT_IMAGE_OUTPUT_DIR") or os.path.join(_AGENT_DIR, "outputs")
# Playwright storage_state written by the AI Cookie Sync extension; refreshed
# into the live browser context before every generate (ChatGPT rotates its
# session-token, and the cached persistent context otherwise keeps stale cookies).
STORAGE_STATE_PATH = os.getenv("CHATGPT_STORAGE_STATE") or "/root/.chatgpt/storage_state.json"

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(PROFILE_DIR, exist_ok=True)

# ChatGPT's server-side image generation can run 200s+; keep this under the
# CLI-side CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (420s) so a slow-but-real gen
# completes instead of being cut off.
_GEN_TIMEOUT_S = int(os.getenv("CHATGPT_GEN_TIMEOUT_S", "360"))

# Two-step setup flow state
_setup_playwright: Optional[Playwright] = None
_setup_context:    Optional[BrowserContext] = None

# Persistent generation context — reused across generate/edit calls so
# each request continues in the same browser session instead of opening a new chat.
_gen_playwright: Optional[Playwright] = None
_gen_context:    Optional[BrowserContext] = None
_gen_lock = asyncio.Lock()

mcp = FastMCP("chatgpt-image-agent")


def _style_suffix(style: str) -> str:
    if style == "vivid":
        return " — vivid, saturated, dramatic style"
    if style == "natural":
        return " — natural, photorealistic style"
    return ""


def _profile_exists() -> bool:
    p = Path(PROFILE_DIR)
    if p.exists() and any(p.iterdir()):
        return True
    # A synced storage_state is a valid session source too — _refresh_cookies
    # injects it into the context at generate time, so a fresh/empty profile
    # (e.g. right after a container recreate, which wipes the ephemeral profile
    # dir) can still authenticate without a manual chatgpt_setup / re-seed.
    return os.path.exists(STORAGE_STATE_PATH)


async def _launch_context(headless: bool = True) -> tuple[Playwright, BrowserContext]:
    """Launch a persistent Chromium context with stealth patches applied."""
    from playwright_stealth import Stealth  # type: ignore[import]
    _stealth = Stealth()

    pw = await async_playwright().start()
    context = await pw.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=headless,
        args=["--no-sandbox", "--disable-setuid-sandbox"],
    )
    for page in context.pages:
        await _stealth.apply_stealth_async(page)
    async def _patch_page(p: Page) -> None:
        try:
            await _stealth.apply_stealth_async(p)
        except Exception:
            pass
    context.on("page", lambda p: asyncio.ensure_future(_patch_page(p)))
    return pw, context


async def _get_gen_context() -> tuple[Playwright, BrowserContext]:
    """Return the persistent generation context, creating it if necessary.
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


async def _refresh_cookies(ctx: BrowserContext) -> int:
    """Reload the freshest synced cookies into ctx before generating.

    The persistent profile accumulates stale/rotated cookies across runs (and the
    gen context is cached for the process lifetime). A stale, non-chunked
    ``__Secure-next-auth.session-token`` left behind makes ChatGPT's client render
    the logged-out shell (the ``modal-no-auth-login`` overlay that intercepts the
    Send click) even when the chunked tokens are valid. Clearing first, then adding
    only the freshly-synced cookies, keeps the session authenticated. No-op (returns
    -1) if the sync file is absent, so manually-set-up profiles still work.
    """
    if not os.path.exists(STORAGE_STATE_PATH):
        return -1
    try:
        import json as _json
        data = _json.loads(Path(STORAGE_STATE_PATH).read_text())
        cookies = data.get("cookies") if isinstance(data, dict) else None
        if not cookies:
            return -1
        await ctx.clear_cookies()
        await ctx.add_cookies(cookies)
        return len(cookies)
    except Exception:
        # Never block a generation on a cookie-refresh hiccup — fall back to
        # whatever cookies the context already holds.
        return -1


async def _get_or_open_page(context: BrowserContext) -> Page:
    if context.pages:
        return context.pages[0]
    return await context.new_page()


async def _ensure_chatgpt_ready(page: Page) -> None:
    """Open a fresh ChatGPT chat with a clean, ready composer.

    Always navigates to a new chat rather than reusing the current conversation:
    a prior turn can leave the composer holding stale text or showing a mid-stream
    Stop button (instead of Send), which wedged every subsequent generation.
    Raises RuntimeError('session_expired') if a login wall is detected."""
    await page.goto("https://chatgpt.com/", wait_until="domcontentloaded")
    if "auth" in page.url or "login" in page.url:
        raise RuntimeError("session_expired")
    await page.wait_for_selector("#prompt-textarea", timeout=30_000)
    await _await_auth_ready(page)


async def _await_auth_ready(page: Page) -> None:
    """Wait out ChatGPT's logged-out shell modal.

    ChatGPT serves a logged-out HTML shell containing a ``modal-no-auth-login``
    overlay, then client JS removes it once it confirms the session. The overlay
    intercepts pointer events, so clicking Send before it clears times out. If
    cookies are valid the modal detaches within a few seconds; if it lingers the
    session is not authenticated."""
    try:
        modal = await page.query_selector('[data-testid="modal-no-auth-login"]')
    except Exception:
        modal = None
    if not modal:
        return
    # The page may have hydrated against pre-refresh cookies — reload once so the
    # freshly-injected session-token is applied, then wait for the modal to clear.
    try:
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_selector("#prompt-textarea", timeout=30_000)
    except Exception:
        pass
    try:
        await page.wait_for_selector(
            '[data-testid="modal-no-auth-login"]', state="detached", timeout=15_000
        )
    except Exception:
        raise RuntimeError("session_expired")


async def _submit_prompt(page: Page, text: str) -> None:
    """Fill the chat input and submit.

    ChatGPT only renders the send button once the composer holds text, and it
    renames/relocates that button periodically. Try the known selectors, then
    fall back to pressing Enter (which also submits) so a markup change can't
    wedge the whole flow."""
    textarea = await page.wait_for_selector("#prompt-textarea", timeout=10_000)
    await textarea.click()
    await textarea.fill(text)
    for selector in ('[data-testid="send-button"]', 'button[aria-label*="Send"]'):
        try:
            btn = await page.wait_for_selector(selector, timeout=3_000)
            await btn.click()
            return
        except Exception:
            continue
    # Fallback: Enter submits the composer in ChatGPT.
    await page.keyboard.press("Enter")


_OPENAI_IMAGE_DOMAINS = (
    "oaiusercontent", "oaidalle", "files.openai.com",
    "chatgpt.com/backend-api/estuary/content",  # current ChatGPT image CDN
)
# ChatGPT's assistant turns no longer carry data-message-author-role, so
# assistant-scoped selectors match nothing — keep these unscoped by src.
_IMG_SELECTORS = [
    'img[src*="estuary/content"]',    # current ChatGPT image CDN
    'img[src*="oaiusercontent"]',     # legacy
    'img[src*="oaidalle"]',
]
_REFUSAL_PHRASES = (
    "i can't", "i can’t", "i'm unable", "i’m unable", "i cannot",
    "i'm not able", "i’m not able", "i won't", "i’m sorry",
    "unable to create", "can't create", "can't help with",
    "not able to generate", "against our", "violate",
)
# Fetch an image URL inside the page and return it base64-encoded.
# The previous approach returned Array.from(new Uint8Array(buf)) — a ~1-int-per-byte
# JS array marshaled over CDP (~23s for a 2MB image), and ChatGPT re-fires the image
# response ~20x, so that many concurrent giant-array marshals saturated CDP and blew
# past the 270s cap. base64 is a compact string (~0.4s for the same 2MB image).
_FETCH_B64_JS = """async (url) => {
    const r = await fetch(url, {credentials: 'include'});
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null;
    const u = new Uint8Array(await r.arrayBuffer());
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(s);
}"""


async def _wait_for_and_save_image(page: Page) -> str:
    """Wait for ChatGPT to produce an image and save it to disk.

    Uses two parallel strategies:
    - Network interceptor: catches the CDN response as it streams (fast path).
    - DOM poller: scrolls every 2s to trigger lazy loads, then fetches the img
      src if the interceptor missed it (fallback).

    Both fetch bytes as base64, and a single-flight guard ensures only one
    browser-side fetch runs at a time even though ChatGPT re-fires the same
    image response many times.

    Returns absolute path to saved PNG, or 'REFUSAL:<text>'.
    """
    loop = asyncio.get_running_loop()
    img_future: asyncio.Future[bytes] = loop.create_future()
    refusal_future: asyncio.Future[str] = loop.create_future()
    capturing = False  # single-flight: at most one browser-side fetch in flight

    async def _capture(url: str) -> None:
        nonlocal capturing
        if capturing or img_future.done():
            return
        capturing = True
        try:
            b64 = await page.evaluate(_FETCH_B64_JS, url)
            if b64 and not img_future.done():
                img_future.set_result(base64.b64decode(b64))
        except Exception:
            pass
        finally:
            capturing = False

    def on_response(response) -> None:
        if img_future.done() or capturing:
            return
        if not any(d in response.url for d in _OPENAI_IMAGE_DOMAINS):
            return
        if not response.headers.get("content-type", "").startswith("image/"):
            return
        asyncio.create_task(_capture(response.url))

    page.on("response", on_response)

    async def _poll() -> None:
        while True:
            # Scroll to bottom so lazy-loaded images enter the viewport and get fetched
            try:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                pass

            # Check for a content-policy refusal (best effort — turn DOM changes often)
            try:
                text = await page.evaluate("""() => {
                    const nodes = document.querySelectorAll(
                        '[data-message-author-role], .markdown, [data-testid^="conversation-turn"]');
                    const last = nodes[nodes.length - 1];
                    return last ? (last.innerText || '') : '';
                }""")
                low = (text or "").lower()
                if low and any(w in low for w in _REFUSAL_PHRASES) and not refusal_future.done():
                    refusal_future.set_result(text.strip()[:500])
                    return
            except Exception:
                pass

            # Fallback: img is in DOM but the network interceptor missed it.
            if not img_future.done() and not capturing:
                for selector in _IMG_SELECTORS:
                    try:
                        el = await page.query_selector(selector)
                        if not el:
                            continue
                        src = await el.get_attribute("src")
                        if src and src.startswith("http"):
                            await _capture(src)
                            if img_future.done():
                                return
                    except Exception:
                        pass

            await asyncio.sleep(2)

    poll_task = asyncio.create_task(_poll())
    try:
        done, _ = await asyncio.wait(
            {img_future, refusal_future},
            timeout=_GEN_TIMEOUT_S,
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
    path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4().hex}.png")
    Path(path).write_bytes(body)
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
    async with _gen_lock:
        try:
            _, ctx = await _get_gen_context()
            await _refresh_cookies(ctx)
            page = await _get_or_open_page(ctx)
            try:
                await _ensure_chatgpt_ready(page)
            except RuntimeError as e:
                if "session_expired" in str(e):
                    return "Error: session expired — run chatgpt_setup"
                raise
            await _submit_prompt(page, full_prompt)
            try:
                result = await _wait_for_and_save_image(page)
            except asyncio.TimeoutError:
                return f"Error: generation timed out after {_GEN_TIMEOUT_S}s"
            if result.startswith("REFUSAL:"):
                return result[8:]
            delivery = deliver_image(result)
            lines = [f"path: {delivery.local_path}"]
            if delivery.local_url:
                lines.append(f"local_url: {delivery.local_url}")
            if delivery.public_url:
                lines.append(f"public_url: {delivery.public_url}")
            lines.append(f"description: {prompt}")
            return "\n".join(lines)
        except FileNotFoundError:
            return "Error: run playwright install chromium"
        except Exception as exc:
            return f"Error: {exc}"


@mcp.tool()
async def chatgpt_image_edit(prompt: str, image_path: str) -> str:
    """Edit an existing image using a prompt via ChatGPT.
    Returns: 'path: /abs/path/image.png\\ndescription: <prompt>'"""
    if not os.path.exists(image_path):
        return "Error: image_path not found"
    if not _profile_exists():
        return "Error: run chatgpt_setup first"

    async with _gen_lock:
        try:
            _, ctx = await _get_gen_context()
            await _refresh_cookies(ctx)
            page = await _get_or_open_page(ctx)
            try:
                await _ensure_chatgpt_ready(page)
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
                result = await _wait_for_and_save_image(page)
            except asyncio.TimeoutError:
                return f"Error: generation timed out after {_GEN_TIMEOUT_S}s"
            if result.startswith("REFUSAL:"):
                return result[8:]
            delivery = deliver_image(result)
            lines = [f"path: {delivery.local_path}"]
            if delivery.local_url:
                lines.append(f"local_url: {delivery.local_url}")
            if delivery.public_url:
                lines.append(f"public_url: {delivery.public_url}")
            lines.append(f"description: {prompt}")
            return "\n".join(lines)
        except FileNotFoundError:
            return "Error: run playwright install chromium"
        except Exception as exc:
            return f"Error: {exc}"


@mcp.tool()
async def chatgpt_import_cookies(cookies_path: str = "/home/neuroclaw-v1/references/chatgpt-cookies/cookies.json") -> str:
    """Import ChatGPT cookies from a Cookie-Editor JSON export into the session profile.
    Use this on a VPS instead of chatgpt_setup — export cookies from your local browser,
    copy the JSON file to the server, then call this tool with the file path."""
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

    pw: Optional[Playwright] = None
    ctx: Optional[BrowserContext] = None
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
        return f"Imported {len(cookies)} cookies into {PROFILE_DIR}. Ready to generate images."
    except Exception as exc:
        return f"Error importing cookies: {exc}"
    finally:
        if ctx:
            await ctx.close()
        if pw:
            await pw.stop()


@mcp.tool()
async def chatgpt_load_storage_state(
    storage_state_path: str = "/root/.chatgpt/storage_state.json",
) -> str:
    """Import chatgpt.com session cookies from a Playwright storage_state.json file.

    Use this when cookies were synced via the AI Cookie Sync browser extension,
    which writes Playwright-format state to /root/.chatgpt/storage_state.json.
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

    pw: Optional[Playwright] = None
    ctx: Optional[BrowserContext] = None
    try:
        pw, ctx = await _launch_context(headless=True)
        # Clear first so a stale/rotated session-token left in the profile can't
        # shadow the freshly-synced one (that mismatch renders the logged-out shell).
        await ctx.clear_cookies()
        await ctx.add_cookies(cookies)
        await ctx.close()
        await pw.stop()
        ctx = pw = None
        return f"Imported {len(cookies)} cookies from {storage_state_path} into {PROFILE_DIR}. Ready to generate images."
    except Exception as exc:
        return f"Error importing cookies: {exc}"
    finally:
        if ctx:
            await ctx.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    # Honor HOST env (compose sets 0.0.0.0) so the server is reachable through
    # Docker's port forward — hardcoding 127.0.0.1 binds container-loopback only
    # and makes the agent unreachable from the host under its own Dockerfile CMD.
    mcp.run(transport="http", host=os.getenv("HOST", "127.0.0.1"), port=PORT)
