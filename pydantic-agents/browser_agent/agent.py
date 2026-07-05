"""Browser agent — Playwright-backed FastMCP server.

When BROWSER_USE_API_KEY is set, connects to the browser-use cloud (stealth,
no local install needed). Otherwise launches a local headless Chromium.

Same tool interface as before — all existing agents continue working unchanged.

Typical agent workflow:
  1. browser_open(url)           → snapshot with element refs (@e1, @e2 …)
  2. browser_click("@e3")        → updated snapshot after click
  3. browser_fill("@e5", "text") → updated snapshot after fill
  4. Repeat until task complete

Sessions are isolated browser instances. Multiple agents can work in parallel
using different session names.
"""

from __future__ import annotations

import base64
import os
from typing import Any, Callable

from dotenv import load_dotenv
from fastmcp import FastMCP
from playwright.sync_api import Playwright, sync_playwright

load_dotenv()

PORT            = int(os.getenv("PYDANTIC_BROWSER_AGENT_PORT", "7107"))
_KEY            = os.getenv("BROWSER_USE_API_KEY", "")
_WSS_URL        = f"wss://connect.browser-use.com?apiKey={_KEY}" if _KEY else ""

mcp = FastMCP("browser-agent")

_pw: Playwright | None = None
# session name → {browser, context, page}
_sessions: dict[str, dict[str, Any]] = {}


def _get_pw() -> Playwright:
    global _pw
    if _pw is None:
        _pw = sync_playwright().start()
    return _pw


def _get_session(session: str) -> dict[str, Any]:
    """Return an existing live session or open a new one."""
    sess = _sessions.get(session)
    if sess:
        try:
            sess["page"].url  # raises if browser disconnected
            return sess
        except Exception:
            _sessions.pop(session, None)

    pw = _get_pw()
    try:
        if _WSS_URL:
            browser = pw.chromium.connect_over_cdp(_WSS_URL)
            context = browser.new_context()
        else:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context()
    except Exception as exc:
        hint = "" if _WSS_URL else " Run: playwright install chromium"
        return {"error": f"Browser launch failed: {exc}.{hint}"}

    page = context.new_page()
    sess = {"browser": browser, "context": context, "page": page}
    _sessions[session] = sess
    return sess


def _snapshot(page: Any) -> str:
    """Build an interactive-elements snapshot. Stamps data-nclaw-ref on each
    visible interactive element so click/fill can target them stably."""
    try:
        elements = page.evaluate("""
            () => {
                const sel = [
                    'a[href]', 'button', 'input:not([type="hidden"])',
                    'select', 'textarea',
                    '[role="button"]', '[role="link"]', '[role="checkbox"]',
                    '[role="menuitem"]', '[role="tab"]', '[role="option"]',
                    '[contenteditable="true"]'
                ].join(', ');

                const visible = el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && !el.disabled && !el.hidden;
                };

                const elems = Array.from(document.querySelectorAll(sel)).filter(visible);
                elems.forEach((el, i) => el.setAttribute('data-nclaw-ref', String(i + 1)));

                return elems.map((el, i) => {
                    const tag   = el.tagName.toLowerCase();
                    const type  = el.type  ? `:${el.type}` : '';
                    const label = (
                        el.getAttribute('aria-label') ||
                        el.getAttribute('placeholder') ||
                        el.getAttribute('title') ||
                        el.textContent ||
                        el.value || ''
                    ).trim().replace(/\\s+/g, ' ').slice(0, 80);
                    const href  = el.href ? ` → ${el.href.slice(0, 80)}` : '';
                    return `@e${i + 1}  [${tag}${type}]  ${label}${href}`;
                }).join('\\n');
            }
        """)
        return f"URL: {page.url}\nTitle: {page.title()}\n\n{elements or '(no interactive elements)'}"
    except Exception as exc:
        return f"Error building snapshot: {exc}"


def _run(session: str, fn: Callable[[Any], str]) -> str:
    """Resolve session, run fn(page), return result or error string."""
    sess = _get_session(session)
    if "error" in sess:
        return sess["error"]
    try:
        return fn(sess["page"])
    except Exception as exc:
        return f"Error: {exc}"


# ── Navigation ────────────────────────────────────────────────────────────────

@mcp.tool()
def browser_open(url: str, session: str = "default") -> str:
    """Navigate to a URL and return a compact interactive snapshot.
    Element refs (@e1, @e2 …) can be passed to browser_click or browser_fill.
    Use a unique session name to isolate parallel browsing."""
    def go(page: Any) -> str:
        page.goto(url, timeout=30000, wait_until="domcontentloaded")
        return _snapshot(page)
    return _run(session, go)


@mcp.tool()
def browser_go_back(session: str = "default") -> str:
    """Navigate back in browser history and return the updated snapshot."""
    def go(page: Any) -> str:
        page.go_back(timeout=15000, wait_until="domcontentloaded")
        return _snapshot(page)
    return _run(session, go)


# ── Observation ───────────────────────────────────────────────────────────────

