#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-browser-smoke.XXXXXX")"
TARGET_DIR="${BLINKORA_SMOKE_CARGO_TARGET_DIR:-}"
REMOVE_TARGET_DIR=false
if [[ -z "$TARGET_DIR" ]]; then
  TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-browser-smoke-target.XXXXXX")"
  REMOVE_TARGET_DIR=true
fi
PORT="${BLINKORA_BROWSER_SMOKE_PORT:-16683}"
LABEL="com.blinkora.browser-smoke-${RANDOM}"
SERVER_PID=""
SMOKE_STAMP="$(date +%s)-$RANDOM"
SMOKE_USER="${BLINKORA_BROWSER_SMOKE_USER:-browser_smoke_$SMOKE_STAMP}"
SMOKE_PASSWORD="${BLINKORA_BROWSER_SMOKE_PASSWORD:-BrowserSmoke!local}"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$APP_HOME"
  if [[ "$REMOVE_TARGET_DIR" == true ]]; then
    rm -rf "$TARGET_DIR"
  fi
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
BLINKORA_BROWSER_SMOKE_USER="$SMOKE_USER" \
BLINKORA_BROWSER_SMOKE_PASSWORD="$SMOKE_PASSWORD" \
bun run smoke:browser

[[ "$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')" == "ok" ]] || {
  echo "error: SQLite integrity_check failed after browser smoke" >&2
  exit 1
}
[[ -z "$(sqlite3 "$DB_PATH" 'PRAGMA foreign_key_check;')" ]] || {
  echo "error: SQLite foreign_key_check reported rows after browser smoke" >&2
  exit 1
}
if [[ "${BLINKORA_BROWSER_SMOKE_SCENARIO:-full}" != "full" ]]; then
  echo "focused browser smoke passed with SQLite integrity and foreign-key checks"
  exit 0
fi
[[ "$(sqlite3 "$DB_PATH" 'SELECT type || "=" || count(*) FROM notes GROUP BY type ORDER BY type;')" == $'0=11\n1=13\n2=12' ]] || {
  echo "error: browser smoke did not persist its Blinkora, Note, and Todo pagination fixtures" >&2
  exit 1
}
EDITED_NOTE_ID="$(sqlite3 "$DB_PATH" "SELECT id FROM notes WHERE type = 1 AND content LIKE '%(edited)%' LIMIT 1;")"
[[ -n "$EDITED_NOTE_ID" ]] || {
  echo "error: browser smoke could not find the edited Note" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT type FROM notes WHERE id=$EDITED_NOTE_ID;")" == "1" ]] || {
  echo "error: browser smoke did not finish the Note type-conversion round trip" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT json_extract(metadata, '$.properties.browser_boolean') FROM notes WHERE id=$EDITED_NOTE_ID;")" == "1" \
  && "$(sqlite3 "$DB_PATH" "SELECT json_extract(metadata, '$.properties.browser_link') FROM notes WHERE id=$EDITED_NOTE_ID;")" == "GitHub：[browser-use/browser-harness](https://github.com/browser-use/browser-harness)" \
  && "$(sqlite3 "$DB_PATH" "SELECT json_array_length(metadata, '$.properties.browser_list') FROM notes WHERE id=$EDITED_NOTE_ID;")" == "3" \
  && "$(sqlite3 "$DB_PATH" "SELECT json_type(metadata, '$.properties.browser_null') FROM notes WHERE id=$EDITED_NOTE_ID;")" == "null" \
  && "$(sqlite3 "$DB_PATH" "SELECT json_extract(metadata, '$.properties.browser_number') FROM notes WHERE id=$EDITED_NOTE_ID;")" == "42.5" \
  && "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM notes WHERE id=$EDITED_NOTE_ID AND json_extract(metadata, '$.properties.browser_string') LIKE 'property value %' AND json_extract(metadata, '$.browser_preserved') LIKE 'preserved metadata %';")" == "1" ]] || {
  echo "error: browser smoke did not preserve typed custom Note properties" >&2
  exit 1
}
EDITED_BLINKORA_ID="$(sqlite3 "$DB_PATH" "SELECT id FROM notes WHERE content LIKE 'browser UI blinkora %' AND content LIKE '%edited%' LIMIT 1;")"
EDITED_BLINKORA_HISTORY_COUNT="0"
if [[ -n "$EDITED_BLINKORA_ID" ]]; then
  EDITED_BLINKORA_HISTORY_COUNT="$(sqlite3 "$DB_PATH" "SELECT count(*) FROM \"noteHistory\" WHERE \"noteId\"=$EDITED_BLINKORA_ID;")"
