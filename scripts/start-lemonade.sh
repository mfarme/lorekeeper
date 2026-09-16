#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LEMONADE_BASE_URL="${LEMONADE_BASE_URL:-http://127.0.0.1:13305}"
VOICE_GATEWAY_ENABLED="${VOICE_GATEWAY_ENABLED:-1}"
VOICE_GATEWAY_HEALTH_URL="${VOICE_GATEWAY_HEALTH_URL:-http://127.0.0.1:${VOICE_GATEWAY_PORT:-8765}/health}"
VOICE_GATEWAY_LOG="${VOICE_GATEWAY_LOG:-/tmp/lorekeeper-voice-gateway.log}"

VOICE_GATEWAY_PID=""
VOICE_GATEWAY_OWNED="0"
NEXT_PID=""
cleanup() {
  if [[ -n "$NEXT_PID" ]]; then
    kill "$NEXT_PID" 2>/dev/null || true
  fi
  if [[ "$VOICE_GATEWAY_OWNED" == "1" && -n "$VOICE_GATEWAY_PID" ]]; then
    kill "$VOICE_GATEWAY_PID" 2>/dev/null || true
  fi
  if [[ -n "$NEXT_PID" ]]; then
    wait "$NEXT_PID" 2>/dev/null || true
  fi
  if [[ "$VOICE_GATEWAY_OWNED" == "1" && -n "$VOICE_GATEWAY_PID" ]]; then
    wait "$VOICE_GATEWAY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM
if [[ ! -f .next/BUILD_ID ]]; then
  printf '%s\n' "No production build found. Run: npm run build" >&2
  exit 1
fi

if [[ ! -f .env.server ]]; then
  umask 077
  printf 'DB_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > .env.server
  printf '%s\n' "Created .env.server with a new database key; back it up before play." >&2
fi

if ! curl -fsS --max-time 5 "${LEMONADE_BASE_URL%/}/live" >/dev/null; then
  printf '%s\n' "Lemonade is not reachable at ${LEMONADE_BASE_URL}. Start lemond, then retry." >&2
  exit 1
fi

if [[ "$VOICE_GATEWAY_ENABLED" == "1" ]]; then
  if curl -fsS --max-time 2 "$VOICE_GATEWAY_HEALTH_URL" >/dev/null; then
    printf '%s\n' "Reusing healthy voice gateway." >&2
  else
    printf '%s\n' "Starting shared-table voice gateway." >&2
    node scripts/voice-gateway.mjs >"$VOICE_GATEWAY_LOG" 2>&1 &
    VOICE_GATEWAY_PID=$!
    VOICE_GATEWAY_OWNED="1"
    for _ in {1..20}; do
      if curl -fsS --max-time 2 "$VOICE_GATEWAY_HEALTH_URL" >/dev/null; then
        break
      fi
      if ! kill -0 "$VOICE_GATEWAY_PID" 2>/dev/null; then
        printf '%s\n' "Voice gateway exited; see $VOICE_GATEWAY_LOG." >&2
        exit 1
      fi
      sleep 0.25
    done
    if ! curl -fsS --max-time 2 "$VOICE_GATEWAY_HEALTH_URL" >/dev/null; then
      printf '%s\n' "Voice gateway did not become healthy; see $VOICE_GATEWAY_LOG." >&2
      exit 1
    fi
  fi
else
  printf '%s\n' "Shared-table voice gateway disabled (VOICE_GATEWAY_ENABLED=$VOICE_GATEWAY_ENABLED)." >&2
fi

printf '%s\n' "Starting Lorekeeper on http://0.0.0.0:3005 (Lemonade: ${LEMONADE_BASE_URL})" >&2
set +e
./node_modules/.bin/next start -H 0.0.0.0 -p 3005 &
NEXT_PID=$!
wait "$NEXT_PID"
NEXT_STATUS=$?
set -e
exit "$NEXT_STATUS"
