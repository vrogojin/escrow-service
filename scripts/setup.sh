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
if [ "$NODE_VERSION" -lt 18 ]; then
  fail "Node.js >= 18 required (found v$(node -v | sed 's/^v//'))"
fi
ok "Node.js v$(node -v | sed 's/^v//')"

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+')"

docker compose version >/dev/null 2>&1 || fail "'docker compose' plugin is not available"
ok "Docker Compose $(docker compose version --short)"

# ── 2. Environment file ─────────────────────────────────────
if [ ! -f .env ]; then
  info "Creating .env from .env.example..."

  # Determine network
  if [ -z "${SPHERE_NETWORK:-}" ]; then
    echo ""
    echo "Select Unicity network:"
    echo "  1) mainnet  (production)"
    echo "  2) testnet  (testing)"
    echo "  3) dev      (local development)"
    echo ""
    read -rp "Choice [1/2/3]: " NETWORK_CHOICE
    case "$NETWORK_CHOICE" in
      1) SPHERE_NETWORK="mainnet" ;;
      2) SPHERE_NETWORK="testnet" ;;
      3) SPHERE_NETWORK="dev" ;;
      *) fail "Invalid choice: $NETWORK_CHOICE" ;;
    esac
  fi

  sed "s/^SPHERE_NETWORK=.*/SPHERE_NETWORK=${SPHERE_NETWORK}/" .env.example > .env
  ok "Created .env (network: ${SPHERE_NETWORK})"
else
  ok ".env already exists, skipping"
fi

# Source .env so subsequent steps can use the values
set -a
# shellcheck disable=SC1091
source .env
set +a

# ── 3. Docker Compose ───────────────────────────────────────
info "Starting PostgreSQL and Redis..."
docker compose up -d

info "Waiting for containers to be healthy..."
RETRIES=30
until [ "$(docker compose ps --format json | grep -c '"healthy"')" -ge 2 ] || [ "$RETRIES" -le 0 ]; do
  sleep 1
  RETRIES=$((RETRIES - 1))
done

if [ "$RETRIES" -le 0 ]; then
  warn "Timed out waiting for containers — check 'docker compose ps'"
else
  ok "PostgreSQL and Redis are healthy"
fi

# ── 4. Node dependencies ────────────────────────────────────
if [ ! -d node_modules ]; then
  info "Installing npm dependencies..."
  npm install
  ok "Dependencies installed"
else
  ok "node_modules/ exists, skipping npm install"
fi

# ── 5. Build ─────────────────────────────────────────────────
info "Building TypeScript..."
npm run build
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
echo "========================================"
