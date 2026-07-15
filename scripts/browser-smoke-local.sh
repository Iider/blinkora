#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-browser-smoke.XXXXXX")"
TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-browser-smoke-target.XXXXXX")"
PORT="${BLINKORA_BROWSER_SMOKE_PORT:-16683}"
LABEL="com.blinkora.browser-smoke-${RANDOM}"
SERVER_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$APP_HOME" "$TARGET_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: smoke:browser-local currently starts an isolated macOS native release only" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 is required for the post-smoke integrity checks" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required to wait for the temporary service" >&2
  exit 1
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: browser smoke port $PORT is already in use; set BLINKORA_BROWSER_SMOKE_PORT" >&2
  exit 1
fi

cd "$ROOT_DIR"
BLINKORA_LOCAL_HOME="$APP_HOME" \
BLINKORA_LAUNCHD_LABEL="$LABEL" \
CARGO_TARGET_DIR="$TARGET_DIR" \
PORT="$PORT" \
bun run deploy:local build

umask 077
DATA_DIR="$APP_HOME/data"
DB_PATH="$DATA_DIR/blinkora.sqlite3"
BLINKORA_SECRET="$(openssl rand -hex 32)"
PORT="$PORT" \
DATA_DIR="$DATA_DIR" \
PUBLIC_PATH="$APP_HOME/release/public" \
SCHEMA_PATH="$APP_HOME/release/db/schema.sqlite.sql" \
BLINKORA_SECRET="$BLINKORA_SECRET" \
RUST_LOG=warn \
"$APP_HOME/release/blinkora-server" >"$APP_HOME/browser-smoke-server.log" 2>&1 &
SERVER_PID=$!

for _ in {1..30}; do
  if curl --fail --silent --connect-timeout 1 --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
    break
  fi
  sleep 1
done
if ! curl --fail --silent --connect-timeout 1 --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "error: temporary browser smoke service did not become healthy" >&2
  tail -n 40 "$APP_HOME/browser-smoke-server.log" >&2 || true
  exit 1
fi

BLINKORA_BASE_URL="http://127.0.0.1:$PORT" \
BLINKORA_BROWSER_SMOKE_ISOLATED=1 \
bun run smoke:browser

[[ "$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')" == "ok" ]] || {
  echo "error: SQLite integrity_check failed after browser smoke" >&2
  exit 1
}
[[ -z "$(sqlite3 "$DB_PATH" 'PRAGMA foreign_key_check;')" ]] || {
  echo "error: SQLite foreign_key_check reported rows after browser smoke" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" 'SELECT type || "=" || count(*) FROM notes GROUP BY type ORDER BY type;')" == $'0=1\n1=1\n2=1' ]] || {
  echo "error: browser smoke did not persist exactly one Blinkora, Note, and Todo" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" 'SELECT count(*) || ":" || max(version) FROM "noteHistory";')" == "1:1" ]] || {
  echo "error: browser smoke did not persist one complete Note history version" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM notes WHERE content LIKE '%(edited)%';")" == "1" ]] || {
  echo "error: browser smoke did not persist the edited Note content" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM workspaces WHERE name LIKE 'browser UI workspace %';")" == "1" ]] || {
  echo "error: browser smoke did not persist its selected Workspace" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM attachments WHERE name = '.folder' AND \"perfixPath\" LIKE 'browser UI folder %';")" == "2" ]] || {
  echo "error: browser smoke did not persist its root and nested resource folders" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" '
  SELECT
    (SELECT count(*) FROM notes n LEFT JOIN workspaces w ON w.id = n."workspaceId" WHERE n."workspaceId" IS NOT NULL AND w.id IS NULL)
    + (SELECT count(*) FROM "noteHistory" h LEFT JOIN notes n ON n.id = h."noteId" WHERE n.id IS NULL)
    + (SELECT count(*) FROM comments c LEFT JOIN notes n ON n.id = c."noteId" WHERE n.id IS NULL)
    + (SELECT count(*) FROM attachments a LEFT JOIN notes n ON n.id = a."noteId" WHERE a."noteId" IS NOT NULL AND n.id IS NULL)
    + (SELECT count(*) FROM "tagsToNote" t LEFT JOIN notes n ON n.id = t."noteId" WHERE n.id IS NULL)
    + (SELECT count(*) FROM "tagsToNote" t LEFT JOIN tag g ON g.id = t."tagId" WHERE g.id IS NULL);
')" == "0" ]] || {
  echo "error: orphan check failed after browser smoke" >&2
  exit 1
}

echo "browser smoke local harness passed; temporary native service and SQLite data will now be removed"
