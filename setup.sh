#!/usr/bin/env bash
# NeuroClaw one-shot setup script
# Run this from the repository root: ./setup.sh

set -euo pipefail

# ------------------------------------------------------------------------------
# Colors and logging helpers
# ------------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

step() {
  printf '\n%s==>%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$*" "$RESET"
}

info() {
  printf '%s[INFO]%s %s\n' "$GREEN" "$RESET" "$*"
}

warn() {
  printf '%s[WARN]%s %s\n' "$YELLOW" "$RESET" "$*" >&2
}

error() {
  printf '%s[ERROR]%s %s\n' "$RED" "$RESET" "$*" >&2
}

success() {
  printf '%s[SUCCESS]%s %s\n' "$GREEN" "$RESET" "$*"
}

# ------------------------------------------------------------------------------
# .env helpers (POSIX awk, works on GNU and BSD/macOS)
# ------------------------------------------------------------------------------
env_get() {
  local key="${1:-}" file="${2:-.env}"
  awk -v key="$key" '
    match($0, "^[[:space:]]*" key "[[:space:]]*=") {
      val = substr($0, RSTART + RLENGTH)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
    }
    END { print val }
  ' "$file"
}

env_set() {
  local key="${1:-}" value="${2:-}" file="${3:-.env}"
  local tmpfile="${file}.tmp.$$"

  awk -v key="$key" -v val="$value" '
    BEGIN { found = 0 }
    /^[[:space:]]*$/ { print; next }
    match($0, "^[[:space:]]*" key "[[:space:]]*=") {
      print key "=" val
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" val }
  ' "$file" > "$tmpfile"

  mv "$tmpfile" "$file"
}

# ------------------------------------------------------------------------------
# Secure token generation
# ------------------------------------------------------------------------------
generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi

  if command -v xxd >/dev/null 2>&1; then
    head -c 32 /dev/urandom | xxd -p | tr -d '\n'
    return 0
  fi

  if command -v od >/dev/null 2>&1; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
    return 0
  fi

  error "No secure random generator found. Please install openssl, xxd, or od."
  exit 1
}

# ------------------------------------------------------------------------------
# Main setup
# ------------------------------------------------------------------------------
step "Validating environment"

if [ ! -f package.json ]; then
  error "package.json not found. Please run this script from the NeuroClaw repository root."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  error "Node.js is not installed. NeuroClaw requires Node.js >= v20."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  error "npm is not installed. It is bundled with Node.js."
  exit 1
fi

NODE_VERSION=$(node -v)
NODE_MAJOR=${NODE_VERSION#v}
NODE_MAJOR=${NODE_MAJOR%%.*}

if [ "$NODE_MAJOR" -lt 20 ]; then
  error "Node.js ${NODE_VERSION} is installed, but NeuroClaw requires Node.js >= v20."
  exit 1
fi

info "Node.js ${NODE_VERSION}"
info "npm v$(npm -v)"

step "Installing Node dependencies"

if ! npm install; then
  error "npm install failed. Check the output above and try again."
  exit 1
fi

step "Configuring environment"

ENV_MODIFIED=0

if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    error ".env.example is missing. Cannot create .env automatically."
    exit 1
  fi

  cp .env.example .env
  ENV_MODIFIED=1
  info "Created .env from .env.example."
fi

CURRENT_TOKEN=$(env_get DASHBOARD_TOKEN .env)

if [ -z "$CURRENT_TOKEN" ] || [ "$CURRENT_TOKEN" = "change-me" ]; then
  NEW_TOKEN=$(generate_token)
  env_set DASHBOARD_TOKEN "$NEW_TOKEN" .env
  ENV_MODIFIED=1
  info "Generated a secure DASHBOARD_TOKEN in .env."
else
  info "DASHBOARD_TOKEN already configured; leaving it unchanged."
fi

if [ "$ENV_MODIFIED" -eq 1 ]; then
  chmod 600 .env 2>/dev/null || warn "Could not restrict .env permissions. Consider running: chmod 600 .env"
fi

warn "Almost all environment variables have defaults, but you MUST add your VOIDAI_API_KEY to .env (primary provider)."

step "Building dashboard UI"

if npm run build:dashboard; then
  info "Dashboard UI built successfully."
else
  warn "Dashboard UI build failed. The dev server may still work; continuing setup."
fi

step "Compiling TypeScript"

if npm run build; then
  info "TypeScript compiled successfully."
else
  warn "TypeScript build failed. You can still run the dev server with: npm run dashboard"
fi

info "SQLite database will be created automatically on first boot (CREATE TABLE IF NOT EXISTS)."

# ------------------------------------------------------------------------------
# Final banner
# ------------------------------------------------------------------------------
DASHBOARD_PORT=$(env_get DASHBOARD_PORT .env)
DASHBOARD_PORT=${DASHBOARD_PORT:-3141}

printf '\n'
printf '%s╔════════════════════════════════════════════════════════════╗%s\n' "$GREEN" "$RESET"
printf '%s║  NeuroClaw is ready                                        ║%s\n' "$GREEN" "$RESET"
printf '%s╠════════════════════════════════════════════════════════════╣%s\n' "$GREEN" "$RESET"
printf '%s║  Dashboard port:  %-42s ║%s\n' "$GREEN" "$DASHBOARD_PORT" "$RESET"
printf '%s║  Login URL:       %-42s ║%s\n' "$GREEN" "http://localhost:${DASHBOARD_PORT}/" "$RESET"
printf '%s╚════════════════════════════════════════════════════════════╝%s\n' "$GREEN" "$RESET"
printf '\n'

info "Start in development mode:  npm run dashboard"
info "Start in production mode:   npm run build && npm run start"
printf '\n'
info "View your DASHBOARD_TOKEN:  grep DASHBOARD_TOKEN .env"
info "Optional sidecars:          npm run pydantic:install"
info "                            npm run broker:bootstrap"
