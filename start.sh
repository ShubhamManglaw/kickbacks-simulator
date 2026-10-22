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
# Ensure config.json is initialized from default credentials template if missing
if [ ! -f "$DIR/backend/config.json" ] && [ -f "$DIR/backend/config.default.json" ]; then
  echo "📋 Initializing backend/config.json from default template..."
  cp "$DIR/backend/config.default.json" "$DIR/backend/config.json"
fi

if [ ! -d "$DIR/backend/node_modules" ]; then
  echo "📦 Installing backend dependencies..."
  (cd "$DIR/backend" && npm install)
fi

# Frontend handling: If pre-compiled dist/ exists, the Express backend serves it natively.
# Only attempt to install Vite if dist is missing or user explicitly has plenty of RAM.
if [ ! -f "$DIR/frontend/dist/index.html" ]; then
  echo "📦 Pre-built frontend bundle missing. Installing frontend dependencies..."
  (cd "$DIR/frontend" && npm install)
  (cd "$DIR/frontend" && npm run build) || true
fi

# Optional: try to launch Vite dev server if node_modules already exists, but do not fail
HAS_VITE=false
if [ -f "$DIR/frontend/node_modules/.bin/vite" ]; then
  HAS_VITE=true
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
NUM_ACCOUNTS=$(node -e 'try { const fs=require("fs"); const p = fs.existsSync("./backend/config.json") ? "./backend/config.json" : "./backend/config.default.json"; const c=JSON.parse(fs.readFileSync(p)); console.log(Math.max(1, Array.isArray(c) ? c.length : 1)); } catch(e) { console.log(1); }')
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
echo "   -> [Backend API + Web Dashboard] Live on port 3001 (PID: $BACKEND_PID)"

# ------------------------------------------------------------------
# 6. Launch React Frontend Dashboard (Vite dev server if available)
# ------------------------------------------------------------------
if [ "$HAS_VITE" = "true" ]; then
  echo "3. Starting optional Vite dev server on port 5174..."
  (
    cd "$DIR/frontend" && \
    nohup ./node_modules/.bin/vite --port 5174 --host 0.0.0.0 </dev/null >> "$DIR/logs/frontend.log" 2>&1 &
    FRONTEND_PID=$!
    disown $FRONTEND_PID 2>/dev/null || true
    echo $FRONTEND_PID > "$DIR/logs/frontend.pid"
  )
else
  echo "3. Headless/Lightweight Mode: Web Dashboard is served directly by Backend (port 3001) with zero extra RAM."
fi

sleep 2

# Detect host LAN IP for headless SSH users
LAN_IP=""
if command -v hostname >/dev/null 2>&1; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$LAN_IP" ] && command -v ip >/dev/null 2>&1; then
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7}')
fi
[ -z "$LAN_IP" ] && LAN_IP="localhost"

echo ""
echo "========================================================"
echo "✨ Kickbacks Fleet is live and running!"
echo "   - Local Dashboard:     http://localhost:3001"
echo "   - Remote / SSH Access: http://${LAN_IP}:3001"
if [ "$HAS_VITE" = "true" ]; then
echo "   - Vite Dev Port:       http://${LAN_IP}:5174"
fi
echo "   - Configured Accounts: $NUM_ACCOUNTS"
echo "========================================================"
