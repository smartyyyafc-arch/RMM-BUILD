#!/usr/bin/env bash
#
# Boots the RMM server and a local agent with dev defaults for a quick demo.
# Both processes are stopped on Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."

export PORT="${PORT:-8080}"
export RMM_ADMIN_KEY="${RMM_ADMIN_KEY:-dev-admin-key}"
export RMM_ENROLLMENT_TOKEN="${RMM_ENROLLMENT_TOKEN:-dev-enroll-token}"
export RMM_HEARTBEAT_INTERVAL_SECONDS="${RMM_HEARTBEAT_INTERVAL_SECONDS:-5}"
export RMM_DB_PATH="${RMM_DB_PATH:-./data/rmm.db}"

echo "Building..."
npm run build

echo "Starting server on http://localhost:${PORT} (admin key: ${RMM_ADMIN_KEY})"
node --experimental-sqlite packages/server/dist/index.js &
SERVER_PID=$!

cleanup() {
  echo
  echo "Stopping..."
  kill "$SERVER_PID" "${AGENT_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 2

echo "Starting agent -> http://localhost:${PORT}"
RMM_SERVER_URL="http://localhost:${PORT}" \
RMM_ENROLLMENT_TOKEN="${RMM_ENROLLMENT_TOKEN}" \
RMM_MACHINE_ID="${RMM_MACHINE_ID:-dev-machine}" \
node packages/agent/dist/index.js &
AGENT_PID=$!

echo
echo "Dashboard: http://localhost:${PORT}   (Ctrl-C to stop)"
wait
