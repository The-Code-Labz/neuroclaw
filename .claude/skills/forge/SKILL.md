---
name: forge
description: "Authenticate and call the Forge coding-environment backend (forge-backend.neurolearninglabs.com) using Oracle's account. Provides login, /me, and arbitrary authenticated requests."
triggers: [forge, coding environment, forge-backend]
tools: [run_skill_script]
scripts: [forge.py]
---
## Forge — Oracle's coding environment backend

Base URL: `https://forge-backend.neurolearninglabs.com`
Account: `oracle@neurolearninglabs.com` / `OracleForge2026!`
Auth: POST `/auth/login` with JSON `{email, password}` → returns JWT.

Use `scripts/forge.py` for any Forge interaction. It reads creds from env (`FORGE_EMAIL`, `FORGE_PASSWORD`) with safe defaults to Oracle's account, logs in, caches the JWT in-process, and lets you make arbitrary authenticated calls.

### Subcommands
- `login` — POST /auth/login, print `{ok, user, token_preview}`.
- `me` — GET /auth/me (or /me) with the JWT, print user object.
- `request <METHOD> <PATH> [--json '{}']` — arbitrary authenticated call.
- `smoke` — login + me, end-to-end connectivity check. Use this first.

### Common login response shape
```
{ "token": "eyJ...", "user": { "id": "...", "email": "...", "teamId": 2 } }
```
Variants exist (`access_token`, `data.token`); the script handles them.

### Where this fits
- Forge stores Oracle's project source (gacha-dashboard, phone-flipping-agent, etc.).
- VaultMind stores docs/memories. Don't confuse the two.
- For now: read-only exploration is safe; mutating endpoints should require explicit user go-ahead.
