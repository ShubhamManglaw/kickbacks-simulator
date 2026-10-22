#!/usr/bin/env bash

# Kickbacks Simulator - Universal Fleet Startup & Auto-Boot Script
# Starts 1 Backend (port 3001, 10 clients) and 1 Frontend Dashboard (port 5174)
# Fully self-contained: auto-installs Node 20+, dependencies, native bindings, and boot persistence.

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

mkdir -p "$DIR/logs"

# ------------------------------------------------------------------
# 1. Environment & Node.js 20+ Provisioning
# ------------------------------------------------------------------
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

get_node_major() {
  if command -v node >/dev/null 2>&1; then
    node -v 2>/dev/null | tr -d 'v' | cut -d'.' -f1
  else
    echo "0"
  fi
}

CURRENT_NODE_MAJOR=$(get_node_major)

if [ "$CURRENT_NODE_MAJOR" -lt 20 ]; then
  echo "🔍 Current Node.js version is $CURRENT_NODE_MAJOR (Vite dashboard requires Node.js 20+)."

  # Check if NVM is already installed
  if ! command -v nvm >/dev/null 2>&1; then
    echo "📦 NVM not detected. Auto-installing NVM..."
    if command -v curl >/dev/null 2>&1; then
      curl -s -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1 || true
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1 || true
    fi
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  fi

  if command -v nvm >/dev/null 2>&1; then
    echo "⚡ Installing & activating Node.js LTS via NVM..."
    nvm install --lts >/dev/null 2>&1
    nvm use --lts >/dev/null 2>&1
    nvm alias default 'lts/*' >/dev/null 2>&1 || true
  fi
fi

# Fallback: check if an internal or alternative modern node binary exists
if [ "$(get_node_major)" -lt 20 ]; then
  for alt_node in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /snap/bin/node; do
    if [ -x "$alt_node" ]; then
      alt_major=$("$alt_node" -v 2>/dev/null | tr -d 'v' | cut -d'.' -f1)
      if [ "$alt_major" -ge 20 ] 2>/dev/null; then
        export PATH="$(dirname "$alt_node"):$PATH"
        break
      fi
    fi
  done
fi

NODE_MAJOR=$(get_node_major)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Error: Node.js 20+ is required (detected version: $NODE_MAJOR)."
  echo "   Please install Node.js 20+ or run 'nvm install 22'."
  exit 1
fi

# ------------------------------------------------------------------
# 2. Dependencies & Build Tooling Auto-Repair
# ------------------------------------------------------------------
if [ ! -d "$DIR/backend/node_modules" ]; then
  echo "📦 Installing backend dependencies..."
  (cd "$DIR/backend" && npm install)
fi

if [ ! -d "$DIR/frontend/node_modules" ]; then
  echo "📦 Installing frontend dependencies..."
  (cd "$DIR/frontend" && npm install)
fi

# Guard against missing platform-specific Rolldown/Vite optional bindings
if ! (cd "$DIR/frontend" && ./node_modules/.bin/vite --help >/dev/null 2>&1); then
  echo "🔧 Repairing frontend native compiler bindings..."
  (cd "$DIR/frontend" && npm install --include=optional)
  if ! (cd "$DIR/frontend" && ./node_modules/.bin/vite --help >/dev/null 2>&1); then
    ARCH=$(uname -m)
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    if [ "$OS" = "linux" ] && [ "$ARCH" = "x86_64" ]; then
      (cd "$DIR/frontend" && npm install @rolldown/binding-linux-x64-gnu)
    elif [ "$OS" = "linux" ] && [ "$ARCH" = "aarch64" ]; then
      (cd "$DIR/frontend" && npm install @rolldown/binding-linux-arm64-gnu)
    fi
  fi
fi

