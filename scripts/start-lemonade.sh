#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LEMONADE_BASE_URL="${LEMONADE_BASE_URL:-http://127.0.0.1:13305}"

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

printf '%s\n' "Starting Lorekeeper on http://0.0.0.0:3005 (Lemonade: ${LEMONADE_BASE_URL})" >&2
exec npm run start:lan
