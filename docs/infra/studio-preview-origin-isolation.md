# Studio B1 — Preview origin isolation (Traefik + Hono)

Status: **PR-ready**. Part of the Studio "Web App Viewer" security blocker
(B1 — origin isolation for WebContainers). Scope owned here: Traefik routing
and edge headers, plus the matching Hono-layer contract. The Studio
preview/API application code itself is a separate workstream.

## 1. Objective

Untrusted Jarvis-built app previews must render on a genuinely separate
origin from the authenticated dashboard, so that:

- the preview can never read or forward the dashboard's session cookie
  (no ambient/ shared cookie scope),
- the preview gets the cross-origin isolation it needs (`SharedArrayBuffer`,
  worker-based file systems) via `COOP: same-origin` + `COEP: credentialless`,
- those isolation headers apply **only** to the preview origin — not the
  dashboard, not the Studio API.

## 2. Origin topology (per Angelina's canonical design)

| Origin | Purpose | Trust | Headers |
|---|---|---|---|
| `app.<domain>` | Dashboard | Trusted | Untouched by this PR |
| `studio-api.<domain>` | Studio backend API | Trusted | Standard hardening headers, no COOP/COEP |
| `run-<sessionId>.preview.<domain>` | WebContainer preview iframe | **Untrusted** | `COOP: same-origin` + `COEP: credentialless` |

