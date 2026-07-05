# `nclaw doctor`

System health diagnostic. Runs a registered set of self-contained checks against
the local SQLite database, the file system, and `process.env`, then prints a
report. Read-only by default — pass `--fix` to apply automated remediations.

`doctor` is deliberately **standalone**: it does not import the dashboard, the
agent runtime, the Discord bot client, or the memory consolidator. It is safe
to run on a broken system, in a container without Discord network access, or
in CI.

## Usage

```bash
nclaw doctor                       # run all checks, terminal output
nclaw doctor --json                # machine-readable JSON on stdout
nclaw doctor --scope=discord       # only run checks tagged "discord"
nclaw doctor --fix                 # run all checks, attempt automated fixes
nclaw doctor --help                # list every registered check
```

Or, when running from source:

```bash
npm run doctor
npm run doctor:fix
```

### Exit codes

| code | meaning |
| ---- | ------- |
| `0`  | No `severity=fail` checks failed. Warnings and info-level issues are OK. |
| `1`  | At least one `severity=fail` check returned `ok=false`. |
| `2`  | Doctor itself crashed (uncaught error). |

### Flags

| flag | effect |
| ---- | ------ |
| `--scope=<scope>` | Restrict to one scope. Scopes today: `vault`, `discord`, `config`, `mcp`. |
| `--fix`           | After a check fails, if it carries an `automated` fix, run it and re-check. |
| `--json`          | Replace the terminal renderer with a JSON dump suitable for piping. |
| `-h`, `--help`    | Print usage + the registered check list. |

## Shipped checks

| id | scope | severity | what it checks | `--fix` action |
| -- | ----- | -------- | -------------- | -------------- |
| `vault.dist-fresh` | vault | fail | Each `src/memory/vault-*.ts` has a `dist/memory/vault-*.js` newer than it. | Runs `npm run build`. |
| `discord.placeholder-ids` | discord | fail | Every `discord_bots.application_id`, `discord_bots.bot_user_id`, `discord_channel_routes.channel_id`, and (if present) `alert_targets.channel_id` matches the Discord snowflake pattern `^\d{17,20}$`. | Manual — `doctor` prints the offending row IDs so you can fix or delete them. |
| `alert-dispatcher.targets` | config | fail | `ALERT_DISCORD_CHANNEL_ID` is a snowflake, `ALERT_DISCORD_BOT_ID` (if set) exists in `discord_bots` and is enabled, `GOTIFY_URL` and `GOTIFY_TOKEN` are both set or both unset, every `cron_jobs.on_complete_webhook_url` is a valid URL (and a valid Discord webhook when hosted on `discord.com`). | Manual — `doctor` lists each problem; fix env or the `cron_jobs` row. |
| `mcp.voidai-429-storm` | mcp | warn | Counts `hive_mind` rows in the last hour whose action / summary indicates a VoidAI 429 or rate-limit error. Flags when the count ≥ 5. | Manual — apply the containment procedure documented at `procedures/2026-05-07--dream-cycle--immediate-containment-for-voidai-429-rate-limiting.md`. |
| `forge.mount-paths` | config | info | When the Forge skill script is present in `.claude/skills/forge/`, `FORGE_EMAIL` and `FORGE_PASSWORD` are both set (or both unset). Also reports JWT cache and active-projects count. | Manual — set or unset both `FORGE_*` env vars together. |
| `kimi.context-budget` | config | warn | For each active agent whose `model` matches a small-context pattern (Kimi-K2, `*-mini`, `gpt-4o-mini`, etc.), the estimated system-prompt tokens (≈ chars/4) are below 60% of the known window. | Manual — reduce attached skills/tools and shorten the system prompt. When per-agent `tool_scope` lands, set it to `'core'`. |
| `mcp.build-stamps` | mcp | warn | The local stdio MCP server (`src/mcp/stdio-server.ts` → `dist/mcp/stdio-server.js`) is up to date, and every `mcp_servers` row whose URL points at a local file resolves to an existing artifact. | Runs `npm run build` when the only problem is staleness; otherwise prints the missing rows for manual cleanup. |

## Output

### Terminal

Each check renders as:

```
  ✓ ok    <id>  [<scope>]  <detail>
  ⚠ warn  <id>  [<scope>]  <detail>
        fix: <suggestion>
        $ <command>
  ✗ fail  <id>  [<scope>]  <detail>
        fix: <suggestion>
        $ (auto) <command>
        → fix applied OK
```

A summary line follows: `N passed, N warned, N failed  (total · elapsed)`.

ANSI colours are disabled when stdout is not a TTY or `NO_COLOR` is set.

### JSON

```json
{
  "startedAt": "2026-05-13T19:35:00.123Z",
  "durationMs": 28,
  "summary": { "total": 7, "passed": 7, "warned": 0, "failed": 0 },
  "results": [
    {
      "check": {
        "id": "vault.dist-fresh",
        "scope": "vault",
        "severity": "fail",
        "description": "Vault client dist artifacts are up to date with source"
      },
      "result": {
        "ok": true,
        "detail": "All vault dist artifacts current",
        "meta": { "stale": [], "missing": [] }
      }
    }
  ]
}
```

`fixApplied` (when `--fix` actually ran something) and `result.fix` (when a
check is failing) are included where relevant.

## Adding a new check

1. Create `src/doctor/checks/<your-id>.ts`. Keep it short — under 80 lines is
   the target.
2. Import `register` from `../registry` and call it at module top level:

   ```ts
   import { register } from '../registry';

   register({
     id: 'tools.composio-cache',
     scope: 'tools',
     severity: 'warn',
     description: 'Composio tool cache is non-empty',
     async run(ctx) {
       const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM composio_tool_cache').get();
       const n = (row as { n: number }).n;
       return {
         ok: n > 0,
         detail: `composio_tool_cache has ${n} row(s)`,
         fix: n > 0 ? undefined : {
           suggestion: 'Run a Composio sync to repopulate the cache',
           command: 'npm run composio:sync',
           automated: true,
         },
       };
     },
   });
   ```

3. Add the side-effect import to `src/doctor/checks/index.ts` so the check
   loads when `nclaw doctor` boots:

   ```ts
   import './composio-cache';
   ```

4. Update this docs table.

### Conventions

- Use a stable dotted id (`<scope>.<short-name>`). The id appears in CI output
  and in JSON consumers; treat it as a public API.
- Make the check resilient. If a table doesn't exist on this schema or an env
  var isn't set, **return `ok: true` with a note in `meta`** rather than
  throwing. Use the throw-isolation in the runner only as a last resort.
- Provide a `fix.suggestion` for every non-ok result.
- Set `automated: true` only when the `command` is safe to run unattended in
  `repoRoot` and finishes in well under 2 minutes.
- Prefer `severity: 'warn'` for transient runtime conditions (rate-limit
  storms, queue spikes) and `severity: 'fail'` for misconfiguration that
  should block CI.
- `info` is for advisory checks that should never fail CI (e.g. "Forge is
  configured" — not a problem either way).

## Programmatic API

```ts
import { runDoctor, listChecks, register, type DoctorReport } from 'neuroclaw-v1/dist/doctor';
import { getDb } from 'neuroclaw-v1/dist/db';

const report: DoctorReport = await runDoctor({
  ctx: { db: getDb(), env: process.env, repoRoot: process.cwd(), applyFixes: false },
  emit: false, // suppress stdout — receive the report object directly
});
```

This is what Sentinel will use once it gains a scheduled doctor sweep
(out of scope for this PR; see `docs/reports/2026-05-13--oracle-openclaw-absorb-report.md`).
