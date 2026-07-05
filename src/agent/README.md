# Agent Module

Multi-provider agent orchestration and chat handling.

## Overview

This module contains the core agent orchestration logic:
- **Alfred** — The main orchestrator agent that routes requests and coordinates other agents
- **OpenAI client** — Chat completions via VoidAI or any OpenAI-compatible endpoint
- **Anthropic client** — Direct Anthropic API integration

## Key Files

| File | Purpose |
|------|---------|
| `alfred.ts` | Main orchestration logic, chat loop, tool dispatch |
| `openai-client.ts` | OpenAI-compatible API client with tool support |
| `anthropic-client.ts` | Anthropic SDK client |

## Flow

```
User message
    │
    ▼
┌──────────────────┐
│     Alfred       │ ◄── System prompt + memory context
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│ Provider Client  │────►│   Tool Registry  │
│ (OpenAI/Claude)  │◄────│   (dispatches)   │
└────────┬─────────┘     └──────────────────┘
         │
         ▼
    Response to user
```

## Usage

```typescript
import { chat } from './alfred';

const response = await chat({
  agentId: 'alfred',
  sessionId: 'session-123',
  message: 'Hello, what can you do?',
  onChunk: (text) => process.stdout.write(text),
});
```

## Configuration

Environment variables:
- `VOIDAI_API_KEY` — API key for VoidAI/OpenAI endpoint
- `VOIDAI_BASE_URL` — Override base URL (default: VoidAI)
- `VOIDAI_MODEL` — Default model for chat completions
- `ANTHROPIC_API_KEY` — For direct Anthropic integration
