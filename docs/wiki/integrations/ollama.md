---
title: Ollama provider
description: Configuration, retry behaviour and troubleshooting for the Ollama / Ollama Cloud provider.
order: 65
---

# Ollama provider

The `ollama` provider is a thin OpenAI-compatible wrapper around the [Ollama](https://ollama.com) local LLM server, as well as remote or cloud Ollama endpoints (including Ollama Cloud's own public API).

---

## Activating

Create or edit an agent and set:

```
provider: ollama
```

Optionally set a model override; otherwise the system falls back to `OLLAMA_MODEL` (default: `llama3.2`).

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama server's OpenAI-compatible endpoint. For Ollama Cloud, use `https://api.ollama.com/v1` (must end in `/v1`). |
| `OLLAMA_MODEL` | `llama3.2` | Default model for the `ollama` provider. |
| `OLLAMA_RETRY_MAX` | `2` | Number of retry attempts on transient stream / connection errors. |
| `OLLAMA_RETRY_BASE_MS` | `1500` | Base delay (ms) for exponential backoff between retries. |

All variables are in `.env` and hot-reload on save (no restart required).

---

## Architecture

`src/agent/ollama-client.ts` creates an `OpenAI` SDK client pointed at `OLLAMA_BASE_URL` with a dummy `apiKey: 'ollama'` and `dangerouslyAllowBrowser: true`. The latter removes browser-like transport restrictions that can trigger SSE stream closes on cloud Ollama endpoints.

Because there is no real API key, the client is lazily initialised and reused. If it detects repeated failures, the singleton is reset so a new TCP connection is established.

---

## Retry logic

The Ollama path retries **both** connection-time failures and mid-stream disconnects:

| Where | Retryable errors |
|---|---|
| Pre-stream (`chat.completions.create`) | `premature close`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOBUFS`, `DNS failures`, `socket hang up`, `fetch failed`, `connection closed` |
| Mid-stream (`for await...of`) | Same set of errors above |

On each retry:

1. The old `OpenAI` client singleton is dropped (`resetOllamaClient()`)
2. A new TCP connection is created (`getOllamaClient()`)
3. Exponential backoff is applied: `delay = OLLAMA_RETRY_BASE_MS * 2^(attempt)` ms

For mid-stream retries, the assistant's partial text is preserved and prepended to the next response, so the user does not lose generated content.

The same retry logic is applied to **sub-agent calls** in `sub-agent-runner.ts`.

---

## Heartbeat integration

The heartbeat pings every active Ollama agent once per `HEARTBEAT_INTERVAL_SEC` (default 60 s). After **3 consecutive heartbeat failures**, `resetOllamaClient()` is triggered so the next attempt uses a fresh TCP socket.

---

## Troubleshooting

### "Premature close" or stream disconnects

Ollama Cloud — and some reverse proxies in front of remote Ollama servers — can abort SSE streams mid-response, especially over unstable networks.

**What it looks like:**
```
Ollama error: Premature close
```

**Fixes:**

1. Increase retry patience:
   ```bash
   OLLAMA_RETRY_MAX=3
   OLLAMA_RETRY_BASE_MS=2000
   ```

2. Lower `max_tokens` per agent — shorter completions are less likely to trigger idle-timeout kills.

3. Verify the base URL ends in `/v1`:
   ```
   https://api.ollama.com/v1   # correct
   https://api.ollama.com       # incorrect
   ```

### Agents not responding at all

1. For local servers: `ollama serve` must be running and the model must be pulled (`ollama list`).
2. For Ollama Cloud: ensure your account has credits or the model is public.
3. Check the dashboard heartbeat table for Ollama agents — consecutive failures suggest a stale connection.

---

## When to use Ollama

- **Local / air-gapped**: Run models on your own hardware with zero API costs.
- **Ollama Cloud**: Use Ollama's public hosted inference for open-weight models.
- **Custom endpoints**: Point at any OpenAI-compatible proxy or gateway that serves Ollama models.

**Trade-offs:**

- Ollama models generally do not support tool calling unless the model itself has been fine-tuned for it. Agents running on Ollama may not be able to call tools or spawn sub-agents in models like `llama3.2`.
- Latency depends heavily on the machine (local) or network (cloud/proxy).
- Ollama Cloud SSE streams can be less stable than commercial API streams, so keep `OLLAMA_RETRY_MAX >= 2`.