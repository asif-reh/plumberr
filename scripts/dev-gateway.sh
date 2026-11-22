#!/usr/bin/env bash
# Run the OpenClaw Gateway natively (no Docker) for local Plumberr dev.
#   bash scripts/dev-gateway.sh           # foreground
# State lives in $OPENCLAW_STATE_DIR (default ~/.plumberr-openclaw). First run: bash scripts/setup-gateway.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" =~ ^# || -z "$v" ]] && continue
    [[ -n "${!k:-}" ]] && continue
    export "$k=$v"
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' "$ROOT/.env")
fi
: "${CEREBRAS_API_KEY:?CEREBRAS_API_KEY must be set}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.plumberr-openclaw}"
OC="$ROOT/packages/openclaw-tools/node_modules/.bin/openclaw"
exec "$OC" gateway --port "${OPENCLAW_GATEWAY_PORT:-18789}" --raw-stream --raw-stream-path "${RAW_STREAM_PATH:-/tmp/plumberr-raw-stream.jsonl}" "$@"
