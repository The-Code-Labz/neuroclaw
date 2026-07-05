---
title: Browser tools
order: 50
---

# Browser tools

NeuroClaw agents can control a real Chromium browser through a [Browserless](https://www.browserless.io/) instance. All four `browser_*` tools route through the thin HTTP client in `src/system/browser.ts`, which POSTs JSON to the Browserless REST API and returns structured results. Because a real browser renders the page, tools work on JavaScript-heavy SPAs that return no useful content in their initial HTML response.

## Prerequisites

Two environment variables must both be set before any browser tool becomes available:

- `BROWSERLESS_URL` — the base URL of your Browserless instance (e.g. `https://chrome.browserless.io`).
- `BROWSERLESS_TOKEN` — the API token for that instance.

When either variable is missing, `config.browser.enabled` is `false` and every `browser_*` call returns `{ ok: false, error: "browser tools disabled …" }` without making a network request.

Unlike exec tools, browser tools are **not gated per-agent** — any agent that runs inside a NeuroClaw session can call them once the two env vars are present. There is no `exec_enabled` or equivalent column required.

## The four browser tools

### browser_fetch

Calls the Browserless `/content` endpoint and returns the fully-rendered HTML of a page after JavaScript has run. The raw HTML is capped at 500,000 bytes to keep agent contexts manageable; if the page is larger, `html_truncated: true` appears in the response.

Key parameters:
- `url` (required) — page to load.
- `wait_for` — a CSS selector to wait on, or a millisecond delay, before capturing HTML.
- `include_main_text` — when `true`, runs the returned HTML through `@mozilla/readability` and adds `title`, `byline`, and `mainText` to the response. Useful when you want article body text without parsing HTML.
- `include_screenshot` — when `true`, also hits `/screenshot` and appends a base64-encoded JPEG of the full page as `screenshot.base64`.

Response shape: `{ ok, url, html, bytes, html_truncated?, title?, byline?, mainText?, screenshot? }`

### browser_screenshot

Calls the Browserless `/screenshot` endpoint and returns binary image data encoded as base64. The default is a full-page PNG at 1920x1080. The base64 value can be fed directly to a vision model or decoded and saved as a file.

Key parameters:
- `url` (required) — page to capture.
- `format` — `"png"` (default) or `"jpeg"`. JPEG produces smaller payloads when file size matters.
- `full_page` — `true` by default (scrolls and stitches the entire page). Set to `false` for only the visible viewport.
- `viewport` — `{ width, height }` object to override the 1920x1080 default.

Response shape: `{ ok, url, base64, bytes, mime }`

### browser_pdf

Calls the Browserless `/pdf` endpoint and returns a rendered PDF as base64. Backgrounds are printed by default. Useful for archiving articles or generating printable output from live web forms.

Key parameters:
- `url` (required) — page to render.
- `format` — paper size string such as `"A4"` (default) or `"Letter"`.
- `landscape` — `true` to render in landscape orientation.

Response shape: `{ ok, url, base64, bytes, mime: "application/pdf" }`

### browser_run_js

Calls the Browserless `/function` endpoint, which executes an arbitrary async script in a real Puppeteer Node context. The page is navigated to `url` with `networkidle2`, then the body of `script` runs with `page` and `context` in scope. The tool wraps the script body in a Puppeteer-compatible module export automatically — you only write the function body.

This is the most powerful browser tool. Use it for site-specific scraping that cannot be satisfied by `browser_fetch` plus readability parsing — for example, clicking through pagination, filling forms, or extracting data buried behind dynamic DOM manipulation.

Key parameters:
- `url` (required) — page to load before running the script.
- `script` (required) — async function body. Has access to `page` (Puppeteer Page) and `context` (contains `{ url }`). Must `return` a JSON-serializable value.
- `return_value` — set to `false` to suppress the return value in the response (useful when the script performs an action with no meaningful output).

Response shape: `{ ok, url, result? }`

Example script body:
```js
const price = await page.$eval('.product-price', el => el.innerText);
return { price };
```

## Authentication

The Browserless token is sent as the `token` query parameter on every request (`?token=<encoded>`). The hosted Browserless service also uses this token for per-organisation rate limiting. The token is never included in request headers or the POST body.

## Timeout configuration

Every request is wrapped in an `AbortController` that fires after `BROWSERLESS_TIMEOUT_MS` milliseconds (default 60,000 ms / 1 minute). When the deadline is exceeded, the tool throws `"browserless <path> timed out after <N>ms"` which surfaces to the agent as `{ ok: false, error: "…" }`.

Individual tool calls can supply a per-request `timeoutMs` override at the client level, but the agent-facing tool schemas use the global default.

## Error handling

The HTTP client reads the error body as plain text on any non-2xx response and includes up to 800 characters of that body in the thrown error message. This preserves Browserless stack traces and diagnostic output rather than losing them in a JSON parse failure. Tool handlers catch all thrown errors and return `{ ok: false, error: "<message>" }` so a failed browser call never crashes the agent turn.

All four tools log a `browser_action` event to the Hive Mind on success, recording the tool name, URL, and relevant metadata (byte count, format, script length, etc.).

## Configuration reference

| Variable | Default | Notes |
|---|---|---|
| `BROWSERLESS_URL` | — | Required. Base URL of your Browserless instance. |
| `BROWSERLESS_TOKEN` | — | Required. API token; sent as `?token=` query param. Both variables must be set for tools to activate. |
| `BROWSERLESS_TIMEOUT_MS` | `60000` | Per-request timeout in milliseconds. Applies to all four browser tools. |
