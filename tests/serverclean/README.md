# serverclean tests

Dependency-free bash tests for `scripts/serverclean.sh`. No bats required.

## Run

```bash
bash tests/serverclean/run-tests.sh
```

Exit 0 and `FAIL=0` means green.

## What's covered

- `human` / `to_bytes` unit conversions (incl. docker `MB` and journalctl `M` units)
- `parse_args` flag handling and exit codes (`0` ok, `2` usage error)
- `run_step` skip paths — not-installed, needs-root — via the source seam
  (the script guards its `main` call, so tests `source` it and override
  `have`/`is_root`)
- `docker_reclaimable_bytes` parsing with `docker` stubbed (no daemon, no jq)
- registry wiring for every cleaner; apt/journal are root-gated
- end-to-end smoke: `--help` (0), bad flag (2), `--dry-run` mutates nothing,
  `--dry-run --quiet` is one line

## Manual acceptance (real execution)

`--dry-run` is always safe. A real run reclaims cache:

```bash
bash scripts/serverclean.sh            # execute
bash scripts/serverclean.sh -q         # cron-style one-line summary
```

Root is required for the apt + journal cleaners; without it they report
`skipped (needs root)` and the rest still run (exit 0).
