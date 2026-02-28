#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Helpers ──────────────────────────────────────────────────
info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$*"; }
ok()    { printf '\033[1;32m[ok]\033[0m    %s\n' "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m  %s\n' "$*"; }
fail()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Prerequisites ────────────────────────────────────────
info "Checking prerequisites..."

command -v node >/dev/null 2>&1 || fail "node is not installed (>= 18 required)"
NODE_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
if ! [[ "$NODE_VERSION" =~ ^[0-9]+$ ]]; then
  fail "Could not parse Node.js version from: $(node -v)"
fi
if [ "$NODE_VERSION" -lt 18 ]; then
  fail "Node.js >= 18 required (found v$(node -v | sed 's/^v//'))"
fi
ok "Node.js v$(node -v | sed 's/^v//')"

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

docker compose version >/dev/null 2>&1 || fail "'docker compose' plugin is not available"
ok "Docker Compose $(docker compose version --short)"

# ── 2. Environment file ─────────────────────────────────────
if [ ! -f .env ]; then
  info "Creating .env from .env.example..."

  # Determine network
  if [ -z "${SPHERE_NETWORK:-}" ]; then
    if [ ! -t 0 ]; then
      fail "SPHERE_NETWORK is not set and stdin is not a terminal. Set SPHERE_NETWORK=testnet|mainnet|dev"
    fi
    echo ""
    echo "Select Unicity network:"
    echo "  1) testnet  (testing — recommended for initial setup)"
    echo "  2) mainnet  (production)"
    echo "  3) dev      (local development)"
    echo ""
    read -rp "Choice [1/2/3]: " NETWORK_CHOICE
    case "$NETWORK_CHOICE" in
      1) SPHERE_NETWORK="testnet" ;;
      2) SPHERE_NETWORK="mainnet" ;;
      3) SPHERE_NETWORK="dev" ;;
      *) fail "Invalid choice: $NETWORK_CHOICE" ;;
    esac
  fi

  # Validate network regardless of source (env var or interactive)
  case "$SPHERE_NETWORK" in
    mainnet|testnet|dev) ;;
    *) fail "Invalid SPHERE_NETWORK: must be mainnet, testnet, or dev" ;;
  esac

  # Generate random URL-safe passwords for this instance
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  REDIS_PASSWORD=$(openssl rand -hex 24)

  # Build .env from template with safe substitutions (no sed injection)
  while IFS= read -r line; do
    case "$line" in
      "SPHERE_NETWORK="*)     echo "SPHERE_NETWORK=${SPHERE_NETWORK}" ;;
      "POSTGRES_PASSWORD="*)  echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" ;;
      "DATABASE_URL="*)       echo "DATABASE_URL=postgresql://escrow:${POSTGRES_PASSWORD}@localhost:5432/escrow_db" ;;
      "REDIS_PASSWORD="*)     echo "REDIS_PASSWORD=${REDIS_PASSWORD}" ;;
      "REDIS_URL="*)          echo "REDIS_URL=redis://:${REDIS_PASSWORD}@localhost:6379" ;;
      *)                      echo "$line" ;;
    esac
  done < .env.example > .env

  ok "Created .env (network: ${SPHERE_NETWORK})"
else
  ok ".env already exists, skipping"
fi

# Load .env values safely (KEY=VALUE parsing only, no command execution)
while IFS= read -r line; do
  # Skip comments and blank lines
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$line" ]] && continue
  # Split on first '=' only to preserve values containing '='
  key="${line%%=*}"
  value="${line#*=}"
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"
  [ -z "$key" ] && continue
  export "$key"="$value"
done < .env

# ── 3. Docker Compose ───────────────────────────────────────
info "Starting PostgreSQL and Redis..."
docker compose up -d

info "Waiting for containers to be healthy..."
RETRIES=30
HEALTHY=0
while [ "$RETRIES" -gt 0 ]; do
  HEALTHY=$(docker compose ps --format json 2>/dev/null | grep -cE '"healthy"' || true)
  [ "$HEALTHY" -ge 2 ] && break
  sleep 1
  RETRIES=$((RETRIES - 1))
done

if [ "$HEALTHY" -lt 2 ]; then
  fail "Containers did not become healthy within 30s — check 'docker compose ps'"
fi
ok "PostgreSQL and Redis are healthy"

# ── 4. Node dependencies ────────────────────────────────────
info "Installing npm dependencies..."
npm install
ok "Dependencies installed"

# ── 5. Build ─────────────────────────────────────────────────
info "Building TypeScript..."
npm run build
[ -f dist/scripts/init-wallet.js ] || fail "Build did not produce dist/scripts/init-wallet.js"
ok "Build complete"

# ── 6. Database migration ───────────────────────────────────
info "Running database migrations..."
npm run db:migrate
ok "Migrations applied"

# ── 7. Wallet initialization ────────────────────────────────
info "Initializing escrow wallet..."
node dist/scripts/init-wallet.js

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Setup complete!"
echo "========================================"
echo ""
echo "  Start the service:"
echo "    npm run dev      (development, with hot-reload)"
echo "    npm run start    (production, from dist/)"
echo ""
echo "  Stop infrastructure:"
echo "    docker compose down"
echo ""
echo "  WARNING: 'docker compose down -v' destroys all data."
echo ""
echo "========================================"