# ------------------------------------------------------------------
# 3. Automatic Boot Persistence Setup (Systemd + Cron Fallback)
# ------------------------------------------------------------------
AUTOSTART_MARKER="$DIR/logs/.autostart_configured"
if [ ! -f "$AUTOSTART_MARKER" ] && [ -x "$DIR/setup-autostart.sh" ]; then
  "$DIR/setup-autostart.sh" --enable >/dev/null 2>&1 || true
  touch "$AUTOSTART_MARKER"
fi

# ------------------------------------------------------------------
# 4. Fleet Configuration & Port Cleanup
# ------------------------------------------------------------------
NUM_ACCOUNTS=$(node -e 'try { const fs=require("fs"); const c=JSON.parse(fs.readFileSync("./backend/config.json")); console.log(Math.max(1, Array.isArray(c) ? c.length : 1)); } catch(e) { console.log(1); }')
TOTAL_INSTANCES=${TOTAL_INSTANCES:-$NUM_ACCOUNTS}
CLIENTS_PER_INSTANCE=${CLIENTS_PER_INSTANCE:-10}
TOTAL_CLIENTS=$((TOTAL_INSTANCES * CLIENTS_PER_INSTANCE))

echo "========================================================"
echo "🚀 Starting Kickbacks Simulator Fleet ($TOTAL_INSTANCES Backend(s), $TOTAL_CLIENTS clients total)..."
echo "========================================================"

cleanup_port() {
  local port=$1
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti :$port 2>/dev/null || true)
  elif command -v fuser >/dev/null 2>&1; then
    pids=$(fuser $port/tcp 2>/dev/null | tr -s ' ' '\n' | grep -v '^$' || true)
  elif command -v ss >/dev/null 2>&1; then
    pids=$(ss -lptn "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d'=' -f2 | sort -u || true)
  fi

  if [ -n "$pids" ]; then
    echo "⚠️  Cleaning up old process on port $port (PID: $pids)..."
    for p in $pids; do
      kill -9 "$p" 2>/dev/null || true
    done
  fi
}

echo "1. Checking and cleaning existing ports..."
for p in $(seq 3001 3010); do
  cleanup_port $p
done
cleanup_port 5174

pkill -9 -f "simulator.js" 2>/dev/null || true
pkill -9 -f "server.js" 2>/dev/null || true
pkill -9 -f "vite" 2>/dev/null || true

# ------------------------------------------------------------------
# 5. Launch Backend Engine
# ------------------------------------------------------------------
echo "2. Starting unified multi-account backend engine ($CLIENTS_PER_INSTANCE clients per account)..."
PORT=3001 \
INSTANCE_NAME="kickbacks-fleet" \
CLIENTS_PER_INSTANCE=$CLIENTS_PER_INSTANCE \
TOTAL_INSTANCES=1 \
nohup node "$DIR/backend/server.js" </dev/null >> "$DIR/logs/backend_1.log" 2>&1 &
BACKEND_PID=$!
disown $BACKEND_PID 2>/dev/null || true
echo "   -> [Backend API] Unified engine live on http://localhost:3001 (PID: $BACKEND_PID)"

# ------------------------------------------------------------------
# 6. Launch React Frontend Dashboard
# ------------------------------------------------------------------
echo "3. Starting React Frontend Dashboard..."
(
  cd "$DIR/frontend" && \
  nohup ./node_modules/.bin/vite --port 5174 --host 0.0.0.0 </dev/null >> "$DIR/logs/frontend.log" 2>&1 &
  FRONTEND_PID=$!
  disown $FRONTEND_PID 2>/dev/null || true
  echo $FRONTEND_PID > "$DIR/logs/frontend.pid"
)
echo "   -> [Frontend] Dashboard starting on http://localhost:5174"

sleep 2

echo ""
echo "========================================================"
echo "✨ Kickbacks Fleet is live and running!"
echo "   - Dashboard: http://localhost:5174"
echo "   - Backend API: http://localhost:3001"
echo "   - Configured Accounts: $NUM_ACCOUNTS"
echo "========================================================"
