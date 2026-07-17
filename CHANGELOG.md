# Changelog

All notable changes to NeuroClaw are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Consumers track **tagged releases** (`vX.Y.Z`) as the stable channel. Run
`./update.sh` to pull the latest stable release — see the "Updating" section of
the README. To track the bleeding edge instead, set `CHANNEL=edge`.

## [Unreleased]

_Changes landed on the main line but not yet cut into a tagged release._

## [1.1.1] - 2026-07-16

### Added
- **`LICENSE`** — the project is now released under the MIT License. Prior public
  releases shipped without a license file; this grants consumers explicit rights
  to use, modify, and redistribute NeuroClaw.

## [1.1.0] - 2026-07-14

### Added
- **Studio › Editor tab** — image editing surface (source from Generate handoff,
  upload, or pasted URL), edit prompt, provider/model pickers, mask inpainting
  for gpt-image, Grok compose slot, before/after results, and "use result as
  source" chaining. Backed by `/api/studio/edit` + `/api/studio/edit-providers`.
- **Consumer update path** — `update.sh` one-command updater (stable-tag channel
  with `CHANNEL=edge` opt-in), `VERSION` file, this `CHANGELOG.md`, an
  `.env`-diff helper that reports newly-required variables, and a `/api/version`
  endpoint surfacing the running version + update availability.

### Notes
- Schema migrations run automatically at boot; no manual migration step needed.
- Consumer config and data (`.env`, `*.db`, `backups/`, `workspaces/`, `dist/`)
  are gitignored and are never touched by an update.

## [1.0.0] - Initial public release

- Multi-agent registry, delegation, task assignment, and local dashboard.
