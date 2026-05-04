---
title: Quickstart
order: 10
---

# Quickstart

NeuroClaw is a TypeScript multi-agent orchestrator with a CLI and a dashboard.

## Install

```bash
git clone <repo>
cd neuroclaw-v1
npm install
cp .env.example .env
```

Fill in at minimum:
- `VOIDAI_API_KEY` — your VoidAI key (or any OpenAI-compatible endpoint).
- `DASHBOARD_TOKEN` — picks any string; protects the dashboard.

## Run

```bash
npm run dashboard   # http://localhost:3141/dashboard?token=<your token>
npm run dev         # CLI chat loop
```

## Next steps

- Open the dashboard and try chatting in the **Chat** tab — Alfred (the orchestrator) replies by default.
- Visit **Agents** to see the seeded agents (Alfred, Researcher, Coder, Planner) and create your own.
- Read **Architecture overview** for how the orchestration works under the hood.
