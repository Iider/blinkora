#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_BACKUP="${BLINKORA_M2_SOURCE_BACKUP:-$HOME/.blinkora/migrations/fnas-readonly-20260716T084621Z/local-post-switch-backup}"
RUNTIME_HOME="${BLINKORA_M2_RUNTIME_HOME:-$HOME/.blinkora/local}"
PORT="${BLINKORA_M2_CLONE_PORT:-16687}"
RESTORE_PORT=$((PORT + 1))
APP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-m2-clone.XXXXXX")"
DATA_DIR="$APP_HOME/data"
BACKUP_DIR="$APP_HOME/backup"
RESTORE_DIR="$APP_HOME/restored"
SERVER_PID=""
RESTORE_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "$SERVER_PID" "$RESTORE_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  if (( status != 0 )); then
    echo "error: M2 clone smoke failed; recent isolated server logs:" >&2
    tail -n 60 "$APP_HOME"/*.log 2>/dev/null >&2 || true
  fi
  rm -rf "$APP_HOME"
  exit "$status"
}
trap cleanup EXIT INT TERM

for command in sqlite3 curl openssl bun; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "error: $command is required" >&2
    exit 1
  }
done

[[ -f "$SOURCE_BACKUP/blinkora.sqlite3" ]] || {
  echo "error: verified M2 source backup is missing: $SOURCE_BACKUP/blinkora.sqlite3" >&2
  exit 1
}
[[ -f "$SOURCE_BACKUP/blinkora.env" ]] || {
  echo "error: M2 environment sidecar is missing: $SOURCE_BACKUP/blinkora.env" >&2
  exit 1
}
[[ -x "$RUNTIME_HOME/bin/blinkora-server" ]] || {
  echo "error: local Blinkora runtime is missing: $RUNTIME_HOME/bin/blinkora-server" >&2
  exit 1
}
[[ -d "$RUNTIME_HOME/release/public" && -f "$RUNTIME_HOME/release/db/schema.sqlite.sql" ]] || {
  echo "error: local Blinkora release assets are incomplete" >&2
  exit 1
}
if [[ "$PORT" == "6676" || "$RESTORE_PORT" == "6676" ]]; then
  echo "error: M2 clone smoke refuses the persistent service port 6676" >&2
  exit 1
fi
for candidate_port in "$PORT" "$RESTORE_PORT"; do
  if lsof -nP -iTCP:"$candidate_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "error: M2 clone smoke port $candidate_port is already in use" >&2
    exit 1
  fi
done

ORIGINAL_SECRET="$(awk -F= '$1 == "BLINKORA_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "$SOURCE_BACKUP/blinkora.env")"
[[ -n "$ORIGINAL_SECRET" ]] || {
  echo "error: M2 environment sidecar has no BLINKORA_SECRET" >&2
  exit 1
}

mkdir -p "$DATA_DIR"
chmod 700 "$APP_HOME" "$DATA_DIR"
bash "$ROOT_DIR/scripts/sqlite-restore.sh" --backup "$SOURCE_BACKUP" --data-dir "$DATA_DIR"
DB_PATH="$DATA_DIR/blinkora.sqlite3"

# The real-data clone must never resolve or mutate existing S3 attachment keys.
# S3 is tested separately against an empty database and a new isolated prefix.
sqlite3 "$DB_PATH" <<'SQL'
UPDATE config SET config=json_object('value', 'local') WHERE key='objectStorage';
UPDATE config SET config=json_object('value', '')
WHERE key IN (
  's3AccessKeyId',
  's3AccessKeySecret',
  's3SecretAccessKey',
  's3Bucket',
  's3CustomPath',
  's3Endpoint',
  's3Region'
);
SQL

[[ "$(sqlite3 "$DB_PATH" "SELECT json_extract(config, '$.value') FROM config WHERE key='objectStorage' LIMIT 1;")" == "local" ]] || {
  echo "error: M2 clone could not detach object storage" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM config WHERE key LIKE 's3%' AND key <> 's3ForcePathStyle' AND COALESCE(json_extract(config, '$.value'), '') <> '';")" == "0" ]] || {
  echo "error: M2 clone still contains active S3 connection values" >&2
  exit 1
}

ACCOUNT_TOKEN="$(sqlite3 "$DB_PATH" 'SELECT "apiToken" FROM accounts WHERE "apiToken" <> "" ORDER BY id LIMIT 1;')"
WORKSPACE_TOKEN="$(sqlite3 "$DB_PATH" 'SELECT token FROM "agentAccessTokens" WHERE token IS NOT NULL AND token <> "" AND "revokedAt" IS NULL ORDER BY id LIMIT 1;')"
[[ -n "$ACCOUNT_TOKEN" && -n "$WORKSPACE_TOKEN" ]] || {
  echo "error: migrated account or Workspace token is unavailable in the clone" >&2
  exit 1
}

fixture_count() {
  sqlite3 "$DB_PATH" "
    SELECT
      (SELECT COUNT(*) FROM workspaces WHERE name LIKE 'M2 clone workspace %' OR name LIKE 'Agent smoke %')
      + (SELECT COUNT(*) FROM notes WHERE content LIKE 'M2 clone %' OR content LIKE 'Agent smoke %')
      + (SELECT COUNT(*) FROM attachments WHERE name LIKE 'm2-clone-%' OR name LIKE 'agent-readable-%')
      + (SELECT COUNT(*) FROM \"agentAccessTokens\" WHERE name LIKE 'Agent smoke token %' OR name LIKE 'Agent smoke refreshed token %');
  "
}
BASELINE_FIXTURE_COUNT="$(fixture_count)"

wait_for_health() {
  local port="$1"
  for _ in {1..30}; do
    if curl --fail --silent --connect-timeout 1 --max-time 2 "http://127.0.0.1:$port/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

PORT="$PORT" \
DATA_DIR="$DATA_DIR" \
PUBLIC_PATH="$RUNTIME_HOME/release/public" \
SCHEMA_PATH="$RUNTIME_HOME/release/db/schema.sqlite.sql" \
BLINKORA_SECRET="$ORIGINAL_SECRET" \
RUST_LOG=warn \
"$RUNTIME_HOME/bin/blinkora-server" >"$APP_HOME/server.log" 2>&1 &
SERVER_PID=$!
wait_for_health "$PORT" || {
  echo "error: isolated M2 clone service did not become healthy" >&2
  exit 1
}

cd "$ROOT_DIR"
BLINKORA_BASE_URL="http://127.0.0.1:$PORT" \
BLINKORA_BROWSER_SMOKE_ISOLATED=1 \
BLINKORA_BROWSER_SMOKE_SCENARIO=m2-clone \
BLINKORA_BROWSER_SMOKE_ACCOUNT_TOKEN="$ACCOUNT_TOKEN" \
bun run smoke:browser

BLINKORA_BASE_URL="http://127.0.0.1:$PORT" \
BLINKORA_ACCOUNT_TOKEN="$ACCOUNT_TOKEN" \
bun run smoke:agent

[[ "$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')" == "ok" ]] || {
  echo "error: M2 clone integrity_check failed after browser and MCP smoke" >&2
  exit 1
}
[[ -z "$(sqlite3 "$DB_PATH" 'PRAGMA foreign_key_check;')" ]] || {
  echo "error: M2 clone foreign_key_check reported rows" >&2
  exit 1
}
[[ "$(sqlite3 "$DB_PATH" '
  SELECT
    (SELECT COUNT(*) FROM notes n LEFT JOIN workspaces w ON w.id=n."workspaceId" WHERE n."workspaceId" IS NOT NULL AND w.id IS NULL)
    + (SELECT COUNT(*) FROM tag t LEFT JOIN workspaces w ON w.id=t."workspaceId" WHERE t."workspaceId" IS NOT NULL AND w.id IS NULL)
    + (SELECT COUNT(*) FROM "tagsToNote" x LEFT JOIN tag t ON t.id=x."tagId" LEFT JOIN notes n ON n.id=x."noteId" WHERE t.id IS NULL OR n.id IS NULL)
    + (SELECT COUNT(*) FROM comments c LEFT JOIN notes n ON n.id=c."noteId" WHERE n.id IS NULL)
    + (SELECT COUNT(*) FROM attachments a LEFT JOIN notes n ON n.id=a."noteId" WHERE a."noteId" IS NOT NULL AND n.id IS NULL)
    + (SELECT COUNT(*) FROM "noteHistory" h LEFT JOIN notes n ON n.id=h."noteId" WHERE n.id IS NULL)
    + (SELECT COUNT(*) FROM "noteReference" r LEFT JOIN notes f ON f.id=r."fromNoteId" LEFT JOIN notes t ON t.id=r."toNoteId" WHERE f.id IS NULL OR t.id IS NULL);
')" == "0" ]] || {
  echo "error: M2 clone smoke left orphan rows" >&2
  exit 1
}
[[ "$(fixture_count)" == "$BASELINE_FIXTURE_COUNT" ]] || {
  echo "error: M2 clone smoke fixtures were not fully cleaned" >&2
  exit 1
}

kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" >/dev/null 2>&1 || true
SERVER_PID=""

bash "$ROOT_DIR/scripts/sqlite-backup.sh" --offline --data-dir "$DATA_DIR" --output "$BACKUP_DIR"
cp "$SOURCE_BACKUP/blinkora.env" "$BACKUP_DIR/blinkora.env"
chmod 600 "$BACKUP_DIR/blinkora.env"
bash "$ROOT_DIR/scripts/sqlite-restore.sh" --backup "$BACKUP_DIR" --data-dir "$RESTORE_DIR"

[[ "$(sqlite3 "$RESTORE_DIR/blinkora.sqlite3" 'PRAGMA integrity_check;')" == "ok" ]] || {
  echo "error: restored M2 clone integrity_check failed" >&2
  exit 1
}
[[ -z "$(sqlite3 "$RESTORE_DIR/blinkora.sqlite3" 'PRAGMA foreign_key_check;')" ]] || {
  echo "error: restored M2 clone foreign_key_check reported rows" >&2
  exit 1
}

PORT="$RESTORE_PORT" \
DATA_DIR="$RESTORE_DIR" \
PUBLIC_PATH="$RUNTIME_HOME/release/public" \
SCHEMA_PATH="$RUNTIME_HOME/release/db/schema.sqlite.sql" \
BLINKORA_SECRET="$ORIGINAL_SECRET" \
RUST_LOG=warn \
"$RUNTIME_HOME/bin/blinkora-server" >"$APP_HOME/restored-server.log" 2>&1 &
RESTORE_PID=$!
wait_for_health "$RESTORE_PORT" || {
  echo "error: restored M2 clone service did not become healthy" >&2
  exit 1
}
curl --fail --silent --output /dev/null \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  "http://127.0.0.1:$RESTORE_PORT/api/auth/profile"
curl --fail --silent --output /dev/null \
  -H "Authorization: Bearer $WORKSPACE_TOKEN" \
  "http://127.0.0.1:$RESTORE_PORT/api/agent/mcp-guide.md"

kill "$RESTORE_PID" >/dev/null 2>&1 || true
wait "$RESTORE_PID" >/dev/null 2>&1 || true
RESTORE_PID=""

echo "M2 read-only clone smoke passed: real migrated structure, isolated local writes, browser, MCP, integrity, cleanup, backup, restore, account token, and Workspace token"
