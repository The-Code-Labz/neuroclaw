---
title: Vision preprocessing
order: 45
---

# Vision preprocessing

NeuroClaw agents are text-based by default. When a user attaches an image to a chat message, the platform converts it into a text description before it reaches the agent. This page explains how that conversion works, how to control it per agent, and which environment variables govern the behaviour.

## What vision preprocessing does

When a message arrives with one or more image attachments, the chat route calls a dedicated vision service to generate a text description of each image. Those descriptions are prepended to the user's original message in a structured block before the agent ever sees the turn:

```
[Image 1 "screenshot.png": <description>]
[Image 2: <description>]

<original user message>
```

The agent receives ordinary text — it does not need to support image inputs natively. The approach works with every provider NeuroClaw supports, including VoidAI, Anthropic, and Codex.

## The `vision_mode` agent setting

Each agent has a `vision_mode` field that controls how images are handled for that agent. It accepts three values:

| Value | Behaviour |
|---|---|
| `auto` | Let the platform decide. If the agent's model is known to accept images natively (see capability detection below), images are passed directly to the model. Otherwise preprocessing runs. This is the default. |
| `preprocess` | Always convert images to text descriptions before sending to the agent, regardless of model capability. Safe choice for any provider or model. |
| `native` | Pass the raw image through to the model directly. Only works reliably on OpenAI / VoidAI paths with a vision-capable model. Anthropic and Codex agents that resolve to `native` have attachments silently dropped with a logged warning — configure those agents as `preprocess` instead. |

You can set `vision_mode` when creating or updating an agent via the dashboard or the API:

```json
PATCH /api/agents/:id
{ "vision_mode": "preprocess" }
```

### How `auto` resolves

The `resolveVisionMode()` function in `vision-service.ts` consults a capability list at call time. Current heuristics:

- **OpenAI / VoidAI**: `gpt-4o`, `gpt-4.1`, `gpt-4.5`, `gpt-5.*` and `gpt-4-vision-*` are considered capable. `gpt-3.5-*` and older text-only models are not.
- **Gemini**: `gemini-1.5`, `gemini-2.*`, `gemini-2.5.*`, `gemini-3.*` are capable.
- **Claude (via OpenAI-compatible endpoint)**: `claude-3`, `claude-3.5`, `claude-3.7`, and `claude-4` variants are capable.
- **Anthropic provider (direct API)**: Same Claude-3+ families. The project default still routes Anthropic agents through preprocess — override with `vision_mode='native'` only if you have extended the Anthropic path.
- **Codex**: Always treated as not capable. `auto` resolves to `preprocess`.
- **Unknown provider / model**: Conservatively treated as not capable.

## How it works

When preprocessing runs, the route handler calls `describeImages()` with the full list of attachments and the user's raw message text. Each image is described concurrently by an independent call to the vision model:

1. The vision model receives a system prompt (from `VISION_PROMPT`) that instructs it to produce a detailed, concise description.
2. The filename is prepended to the user turn if provided, so the agent knows what file the user sent.
3. The user's own question is threaded into the describer (see "Focusing descriptions" below).
4. The model replies with a text description, which is sliced to `VISION_MAX_DESCRIPTION_CHARS` to prevent context overflow.

The descriptions are then assembled into the bracketed block shown above and injected into the `message` string before `chatStream()` is called. The `chatStream()` call itself receives no attachments in this path — by the time it runs, the images have already been converted.

### The vision provider

The vision service reuses the existing OpenAI-compatible client (`getClient()` from `openai-client.ts`). This means VoidAI is the default backend for all preprocessing calls, even when the chat agent itself uses a different provider. You can override both the model and the conceptual provider label with `VISION_MODEL` and `VISION_PROVIDER`.

## `ImageAttachment` format

Attachments passed into the vision service use this structure:

```typescript
interface ImageAttachment {
  url:        string;   // Public URL or data: URI
  mime_type?: string;   // Optional; used for routing hints
  name?:      string;   // Optional filename, e.g. "screenshot.png"
}
```

`url` can be a public HTTPS URL or a `data:` URI. Both work with VoidAI and OpenAI vision endpoints. `name` is surfaced in the description output so the receiving agent knows which file the user attached.

## Focusing descriptions

The describer is not a generic captioner — it knows the user's question. When `describeImage()` is called with a `userPrompt`, it constructs a focused instruction:

> The user is asking: "what does column C contain?"
> Write a description optimized for answering that question. Transcribe any visible text verbatim where relevant.

Without a `userPrompt`, the instruction defaults to:

> Describe this image, transcribing any visible text verbatim.

This means attaching a spreadsheet screenshot and asking "what is the total in the last row?" produces a description that highlights the numbers rather than the visual layout. The first 600 characters of the user's question are used for focus.

## Failure handling

If the vision model call fails for any reason, the service returns a plain-text placeholder instead of throwing:

```
(failed to describe image "filename.png": <error message up to 120 chars>)
```

At the route level there is a second catch around the entire preprocessing block. If that outer block fails, the agent still receives:

```
[image attached but description failed: <error message>]

<original user message>
```

In both cases the agent sees that an image was present and can acknowledge it to the user. The chat turn is never aborted because of a vision failure.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `VISION_MODEL` | `gpt-4o` | Model used by the vision service to generate descriptions. Should be a vision-capable model. |
| `VISION_PROVIDER` | `voidai` | Label for the provider. Currently informational — all calls go through the shared OpenAI-compatible client regardless. |
| `VISION_PROMPT` | *(see below)* | System prompt sent to the vision model on every description call. Override to tune description style. |
| `VISION_MAX_DESCRIPTION_CHARS` | `2000` | Maximum character length of a single image description. Longer outputs are sliced at this boundary. |

Default `VISION_PROMPT`:

> Describe this image in detail, including text, objects, layout, and any notable visual elements. Be concise but complete — your description is the only context an LLM will see.

Set these in your `.env` file. Changes take effect immediately on the next chat turn — no restart required, because `config.ts` reads `process.env` on every access.
