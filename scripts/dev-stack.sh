#!/usr/bin/env bash
# Start demo-shop, api (in-process runner) and cerebras-proxy from dist builds, logging to $LOG_DIR.
# Loads .env without overriding existing env (so CEREBRAS_API_KEY can come from the process env).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-/tmp/pl}"
mkdir -p "$LOG_DIR"
if [[ -f "$ROOT/.env" ]]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" =~ ^# || -z "$v" ]] && continue
    [[ -n "${!k:-}" ]] && continue
    export "$k=$v"
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' "$ROOT/.env")
fi
cd "$ROOT"
nohup node services/demo-shop/dist/index.js >"$LOG_DIR/shop.log" 2>&1 &
echo "demo-shop pid $!"
nohup node services/cerebras-proxy/dist/index.js >"$LOG_DIR/proxy.log" 2>&1 &
echo "cerebras-proxy pid $!"
sleep 1
nohup node apps/api/dist/index.js >"$LOG_DIR/api.log" 2>&1 &
echo "api pid $!"