fi
[[ -n "$EDITED_BLINKORA_ID" && "$EDITED_BLINKORA_HISTORY_COUNT" -ge 1 ]] || {
  echo "error: browser smoke could not find a history version for the edited Blinkora (noteId=${EDITED_BLINKORA_ID:-missing}, historyCount=$EDITED_BLINKORA_HISTORY_COUNT)" >&2
  exit 1
}
EDITED_TODO_ID="$(sqlite3 "$DB_PATH" "SELECT id FROM notes WHERE content LIKE 'browser UI todo %' AND content LIKE '%edited%' LIMIT 1;")"
[[ -n "$EDITED_TODO_ID" && "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM \"noteHistory\" WHERE \"noteId\"=$EDITED_TODO_ID;")" -ge 1 ]] || {
  echo "error: browser smoke could not find a history version for the edited Todo" >&2
  exit 1
}
MOVED_WORKSPACE_ID="$(sqlite3 "$DB_PATH" "SELECT \"workspaceId\" FROM notes WHERE id = $EDITED_NOTE_ID;")"
DEFAULT_WORKSPACE_ID="$(sqlite3 "$DB_PATH" 'SELECT id FROM workspaces WHERE "isDefault"=1 LIMIT 1;')"
SOURCE_WORKSPACE_ID="$(sqlite3 "$DB_PATH" "SELECT id FROM workspaces WHERE name LIKE 'browser UI workspace %' LIMIT 1;")"
[[ -n "$MOVED_WORKSPACE_ID" && "$MOVED_WORKSPACE_ID" == "$DEFAULT_WORKSPACE_ID" && "$MOVED_WORKSPACE_ID" != "$SOURCE_WORKSPACE_ID" ]] || {
  echo "error: browser smoke did not move the edited Note to the default Workspace" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM \"noteHistory\" WHERE \"noteId\"=$EDITED_NOTE_ID AND \"workspaceId\"=$MOVED_WORKSPACE_ID;")" -ge 1 ]] || {
  echo "error: browser smoke did not move Note history with the edited Note" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM comments WHERE \"noteId\"=$EDITED_NOTE_ID;")" == "0" ]] || {
  echo "error: browser smoke did not delete the edited Note comment" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM attachments WHERE name LIKE 'browser-ui-attachment-%';")" == "0" ]] || {
  echo "error: browser smoke did not delete its moved Note attachment" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "
  SELECT
    (SELECT count(*) FROM notes WHERE content LIKE 'browser shared attachment %')
    + (SELECT count(*) FROM attachments WHERE name LIKE 'browser-shared-attachment-%');
")" == "0" ]] || {
  echo "error: browser smoke left a shared-resource fixture behind" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM \"tagsToNote\" t JOIN tag g ON g.id=t.\"tagId\" WHERE t.\"noteId\"=$EDITED_NOTE_ID AND g.\"workspaceId\"=$MOVED_WORKSPACE_ID;")" -ge 1 ]] || {
  echo "error: browser smoke did not keep the edited Note tag in the target Workspace" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM \"noteHistory\" WHERE \"noteId\" = $EDITED_NOTE_ID;")" -ge 1 ]] || {
  echo "error: browser smoke did not persist a history version for the edited Note" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" '
  SELECT count(*)
  FROM (
    SELECT "noteId"
    FROM "noteHistory"
    GROUP BY "noteId"
    HAVING min(version) <> 1 OR max(version) <> count(*)
  );