There is one backend service behind the wildcard, not one container per
session — the session ID lives in the hostname purely to give each preview
its own origin (so cookies/localStorage/`postMessage` can't leak between two
users' previews, or between a preview and the dashboard). See
`.claude/skills/studio-origin-topology-and-security/SKILL.md` for the
original topology note this implements.

## 3. Files in this PR

```
infra/traefik/
  dynamic/
    studio-preview.yml.template   # untrusted origin: router + COOP/COEP middleware
    studio-api.yml.template       # trusted origin: router + standard hardening headers
  render-dynamic-config.sh        # envsubst renderer, run at deploy time
  docker-compose.studio.yml       # reference network/volume wiring (not a full stack)
src/dashboard/
  studio-preview-security.ts      # Hono middleware: header + cookie/bearer contract
```

## 4. Routing explanation

- **Preview origin**: one Traefik router (`studio-preview-wildcard`) matches
  `HostRegexp(`^[a-z0-9-]+\.preview\.${STUDIO_DOMAIN}$`)` and forwards to a
  single `studio-preview-service`. `priority: 10` keeps it below any exact
  `Host()` router.
- **Studio API origin**: `Host(`studio-api.${STUDIO_DOMAIN}`)`, `priority: 100`,
  standard headers only.
- **Traefik v3 gotcha** (hit previously on the Forge IDE host): `HostRegexp`
  no longer accepts the v2 `{name:pattern}` template syntax. It now expects
  raw, anchored Go regexp with escaped dots. A v2-style rule doesn't error —
  it silently 404s every request. Both templates here use the v3 form.
  Verify with `docker exec <traefik-container> traefik version` if a route
  ever stops matching after an upgrade.
- Routing is defined via the **file provider**, not Docker labels. One
  backend serves every preview hostname, so there's nothing per-container to
  auto-discover, and a file-provider diff is easier to review for a security
  change than labels buried in a compose file.

## 5. Environment variable requirements

Set before running `render-dynamic-config.sh`:

| Variable | Meaning |
|---|---|
| `STUDIO_DOMAIN` | Apex domain, e.g. `neuroclaw.example.com` |
| `TRAEFIK_CERT_RESOLVER` | ACME resolver name in the static `traefik.yml`; must support DNS-01 (wildcard cert — Rei's side) |
| `STUDIO_PREVIEW_UPSTREAM` | Internal URL of the Studio preview service, e.g. `http://studio-preview:3400` |
| `STUDIO_API_UPSTREAM` | Internal URL of the Studio API service, e.g. `http://studio-api:3401` |

## 6. Secrets

None introduced by this PR. The Studio API session token (see §7) is
generated per-session by the application layer (`generatePreviewSessionToken()`
in `studio-preview-security.ts`) and is not a static secret — it should be
stored wherever session state already lives, not in an env var or the repo.

## 7. Cookie / auth strategy (Hono layer)

- `setStudioApiCookie()` sets `studio-api-session` as **host-only**
  (no `Domain` attribute — mirrors the existing `dashboard-token` pattern in
  `src/dashboard/server.ts`), `HttpOnly`, `SameSite=Strict`, `Secure` when
  behind TLS.
- Because it's `SameSite=Strict`, the browser correctly never sends it on
  the cross-site request the preview iframe makes to `studio-api.<domain>` —
  that isn't a bug to route around, it's exactly why the preview must
  instead carry a **bearer token** (`Authorization: Bearer <token>`, minted
  once per session) for its own calls to the Studio API.
- `requireStudioApiAuth()` accepts either the cookie (same-origin caller) or
  the bearer token (preview iframe), and validates neither against
  `dashboard-token` — the Studio API never trusts apex/dashboard auth.

## 8. Deployment flow

1. Rei finishes wildcard DNS (`*.preview.<domain>`) + DNS-01 wildcard cert.
2. Set the four env vars above wherever Traefik's stack is deployed.
3. `bash infra/traefik/render-dynamic-config.sh <traefik-dynamic-dir>` — renders
   the two `.template` files into real `.yml`, which Traefik's file provider
   (`watch: true`) picks up automatically. Re-run on every deploy; idempotent.
4. Mount `studio-preview` / `studio-api` onto the same Docker network Traefik
   watches (see `docker-compose.studio.yml`); `traefik.enable=false` on both —
   they're routed by the file provider, not label discovery.
5. Mount the rendered dynamic-config directory into the Traefik container at
   the path its static config's `providers.file.directory` points to.

## 9. Validation / testing

- `curl -s https://<traefik-host>:8080/api/http/routers | jq '.[] | select(.name | test("studio"))'`
  — confirms both routers loaded and which rule they resolved to.
- `curl -sI https://run-test123.preview.<domain>/` — confirm
  `cross-origin-opener-policy: same-origin` and
  `cross-origin-embedder-policy: credentialless` are present.
- `curl -sI https://studio-api.<domain>/` — confirm **absence** of COOP/COEP,
  presence of `strict-transport-security`.
- Browser check: open a preview, open devtools → Application → Cookies.
  Confirm no `dashboard-token` (or any `app.<domain>` cookie) is visible on
  the preview origin, and that `document.crossOriginIsolated === true` inside
  the preview iframe.
- Confirm a request from the preview origin to `studio-api.<domain>` without
  an `Authorization` header is rejected (401) — proves the cookie genuinely
  isn't riding along.

## 10. Rollback guidance

Routing and headers live entirely in the two `.yml` files rendered from the
templates in this PR. Rollback is: stop rendering (or restore the previous
rendered `.yml`), Traefik's file-provider watch picks up the reversion within
its poll interval — no container restart required. The Hono middleware
module is inert until a Studio preview/API app imports it, so merging this
PR alone changes nothing at runtime for any existing service.

## 11. Security considerations

- COOP/COEP are scoped to the preview router only — verified in §9.
- No `Domain=` attribute on the Studio API cookie — it cannot be read or
  sent from any other origin, including the preview's.
- `X-Frame-Options: DENY` + `Referrer-Policy: no-referrer` + `X-Robots-Tag`
  on the preview origin as defense in depth against embedding/leakage beyond
  the intended single iframe use.
- Belt-and-suspenders header stripping (`Authorization`/`Cookie` on inbound
  requests to the preview router) guards against a future bug in the
  dashboard's iframe-embed code accidentally forwarding either.
- The wildcard cert must be DNS-01 issued (Rei's side) — an HTTP-01 challenge
  cannot cover `*.preview.<domain>`.
- Do not add `traefik.enable=true` discovery labels to `studio-preview` /
  `studio-api` alongside the file-provider routers — that risks two routers
  matching the same host with different middleware stacks, which is exactly
  the kind of drift this design avoids.

## 12. Maintenance notes

- If the preview service ever needs per-session routing beyond the hostname
  (e.g. sticky sessions across replicas), that's a `loadBalancer` change in
  `studio-preview.yml.template` — the router/rule stays the same.
- If Traefik is ever upgraded past v3, re-check the `HostRegexp` syntax note
  in §4 before assuming a 404 is a DNS/upstream problem.
- Keep this file and `.claude/skills/studio-origin-topology-and-security/SKILL.md`
  in sync — that skill doc is the topology source of truth; this doc is its
  deployment realization.
