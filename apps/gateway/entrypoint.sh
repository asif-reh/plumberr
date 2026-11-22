#!/usr/bin/env sh
# Railway/Docker entrypoint for the Plumberr OpenClaw Gateway.
set -eu
: "${OPENCLAW_STATE_DIR:=/data/.openclaw}"
: "${OPENCLAW_WORKSPACE_DIR:=/data/workspace}"
export OPENCLAW_STATE_DIR OPENCLAW_WORKSPACE_DIR
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR/oncall"
cp /app/workspace/AGENTS.md "$OPENCLAW_WORKSPACE_DIR/oncall/AGENTS.md"
# Plugins (idempotent). Local plugins must be installed from a packed tarball:
# a pnpm-linked directory fails OpenClaw's dependency-boundary safety scan.
[ -d "$OPENCLAW_STATE_DIR/extensions/cerebras" ] || openclaw plugins install @openclaw/cerebras-provider
openclaw plugins install --force --accept-capabilities /app/plugins/plumberr-tools.tgz
openclaw plugins install --force --accept-capabilities /app/plugins/plumberr-hooks.tgz
: "${OPENCLAW_CEREBRAS_BASE_URL:=https://api.cerebras.ai/v1}"; export OPENCLAW_CEREBRAS_BASE_URL
# Render config (JSON5 → JSON; ${VARS} stay literal and are resolved by OpenClaw at runtime)
node /app/render-config.mjs /app/openclaw.json5 "$OPENCLAW_STATE_DIR/openclaw.json"
openclaw config validate
exec openclaw gateway --port "${OPENCLAW_GATEWAY_PORT:-8080}" --bind lan
