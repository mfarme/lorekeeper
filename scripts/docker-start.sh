#!/bin/sh
set -eu

GATEWAY_PID=""
APP_PID=""
cleanup() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null || true
  fi
  if [ -n "$GATEWAY_PID" ]; then
    kill "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -n "$APP_PID" ]; then
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [ -n "$GATEWAY_PID" ]; then
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "${VOICE_GATEWAY_ENABLED:-1}" = "1" ]; then
  node /app/scripts/voice-gateway.mjs &
  GATEWAY_PID=$!
fi

set +e
"$@" &
APP_PID=$!
wait "$APP_PID"
APP_STATUS=$?
set -e
exit "$APP_STATUS"
