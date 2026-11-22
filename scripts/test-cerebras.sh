#!/usr/bin/env bash
# Smoke-test Cerebras access to Kimi K3.1 Pro.
#   CEREBRAS_API_KEY=... bash scripts/test-cerebras.sh
# Reads .env from the repo root if present. Never prints the key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Load .env without overriding variables already set in the environment (and skip empty values).
if [[ -f "$ROOT/.env" ]]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" =~ ^# || -z "$v" ]] && continue
    [[ -n "${!k:-}" ]] && continue
    export "$k=$v"
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' "$ROOT/.env")
fi

: "${CEREBRAS_API_KEY:?Set CEREBRAS_API_KEY (env or .env)}"
MODEL="${CEREBRAS_MODEL_ID:-moonshotai-kimi-k3.1-pro-trial}"
BASE="${CEREBRAS_BASE_URL:-https://api.cerebras.ai/v1}"
EFFORT="${CEREBRAS_REASONING_EFFORT:-low}"

have_jq() { command -v jq >/dev/null 2>&1; }

echo "== 1/2  GET $BASE/models"
MODELS="$(curl -sS -w '\n%{http_code}' "$BASE/models" -H "Authorization: Bearer $CEREBRAS_API_KEY")"
CODE="${MODELS##*$'\n'}"; BODY="${MODELS%$'\n'*}"
echo "HTTP $CODE"
if have_jq; then echo "$BODY" | jq -r '.data[]?.id' ; else echo "$BODY"; fi
if echo "$BODY" | grep -q "\"$MODEL\""; then
  echo "✅ $MODEL is visible to this key"
else
  echo "⚠️  $MODEL not in /models list (dedicated endpoints may be hidden) — trying anyway"
fi

echo
echo "== 2/2  POST $BASE/chat/completions  model=$MODEL reasoning_effort=$EFFORT"
RETRIES="${CEREBRAS_RETRIES:-6}"
for attempt in $(seq 1 "$RETRIES"); do
  START=$(date +%s.%N)
  RESP="$(curl -sS --max-time 120 -w '\n%{http_code}' "$BASE/chat/completions" \
    -H "Authorization: Bearer $CEREBRAS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi in 5 words\"}],\"max_completion_tokens\":256,\"reasoning_effort\":\"$EFFORT\"}")"
  END=$(date +%s.%N)
  CODE="${RESP##*$'\n'}"
  if [[ "$CODE" == "429" || "$CODE" == 5* ]] && (( attempt < RETRIES )); then
    WAIT=$(( 2 ** attempt )); (( WAIT > 30 )) && WAIT=30
    echo "  attempt $attempt: HTTP $CODE $(echo "${RESP%$'\n'*}" | head -c 160) — retrying in ${WAIT}s"
    sleep "$WAIT"; continue
  fi
  break
done
CODE="${RESP##*$'\n'}"; BODY="${RESP%$'\n'*}"
echo "HTTP $CODE  wall=$(awk "BEGIN{printf \"%.2f\", $END-$START}")s"
if have_jq; then
  echo "$BODY" | jq '{content: .choices[0].message.content, reasoning_chars: ((.choices[0].message.reasoning // "") | length), usage, time_info, error, message, code}'
  CT=$(echo "$BODY" | jq -r '.usage.completion_tokens // empty')
  GT=$(echo "$BODY" | jq -r '.time_info.completion_time // empty')
  if [[ -n "$CT" && -n "$GT" ]]; then echo "tokens/sec ≈ $(awk "BEGIN{printf \"%.1f\", $CT/$GT}")"; fi
else
  echo "$BODY"
fi
[[ "$CODE" == "200" ]] && echo "✅ Kimi on Cerebras works" || { echo "❌ request failed"; exit 1; }
