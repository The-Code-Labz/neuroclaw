# ChatGPT Image Agent — Design Spec

**Date:** 2026-05-20  
**Status:** Approved  
**Scope:** New pydantic agent that wraps ChatGPT's web UI for image generation and editing, exposed as a FastMCP server.

---

## 1. Architecture

New file: `pydantic-agents/chatgpt_image_agent/agent.py`

Follows the identical FastMCP pattern as `image_agent` and `browser_agent`. Exposes four tools via FastMCP on port 7110:

| Tool | Purpose |
|---|---|
| `chatgpt_setup` | One-time: open visible browser for manual login |
| `chatgpt_setup_complete` | Close setup browser, save profile to disk |
| `chatgpt_image_generate` | Text prompt → image file |
| `chatgpt_image_edit` | Existing image + prompt → edited image file |

**Stack:**
- `playwright` (Python async) — browser automation
- `playwright-stealth` — Cloudflare/bot fingerprint bypass
- `fastmcp` — MCP server layer
- `python-dotenv` — env config
- Persistent Chromium user-data-dir — one login, stays logged in across runs

**Output dir:** `pydantic-agents/chatgpt_image_agent/outputs/` (git-ignored)  
**Profile dir:** `pydantic-agents/chatgpt_image_agent/profile/` (git-ignored, contains session tokens)

---

## 2. Session Management

### First-time setup (run once)
1. Call `chatgpt_setup` from any NeuroClaw agent
2. A visible Chromium window opens and navigates to `https://chatgpt.com/`
3. Tool returns: `"Browser open — log in to ChatGPT, then call chatgpt_setup_complete"`
4. User logs in manually (Google SSO or email)
5. Call `chatgpt_setup_complete` — browser closes, profile saved to `CHATGPT_PROFILE_DIR`

**Implementation note:** `chatgpt_setup` stores the open browser context in a module-level `_setup_context` variable. `chatgpt_setup_complete` calls `_setup_context.close()`, which flushes the persistent profile to disk. MCP tool calls are async and return immediately, so this is the only way to keep the browser alive between the two calls.

### Subsequent runs
Playwright launches with `launch_persistent_context(user_data_dir=CHATGPT_PROFILE_DIR, headless=True)` plus stealth patches. No re-login required. Session persists until ChatGPT's cookies expire (typically weeks). Re-run `chatgpt_setup` when they do.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `CHATGPT_PROFILE_DIR` | `./pydantic-agents/chatgpt_image_agent/profile` | Chromium user-data-dir |
| `CHATGPT_HEADLESS` | `true` | Set `false` for debugging |
| `CHATGPT_IMAGE_AGENT_PORT` | `7110` | FastMCP server port |
| `CHATGPT_IMAGE_OUTPUT_DIR` | `./pydantic-agents/chatgpt_image_agent/outputs` | Where images are saved |

---

## 3. Tool Interfaces

```python
@mcp.tool()
async def chatgpt_setup() -> str:
    """Open a visible browser and navigate to ChatGPT.
    Log in, then call chatgpt_setup_complete."""

@mcp.tool()
async def chatgpt_setup_complete() -> str:
    """Close the setup browser and save the session profile."""

@mcp.tool()
async def chatgpt_image_generate(
    prompt: str,
    style: str = "auto"  # "auto" | "vivid" | "natural"
) -> str:
    """Generate a new image from a text prompt via ChatGPT.
    Returns: 'path: /abs/path/image.png\ndescription: <prompt>'"""

@mcp.tool()
async def chatgpt_image_edit(
    prompt: str,
    image_path: str  # absolute or relative path to source image
) -> str:
    """Edit an existing image using a prompt via ChatGPT.
    Returns: 'path: /abs/path/image.png\ndescription: <prompt>'"""
```

**Return format** mirrors the existing `image_agent` exactly (`path: ...\ndescription: ...`) so Da Vinci and other agents handle both providers identically.

**Style implementation:** passed as a prompt suffix (`"...in vivid style"` / `"...in natural style"`), since the ChatGPT web UI has no separate style toggle.

