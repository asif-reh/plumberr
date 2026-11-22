#!/usr/bin/env bash
# One-time local setup of a native OpenClaw Gateway for Plumberr (no Docker).
# Installs the Cerebras provider + packed plumberr-tools plugin into $OPENCLAW_STATE_DIR
# and renders apps/gateway/openclaw.json5 into it. Re-run after changing the plugin or config.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" =~ ^# || -z "$v" ]] && continue
    [[ -n "${!k:-}" ]] && continue
    export "$k=$v"
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' "$ROOT/.env")
fi
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.plumberr-openclaw}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$OPENCLAW_STATE_DIR/workspace}"
OC="$ROOT/packages/openclaw-tools/node_modules/.bin/openclaw"
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR/oncall"
cp "$ROOT/apps/gateway/workspace/AGENTS.md" "$OPENCLAW_WORKSPACE_DIR/oncall/AGENTS.md"

[[ -d "$OPENCLAW_STATE_DIR/extensions/cerebras" ]] || "$OC" plugins install @openclaw/cerebras-provider

export OPENCLAW_CEREBRAS_BASE_URL="${OPENCLAW_CEREBRAS_BASE_URL:-http://127.0.0.1:${CEREBRAS_PROXY_PORT:-4300}/v1}"
TGZ_DIR="$(mktemp -d)"
for pkg in openclaw-tools openclaw-hooks; do
  pnpm --filter "@plumberr/$pkg" build >/dev/null
  (cd "$ROOT/packages/$pkg" && pnpm pack --pack-destination "$TGZ_DIR" >/dev/null)
  # A pnpm-linked dir fails OpenClaw's dependency-boundary scan, so install the packed tarball.
  "$OC" plugins install --force --accept-capabilities "$TGZ_DIR"/plumberr-$pkg-*.tgz
done

node "$ROOT/apps/gateway/render-config.mjs" "$ROOT/apps/gateway/openclaw.json5" "$OPENCLAW_STATE_DIR/openclaw.json"
"$OC" config validate
echo "✅ Gateway configured in $OPENCLAW_STATE_DIR. Start it with: bash scripts/dev-gateway.sh"
echo "   Make sure .env has OPENCLAW_URL=http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}, OPENCLAW_HOOK_TOKEN, OPENCLAW_GATEWAY_TOKEN."
