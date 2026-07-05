# OpenClaw → NeuroClaw — Absorption Report
**Author:** Oracle
**Date:** 2026-05-13
**Source repo:** https://github.com/openclaw/openclaw.git (`2026.5.12-beta.1`)
**Philosophy:** *Absorb what is useful, discard what is useless, add what is uniquely your own.*

---

## 1. What I'm looking at

OpenClaw is a *single-user, local-first* AI assistant. It's huge — pnpm monorepo, ~85 extensions, ~50 channels, ~30 model providers, Swift/Kotlin companion apps. It is **not** an agent-team orchestrator like us. It is a **gateway** that connects one user across many channels (Discord, WhatsApp, Slack, iMessage…) and lets a single assistant act through them.

NeuroClaw, by contrast, is a **multi-agent registry + orchestration system** — Alfred routes to Jarvis/Oracle/Felicity/etc., each with persistent NeuroVault memory, task management, Discord routing, and skill packs.

**Different shape, but they overlap on:** tool registry, plugin/skill loading, memory hosting, channel adapters, security policy, doctor/diagnostics, lazy tool loading, config contracts.

So this report is **not** "rebuild like OpenClaw." It's **lift specific patterns** that solve real problems we already have on file (context overflow, alert-dispatcher failures, plugin chaos, security guardrails, plugin validation).

---

## 2. What's worth absorbing — ranked by impact

### 🟢 ABSORB (high-value, low-risk integration)

#### 2.1 `doctor` subsystem — formalised health checks
OpenClaw has a first-class `doctor` command/subsystem (`src/flows/doctor-health.ts`, `src/gateway/server-methods/doctor.ts`, `src/commands/doctor-ui.ts`). It runs structured health probes (auth, channels, plugins, memory, config) and outputs **actionable repair suggestions**, not just status flags.

**Why we want it:** We already have `src/diagnostics/` (claude-check, memory-check), but they're one-off scripts. We have *recurring* incidents (alert-dispatcher snowflake placeholder, search_vault dist not rebuilt, Forge mount path, post-restart chat errors) where a single `nclaw doctor` would have caught it in seconds.

**Discard:** their plugin-doctor sub-machinery — we don't have a plugin ecosystem at that scale.

#### 2.2 Plugin/Skill **compat contract** (`@openclaw/plugin-package-contract`)
A 200-line typed contract validating `openclaw.compat.pluginApi` + `openclaw.build.openclawVersion` in every plugin's `package.json`. Returns structured `{fieldPath, message}[]` issues.