')" == "0" ]] || {
  echo "error: browser smoke found non-contiguous Note history versions" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM \"operationLog\" WHERE \"noteId\" = $EDITED_NOTE_ID;")" -ge 1 ]] || {
  echo "error: browser smoke did not persist an operation log for the edited Note" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM notes WHERE content LIKE '%(edited)%';")" == "3" ]] || {
  echo "error: browser smoke did not persist all three edited note contents" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "
  SELECT count(*)
  FROM notes
  WHERE content LIKE 'browser UI pagination note %'
    AND \"workspaceId\"=(SELECT id FROM workspaces WHERE \"isDefault\"=1 LIMIT 1);
")" -ge 2 ]] || {
  echo "error: browser smoke did not persist both Notes from its multi-select Workspace move" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM workspaces WHERE name LIKE 'browser UI workspace %';")" == "1" ]] || {
  echo "error: browser smoke did not persist its selected Workspace" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "
  SELECT
    (SELECT count(*) FROM workspaces WHERE name LIKE 'browser disposable workspace %')
    + (SELECT count(*) FROM notes WHERE content LIKE 'browser disposable cascade note %')
    + (SELECT count(*) FROM comments WHERE content LIKE 'browser disposable cascade comment %')
    + (SELECT count(*) FROM attachments WHERE name LIKE 'browser-disposable-workspace-%')
    + (SELECT count(*) FROM \"agentAccessTokens\" WHERE name LIKE 'browser disposable token %');
")" == "0" ]] || {
  echo "error: browser smoke left data behind after deleting its disposable Workspace" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM attachments WHERE name = '.folder' AND \"perfixPath\" LIKE 'browser UI folder renamed %';")" == "2" ]] || {
  echo "error: browser smoke did not persist its renamed root and nested resource folders" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM attachments WHERE name = '.folder' AND \"perfixPath\" LIKE 'browser UI sibling folder % preserved';")" == "1" ]] || {
  echo "error: browser smoke deleted the protected same-prefix sibling folder" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" 'SELECT count(*) FROM notes WHERE "isTop"=1;')" == "1" ]] || {
  echo "error: browser smoke did not persist the pinned Note" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" 'SELECT count(*) FROM notes WHERE "isArchived"=1 OR "isRecycle"=1;')" == "0" ]] || {
  echo "error: browser smoke did not restore all archived and recycled Notes" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM comments WHERE content LIKE 'browser UI comment %';")" == "0" ]] || {
  echo "error: browser smoke did not delete its annotation" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT count(*) FROM notes WHERE content LIKE 'browser UI blinkora %' AND \"isReviewed\"=1;")" == "1" ]] || {
  echo "error: browser smoke did not persist its daily review action" >&2
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
# operationLog.noteId is an audit snapshot, intentionally not a foreign key:
# deletion logs retain the original note id after the note itself is removed.

if [[ "${BLINKORA_BROWSER_SMOKE_RUN_API:-0}" == "1" ]]; then
  UPLOAD_BY_URL_PORT=$((PORT + 1))
  if lsof -nP -iTCP:"$UPLOAD_BY_URL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "error: browser API smoke upload-by-URL port $UPLOAD_BY_URL_PORT is already in use" >&2
    exit 1
  fi
  BLINKORA_BASE_URL="http://127.0.0.1:$PORT" \
  BLINKORA_SMOKE_USER="$SMOKE_USER" \
  BLINKORA_SMOKE_PASSWORD="$SMOKE_PASSWORD" \
  BLINKORA_UPLOAD_BY_URL_HOST=127.0.0.1 \
  BLINKORA_UPLOAD_BY_URL_PORT="$UPLOAD_BY_URL_PORT" \
  bun run smoke:rust

  LOGIN_RESPONSE="$APP_HOME/agent-login.json"
  curl --fail --silent --show-error \
    --header 'content-type: application/json' \
    --data "{\"name\":\"$SMOKE_USER\",\"password\":\"$SMOKE_PASSWORD\"}" \
    --output "$LOGIN_RESPONSE" \
    "http://127.0.0.1:$PORT/api/auth/login"
  ACCOUNT_TOKEN="$(node -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof payload.token !== "string" || payload.token.length === 0) process.exit(1);
    process.stdout.write(payload.token);
  ' "$LOGIN_RESPONSE")"
  rm -f "$LOGIN_RESPONSE"

  BLINKORA_BASE_URL="http://127.0.0.1:$PORT" \
  BLINKORA_ACCOUNT_TOKEN="$ACCOUNT_TOKEN" \
  bun run smoke:agent
  unset ACCOUNT_TOKEN

  [[ "$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')" == "ok" ]] || {
    echo "error: SQLite integrity_check failed after API and Agent smoke" >&2
    exit 1
  }
  [[ -z "$(sqlite3 "$DB_PATH" 'PRAGMA foreign_key_check;')" ]] || {
    echo "error: SQLite foreign_key_check reported rows after API and Agent smoke" >&2
    exit 1
  }
fi

echo "browser smoke local harness passed; temporary native service and SQLite data will now be removed"