@mcp.tool()
def browser_snapshot(session: str = "default", interactive_only: bool = True) -> str:
    """Get the current page state as a structured snapshot with element refs.
    interactive_only=True (default) returns only clickable/fillable elements —
    use False to also append full page text."""
    def go(page: Any) -> str:
        snap = _snapshot(page)
        if not interactive_only:
            body = page.inner_text("body")[:3000]
            snap += f"\n\n── Page text ──\n{body}"
        return snap
    return _run(session, go)


@mcp.tool()
def browser_get(what: str = "text", session: str = "default") -> str:
    """Get a specific piece of page information.
    what: text | title | url | html"""
    def go(page: Any) -> str:
        if what == "text":
            return page.inner_text("body")
        if what == "title":
            return page.title()
        if what == "url":
            return page.url
        if what == "html":
            return page.content()
        return f"Unknown what='{what}'. Use: text | title | url | html"
    return _run(session, go)


@mcp.tool()
def browser_screenshot(session: str = "default") -> str:
    """Take a screenshot of the current page and return it as a base64 PNG.
    Useful when the agent needs visual confirmation of page state."""
    def go(page: Any) -> str:
        data = page.screenshot(type="png")
        return "data:image/png;base64," + base64.b64encode(data).decode()
    return _run(session, go)


# ── Interaction ───────────────────────────────────────────────────────────────

@mcp.tool()
def browser_click(ref: str, session: str = "default") -> str:
    """Click an element by its ref (@e1, @e2 …) from a snapshot.
    Returns the updated page snapshot after the click."""
    def go(page: Any) -> str:
        n = ref.lstrip("@e").strip()
        page.click(f'[data-nclaw-ref="{n}"]', timeout=10000)
        page.wait_for_load_state("domcontentloaded", timeout=10000)
        return _snapshot(page)
    return _run(session, go)


@mcp.tool()
def browser_fill(ref: str, value: str, session: str = "default") -> str:
    """Fill an input field by its ref (@e1, @e2 …) with a value.
    Clears any existing value before typing. Returns the updated snapshot."""
    def go(page: Any) -> str:
        n = ref.lstrip("@e").strip()
        page.fill(f'[data-nclaw-ref="{n}"]', value, timeout=10000)
        return _snapshot(page)
    return _run(session, go)


@mcp.tool()
def browser_type(text: str, session: str = "default") -> str:
    """Type text at the current cursor position (no element targeting).
    Useful after clicking into a field. Returns the updated snapshot."""
    def go(page: Any) -> str:
        page.keyboard.type(text)
        return _snapshot(page)
    return _run(session, go)


@mcp.tool()
def browser_scroll(direction: str = "down", amount: int = 3, session: str = "default") -> str:
    """Scroll the page. direction: up | down | left | right. amount: scroll steps.
    Returns the updated snapshot (new elements may appear after scrolling)."""
    def go(page: Any) -> str:
        delta = amount * 300
        dx, dy = {
            "down":  (0,  delta),
            "up":    (0, -delta),
            "right": ( delta, 0),
            "left":  (-delta, 0),
        }.get(direction, (0, delta))
        page.evaluate(f"window.scrollBy({dx}, {dy})")
        return _snapshot(page)
    return _run(session, go)


@mcp.tool()
def browser_wait(condition: str, value: str = "", session: str = "default") -> str:
    """Wait for a condition before continuing.
    condition: selector | text | url | timeout
    value: CSS selector / text string / URL pattern / seconds to wait."""
    def go(page: Any) -> str:
        if condition == "timeout":
            page.wait_for_timeout(int(value or 2) * 1000)
        elif condition == "url":
            page.wait_for_url(value, timeout=30000)
        elif condition == "text":
            page.wait_for_function(
                f"document.body.innerText.includes({repr(value)})", timeout=30000
            )
        else:
            page.wait_for_selector(condition, timeout=30000)
        return _snapshot(page)
    return _run(session, go)


# ── Advanced ──────────────────────────────────────────────────────────────────

@mcp.tool()
def browser_eval(js: str, session: str = "default") -> str:
    """Execute JavaScript in the current page context and return the result.
    Use for reading dynamic values, triggering JS events, or extracting data
    that isn't in the accessibility tree."""
    def go(page: Any) -> str:
        return str(page.evaluate(js))
    return _run(session, go)


@mcp.tool()
def browser_find(description: str, action: str = "click", session: str = "default") -> str:
    """Find and interact with an element by its visible text or aria label.
    action: click | hover | focus. Returns the updated snapshot."""
    def go(page: Any) -> str:
        loc = page.get_by_text(description, exact=False).first
        if action == "click":
            loc.click(timeout=10000)
            page.wait_for_load_state("domcontentloaded", timeout=10000)
        elif action == "hover":
            loc.hover(timeout=10000)
        elif action == "focus":
            loc.focus(timeout=10000)
        return _snapshot(page)
    return _run(session, go)


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    mcp.run(transport="http", host=host, port=PORT)