**Why we want it:** Our skills (`skills/`, `lina-templates/`, `pydantic-agents/`) have no version contract. When a skill or pydantic agent gets out of sync with NeuroClaw core, the failure is silent (Tim's `search_vault` recompile incident is the canonical example).

**Discard:** their ClawHub publish-gating pipeline — we're not running a public marketplace.

#### 2.3 Lazy tool loading — but at the **dispatcher** layer
OpenClaw's gateway never ships its full tool surface to every model — it filters by `agent-scope-config`, `agent-runtime-metadata`, `provider-tools`. The model only ever sees what it can actually use.

**Why we want it:** We already started this in `src/tools/manifest.ts` (good — manifest mode). OpenClaw's pattern goes further: **per-agent scope** + **per-provider filtering**. That solves the kimi-k2.6 context overflow more thoroughly than manifest mode alone.

**Discard:** their entire `plugin-sdk` (700+ subpath exports). That's enterprise-level over-engineering for our footprint.

#### 2.4 Channel runtime separation (`channel-runtime`, `channel-contract`, `channel-ingress`)
Their channels (Discord, Telegram, Slack…) are *strictly* contracts: inbound envelope → ingress → policy → reply pipeline. Each layer is small and replaceable.

**Why we want it:** Our `src/integrations/discord-bot.ts` is a single 1k+ file mixing intake, routing, voice, alert-dispatcher, reactions. Splitting along the OpenClaw seam lines fixes the recurring alert-dispatcher snowflake/Composio fallback failures because invalid targets are caught at the **contract** layer, not at send time.

**Discard:** their 50 channels. We need Discord well — not WhatsApp + iMessage + Tlon + Nostr + Zalo.

#### 2.5 **Trust model document** + report acceptance gate (SECURITY.md §"Detailed Report Acceptance Gate")
Their `SECURITY.md` defines explicit trust boundaries and *what is not a security bug*. This is rare and excellent.

**Why we want it:** Nightwing's role is "Operational Security Director" but we've never written down the boundary model — what's a real vuln vs. an operator-intended feature (e.g. `bash_run`). Without it, every external "AI scanner finding" becomes noise we can't triage.

**Discard:** the maintainer GHSA process, public disclosure flow — not relevant at our team size.

#### 2.6 `skills/<name>/SKILL.md` frontmatter convention with `metadata.requires.config[]`
Their skill spec is tighter than ours: explicit `allowed-tools`, `metadata.openclaw.requires.config`, runs through one universal `message` tool rather than per-channel tools.

**Why we want it:** Our skill loader already supports SKILL.md (good), but we don't gate on `requires.config[]`. That gating is what would have prevented the "discord_send invalid channel_id" alert spam — the skill would have refused to load with placeholder config.

#### 2.7 Build manifests / `build-info` / `cli-startup-metadata`
They write `build-info.json`, `cli-startup-metadata.json`, and a `build-stamp` at build time so the running binary always knows its own version + build SHA + dependency set.

**Why we want it:** When users hit weird bugs (post-restart chat errors), the first question is "what version is running?" — and right now we *can't* answer that fast. A 30-line `build-stamp.ts` solves it forever.

---

### 🟡 PARTIAL ABSORB (extract the idea, not the code)

#### 2.8 `commitments` subsystem
OpenClaw tracks *what the assistant has promised the user* across sessions and reminds when commitments come due. Conceptually beautiful, but it lives in 7+ files and is wired into their context-engine.

**What to take:** the **idea** of a `commitments` table — tasks the assistant volunteered to do, separate from user-assigned tasks. We already have `manage_task`; add a `task.origin = 'self_committed'` flag and a daily Sentinel sweep that asks "is this still relevant?"

#### 2.9 `auto-reply` policy layer
Their inbound message → reply pipeline gates on `direct-dm-guard-policy`, `command-gating`, `command-auth`, `channel-mention-gating`. Per-channel + per-sender authorization.

**What to take:** Right now any Discord user who can see a bot can address it. Lift the `direct-dm-guard-policy` concept into our Discord routing: by default DM = closed, opt-in per-guild/per-user.

#### 2.10 `context-engine` (separate from agent prompts)
OpenClaw separates *prompt assembly* from *context selection*. Their `context-engine/registry.ts` holds context "contributors" (recent messages, session memory, attached files) and each provider/model gets a tailored view.

**What to take:** We hand-roll context inside each agent's prompt pipeline. Promoting this to a registry would let Alfred control context budget centrally (relevant directly to our context-overflow incidents).

---

### 🔴 DISCARD (do **not** copy)

- **Their entire pnpm monorepo split (`packages/plugin-sdk/*` with 700+ subpath exports).** That's the cost of being a public plugin platform. We're not.
- **The 50-channel matrix.** Discord + Slack + Telegram is plenty. Don't get sucked into WhatsApp/iMessage/Nostr.
- **`crabbox`/`testbox` remote test orchestration.** Way over-engineered for our team.
- **OXC tooling (`oxlint`, `oxfmt`, `tsgo`).** Their TS toolchain is bleeding-edge and unstable. Stay on tsx + tsc.
- **Their Swift/Kotlin companion apps.** Different problem space entirely.
- **All 85 extension packages.** Pick the 3 that match a real need (groq, deepseek, lobster) and adapt; ignore the rest.

---

### 🟣 ADD WHAT IS UNIQUELY OURS

These are NeuroClaw-specific moves OpenClaw doesn't make and shouldn't influence:

- **Multi-agent personas with distinct memory namespaces** (Oracle/Jarvis/Felicity/…). OpenClaw has one assistant; we have a roster.
- **NeuroVault as a first-class memory MCP** with the four-type taxonomy (episodic/semantic/procedural/preference). Their memory layer is single-table; ours is psychologically modeled.
- **Sub-agent spawning with cascade depth + budget** (`spawn_agent`, `run_subtask`). They don't have ephemeral specialists.
- **Dream-cycle / memory-consolidator** (`src/memory/dream-cycle.ts`). Unique to us. Keep evolving.
- **Task-driven coordination** (Archon-style kanban across the agent team). They have commitments-for-one-user; we have tasks-across-many-agents.

---

## 3. Recommended implementation — what to actually build

Five concrete changes, ordered by ROI:

### Change 1 — `nclaw doctor` command
**Cost:** ~1 day. **Risk:** very low. **ROI:** stops 60% of recurring incidents at the door.

### Change 2 — Skill compat contract (`@neuroclaw/skill-contract` mini-package)
**Cost:** ~½ day. **Risk:** low (additive only). **ROI:** kills the "dist not rebuilt" / "schema drifted" class of bugs.

### Change 3 — Per-agent tool scope (extend `manifest.ts`)
**Cost:** ~1 day. **Risk:** low (already partially built). **ROI:** ends context overflow on small-window models permanently.

### Change 4 — Trust model + boundary doc (`docs/security/TRUST_MODEL.md`)
**Cost:** ~½ day. **Risk:** zero — it's docs. **ROI:** Nightwing gets a real reference. External "findings" get triaged in minutes.

### Change 5 — Channel contract split for Discord (refactor `discord-bot.ts`)
**Cost:** ~2–3 days. **Risk:** medium (touches running prod). **ROI:** alert-dispatcher / snowflake / voice toggle bugs stop happening because invalid state is rejected at contract layer.

Total: **~5–6 engineer-days** for all five.

---

## 4. Road map

### Sprint 1 — Foundation (this week)
- **Day 1** — Trust model doc (Change 4)
- **Day 2** — `nclaw doctor` skeleton + first 3 checks: auth, vault, discord (Change 1)
- **Day 3** — Skill contract package + wire into skill-loader (Change 2)

### Sprint 2 — Tool surface (next week)
- **Day 4** — Per-agent tool scope: extend `src/tools/manifest.ts` with `agent_scope` config + provider filter (Change 3)
- **Day 5** — Build-info / build-stamp emission on every `npm run build`
- **Day 6** — Doctor checks for: alert-dispatcher targets, kimi context budget, Forge mount paths

### Sprint 3 — Channels (week 3)
- **Day 7–9** — Discord refactor along OpenClaw seam lines: `discord-ingress.ts` → `discord-policy.ts` → `discord-reply-pipeline.ts` (Change 5)
- **Day 10** — Migrate alert-dispatcher to flow through the new pipeline; deprecate placeholder snowflakes at config-load time

### Sprint 4 — Refinement (week 4)
- Optional: `context-engine` registry promotion (item 2.10)
- Optional: commitments flag on tasks (item 2.8)
- Run doctor in scheduled job every 15min; route findings to Sentinel

---

## 5. How to implement each change

### Change 1 — `nclaw doctor`

```bash
# scaffold
mkdir -p src/doctor
touch src/doctor/index.ts src/doctor/checks.ts src/doctor/registry.ts
```

**`src/doctor/registry.ts`** — minimal pattern:
```ts
export type DoctorCheck = {
  id: string;                // "vault.dist-fresh"
  scope: 'auth'|'vault'|'discord'|'tools'|'memory'|'config';
  severity: 'info'|'warn'|'fail';
  run: (ctx: DoctorCtx) => Promise<DoctorResult>;
};

export type DoctorResult = {
  ok: boolean;
  detail: string;
  fix?: { suggestion: string; command?: string };  // <— the OpenClaw trick
};

const checks: DoctorCheck[] = [];
export function register(c: DoctorCheck) { checks.push(c); }
export function all() { return [...checks]; }
```

**First 3 checks** (`src/doctor/checks.ts`):
1. **vault.dist-fresh** — compare `dist/memory/vault-client.js` mtime vs `src/memory/vault-client.ts` mtime; fix = `"npm run build"`.
2. **discord.placeholders** — scan `discord_bots` rows for `channel_id LIKE 'your_%'`; fix = `"DELETE FROM discord_bots WHERE … or supply real snowflake"`.
3. **agent.context-budget** — for every agent with `model LIKE 'kimi%' OR model LIKE '%-mini'`, estimate prompt size ≥ 60k tokens → warn; fix = `"set tool_scope: core in agent config"`.

**CLI entry** (`src/cli-code.ts` add a subcommand):
```ts
if (argv[2] === 'doctor') {
  const { runDoctor } = await import('./doctor');
  await runDoctor({ scope: argv[3], fix: argv.includes('--fix') });
  process.exit(0);
}
```

### Change 2 — Skill compat contract

```bash
mkdir -p src/skills/contract
touch src/skills/contract/index.ts src/skills/contract/index.test.ts
```

Copy the *shape* of OpenClaw's `plugin-package-contract` but tailor fields:
```ts
export const REQUIRED_SKILL_FIELDS = [
  'neuroclaw.compat.coreVersion',  // semver range
  'neuroclaw.entrypoint',          // SKILL.md or scripts/<file>
] as const;

export function validateSkill(frontmatter: unknown): { issues: Issue[] }
```

Wire into `src/skills/skill-loader.ts` — refuse to register a skill whose `issues.length > 0`, log a structured warning instead of crashing.

### Change 3 — Per-agent tool scope

`src/tools/manifest.ts` already has `DEFAULT_CORE_TOOLS`. Extend:
```ts
// new: agent_scope on agent row
type AgentScope = 'core' | 'core+discord' | 'full' | string[];

export function visibleToolsForAgent(agent: AgentRecord): ToolDef[] {
  const scope = agent.tool_scope ?? 'full';
  if (scope === 'core') return allTools().filter(t => CORE.includes(t.name));
  if (Array.isArray(scope)) return allTools().filter(t => scope.includes(t.name));
  // 'full' = current behaviour
  return allTools();
}
```

DB migration: `ALTER TABLE agents ADD COLUMN tool_scope TEXT`.
Update `src/agent/*-client.ts` to call `visibleToolsForAgent` instead of `visibleTools`.

### Change 4 — Trust model doc

Create `docs/security/TRUST_MODEL.md` modeled on OpenClaw §"Operator Trust Model" but for *us*:
- **Trusted operator** = user with dashboard access
- **Trusted agent** = registered in `agents` table with non-null `vault_path`
- **Untrusted input** = inbound Discord message text, webhook bodies, scraped HTML
- **Out of scope:** prompt injection that doesn't bypass tool gating; `bash_run` doing what bash_run is designed to do; an installed skill executing privileged actions
- **In scope:** auth bypass on dashboard API; vault-key disclosure; cross-agent memory leak; unauthenticated tool dispatch

Have Nightwing review + sign off.

### Change 5 — Discord channel contract split

Refactor `src/integrations/discord-bot.ts` (currently monolithic):

```
src/integrations/discord/
├── ingress.ts        ← raw event → InboundEnvelope (validated)
├── policy.ts         ← guild allowlist, DM guard, mention gating
├── routing.ts        ← envelope → which agent owns this
├── reply-pipeline.ts ← agent response → discord send (chunking, components, retries)
├── voice.ts          ← unchanged for now
└── index.ts          ← wires the four together
```

Migration plan:
1. Build the new files alongside the old `discord-bot.ts`.
2. Feature-flag via `DISCORD_PIPELINE=v2`.
3. Run both for 24h on a single test guild; compare logs.
4. Cut over; archive `discord-bot.ts` to `backups/`.

Critical: at the **ingress** boundary, reject any message destined for a `channel_id` that doesn't match the snowflake regex `/^\d{17,20}$/`. That single check kills the recurring alert-dispatcher warning storm.

---

## 6. What not to do

- **Don't fork OpenClaw.** Their codebase assumes pnpm workspace + 12 build steps + Mintlify docs. Lift patterns, not files.
- **Don't add a ClawHub-style marketplace.** Internal skills are fine; public discovery is scope creep.
- **Don't try to support all 50 channels.** Each one is a 2-week maintenance liability for one user.
- **Don't replace our memory layer with `memory-host-sdk`.** NeuroVault's four-type model is better matched to multi-agent persistence than their single-engine model.

---

## 7. Bruce Lee scorecard

| Their thing | Verdict | Why |
|---|---|---|
| `doctor` health system | ✅ Absorb | Solves recurring incidents |
| Plugin compat contract | ✅ Absorb (slim) | Prevents silent skill breakage |
| Per-agent tool scope | ✅ Absorb (we started it) | Fixes context overflow |
| Channel contract layers | ✅ Absorb (Discord only) | Fixes alert-dispatcher class |
| SECURITY trust model | ✅ Absorb (slim) | Nightwing needs this |
| Skill frontmatter `requires.config` | ✅ Absorb | Catches placeholder configs |
| Build-stamp / version metadata | ✅ Absorb | Trivial, huge debugging win |
| Commitments tracking | 🟡 Adapt | Add as task flag |
| Auto-reply policy gates | 🟡 Adapt | Lift DM-guard concept only |
| Context-engine registry | 🟡 Adapt | Useful later |
| 700-entry plugin-sdk | ❌ Discard | Over-engineered for us |
| 50-channel matrix | ❌ Discard | Maintenance burden |
| Crabbox/Testbox | ❌ Discard | Overkill |
| OXC toolchain | ❌ Discard | Bleeding edge, unstable |
| Companion mobile apps | ❌ Discard | Wrong problem space |
| ClawHub marketplace | ❌ Discard | Scope creep |
| Multi-agent personas | 🟣 Keep ours | They don't have it |
| NeuroVault 4-type memory | 🟣 Keep ours | Better fit |
| Sub-agent spawn + budget | 🟣 Keep ours | Unique strength |
| Dream-cycle / consolidator | 🟣 Keep ours | Unique strength |
| Task-driven team coordination | 🟣 Keep ours | Multi-agent specific |

---

## 8. Closing

OpenClaw is what you get when you build a really good *single-user* assistant for *fifty channels*.
NeuroClaw is what we're building: a *multi-agent team* with persistent memory and shared task state.

Different shapes. But they've already solved — cleanly — three problems we keep hitting: **diagnostics, plugin contracts, channel boundary chaos**. Take those. Leave the rest.

Five changes. Six engineer-days. Each one closes a class of incident we've actually had in the last two weeks.

— Oracle