---

## 4. Generation & Download Flow

### Generate
1. Launch persistent Chromium context with stealth patches applied
2. Navigate to `https://chatgpt.com/` — wait for `#prompt-textarea`
3. Type: `"Generate an image: {prompt}"` (explicit instruction prevents text-only response)
4. Submit via Enter or `[data-testid="send-button"]`
5. Wait for assistant message → poll for `<img>` tag — 120s timeout
6. Fetch image URL via `page.request.get(url)` (carries session cookies automatically)
7. Write bytes to `outputs/{uuid}.png`, return `path: ...\ndescription: ...`

### Edit
1. Same launch + navigate
2. Click attachment button, upload `image_path` via `set_input_files()`
3. Type edit prompt, submit
4. Same wait-and-download as generate (120s timeout)

### Timing
120s timeout covers ChatGPT's observed generation range of 8–45s under varying server load.

### Image extraction
ChatGPT serves generated images as `<img src="https://files.oaiusercontent.com/...">` inside the assistant message. Fetched via `page.request.get(url)` — no separate auth headers needed.

### Selector resilience
Priority list rather than single selectors to survive DOM updates:

- **Send button:** `[data-testid="send-button"]` → fallback `button[aria-label*="Send"]`
- **Image result:** `[data-message-author-role="assistant"] img[src*="oaiusercontent"]` → fallback any new `<img>` appearing after submit

---

## 5. Error Handling

| Scenario | Response |
|---|---|
| Profile dir missing / not set up | `"Error: run chatgpt_setup first"` |
| Session expired (redirected to login page) | `"Error: session expired — run chatgpt_setup"` |
| Image never appears within 120s | `"Error: generation timed out after 120s"` |
| ChatGPT content policy refusal | Return assistant's refusal text verbatim |
| Image CDN fetch fails | `"Error: image download failed — {status}"` |
| `image_path` not found (edit tool) | `"Error: image_path not found"` (checked before browser launch) |
| Playwright not installed | `"Error: run playwright install chromium"` |

No retry logic — errors surface immediately so the calling agent (Da Vinci / Alfred) decides whether to fallback to Venice or VoidAI.

---

## 6. NeuroClaw Integration

### Running the server
Added to `pydantic-agents/run-all.sh`:
```bash
python pydantic-agents/chatgpt_image_agent/agent.py &
```

Docker entry at `pydantic-agents/docker/Dockerfile.chatgpt-image-agent` (mirrors `Dockerfile.browser-agent`).

### Dashboard registration
1. MCP Servers tab → add `http://localhost:7110`
2. Create two NeuroClaw agents:
   - **ChatGPT Image** → server `http://localhost:7110`, tool `chatgpt_image_generate`
   - **ChatGPT Edit** → server `http://localhost:7110`, tool `chatgpt_image_edit`

Both appear as `@ChatGPTImage` / `@ChatGPTEdit` in Discord/CLI and as `agent__chatgpt_image_generate()` / `agent__chatgpt_image_edit()` in every local agent's tool list.

### Da Vinci routing
Add one line to Da Vinci's system prompt:
> "For premium quality images or when the user explicitly requests ChatGPT images: use `agent__chatgpt_image_generate`."

No other code changes required.

---

## 7. Files to Create

| File | Purpose |
|---|---|
| `pydantic-agents/chatgpt_image_agent/__init__.py` | Package marker |
| `pydantic-agents/chatgpt_image_agent/agent.py` | FastMCP server (main implementation) |
| `pydantic-agents/docker/Dockerfile.chatgpt-image-agent` | Docker image |
| `.gitignore` additions | `pydantic-agents/chatgpt_image_agent/profile/`, `pydantic-agents/chatgpt_image_agent/outputs/` |
| `pydantic-agents/run-all.sh` | Add chatgpt_image_agent startup line |

### Dependencies to add to `pydantic-agents/requirements.txt`
```
playwright
playwright-stealth
```

(Playwright browsers installed separately via `playwright install chromium`)
