#!/usr/bin/env bash
# Renders the Studio preview/API Traefik dynamic-config templates into the
# directory Traefik's file provider watches, substituting environment
# variables. Idempotent — safe to re-run on every deploy.
#
# Required environment variables:
#   STUDIO_DOMAIN            e.g. "neuroclaw.example.com"  (apex the wildcard
#                             hangs off — preview host becomes
#                             *.preview.$STUDIO_DOMAIN)
#   TRAEFIK_CERT_RESOLVER    name of the ACME cert resolver configured in the
#                             static traefik.yml (must support DNS-01 for the
#                             wildcard cert — Rei is provisioning this)
#   STUDIO_PREVIEW_UPSTREAM  internal URL of the Studio preview service,
#                             e.g. "http://studio-preview:3400"
#   STUDIO_API_UPSTREAM      internal URL of the Studio API service,
#                             e.g. "http://studio-api:3401"
#
# Usage:
#   STUDIO_DOMAIN=neuroclaw.example.com \
#   TRAEFIK_CERT_RESOLVER=cloudflare \
#   STUDIO_PREVIEW_UPSTREAM=http://studio-preview:3400 \
#   STUDIO_API_UPSTREAM=http://studio-api:3401 \
#     bash infra/traefik/render-dynamic-config.sh /path/to/traefik/dynamic

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SCRIPT_DIR/dynamic}"

REQUIRED_VARS=(STUDIO_DOMAIN TRAEFIK_CERT_RESOLVER STUDIO_PREVIEW_UPSTREAM STUDIO_API_UPSTREAM)
missing=()
for v in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    missing+=("$v")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "✗ Missing required environment variables: ${missing[*]}" >&2
  echo "  See the header of this script for what each one means." >&2
  exit 1
fi

if ! command -v envsubst >/dev/null 2>&1; then
  echo "✗ envsubst not found (part of gettext-base). Install it before rendering." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

for tmpl in "$SCRIPT_DIR"/dynamic/*.yml.template; do
  out="$OUT_DIR/$(basename "${tmpl%.template}")"
  # Only substitute the four variables we expect — envsubst with an explicit
  # variable list so a stray "${SOMETHING_ELSE}" in either template (e.g. a
  # Traefik/Go-template-looking string we didn't intend to touch) is left
  # alone rather than silently blanked out.
  envsubst '${STUDIO_DOMAIN} ${TRAEFIK_CERT_RESOLVER} ${STUDIO_PREVIEW_UPSTREAM} ${STUDIO_API_UPSTREAM}' \
    < "$tmpl" > "$out.tmp"
  mv "$out.tmp" "$out"
  echo "✓ rendered $(basename "$tmpl") → $out"
done

echo
echo "Traefik's file provider (watch: true) will pick these up automatically."
echo "Verify with: curl -s https://<traefik-host>:8080/api/http/routers | jq '.[] | select(.name | test(\"studio\"))'"
