#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-s3-smoke.XXXXXX")"
TARGET_DIR="${BLINKORA_SMOKE_CARGO_TARGET_DIR:-}"
REMOVE_TARGET_DIR=false
if [[ -z "$TARGET_DIR" ]]; then
  TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-s3-smoke-target.XXXXXX")"
  REMOVE_TARGET_DIR=true
fi
PORT="${BLINKORA_S3_SMOKE_PORT:-16686}"
LABEL="com.blinkora.s3-smoke-${RANDOM}"
SERVER_PID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if (( exit_code != 0 )) && [[ -f "$APP_HOME/s3-smoke-server.log" ]]; then
    echo "error: last temporary S3 smoke server log lines:" >&2
    tail -n 80 "$APP_HOME/s3-smoke-server.log" >&2 || true
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$APP_HOME"
  if [[ "$REMOVE_TARGET_DIR" == true ]]; then
    rm -rf "$TARGET_DIR"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

required_variables=(
  BLINKORA_S3_SMOKE_ENDPOINT
  BLINKORA_S3_SMOKE_REGION
  BLINKORA_S3_SMOKE_BUCKET
  BLINKORA_S3_SMOKE_ACCESS_KEY
  BLINKORA_S3_SMOKE_SECRET_KEY
)
for variable in "${required_variables[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    echo "error: $variable is required for smoke:s3-local" >&2
    exit 1
  fi
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: smoke:s3-local currently starts an isolated macOS native release only" >&2
  exit 1
fi
for command in sqlite3 curl openssl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "error: $command is required for smoke:s3-local" >&2
    exit 1
  fi
done
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65534 )); then
  echo "error: BLINKORA_S3_SMOKE_PORT must be between 1024 and 65534" >&2
  exit 1
fi
UPLOAD_BY_URL_PORT=$((PORT + 1))
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: S3 smoke port $PORT is already in use; set BLINKORA_S3_SMOKE_PORT" >&2
  exit 1
fi
if lsof -nP -iTCP:"$UPLOAD_BY_URL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: S3 smoke upload-by-URL port $UPLOAD_BY_URL_PORT is already in use; set BLINKORA_S3_SMOKE_PORT" >&2
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
"$APP_HOME/release/blinkora-server" >"$APP_HOME/s3-smoke-server.log" 2>&1 &
SERVER_PID=$!

for _ in {1..30}; do
  if curl --fail --silent --connect-timeout 1 --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
    break
  fi
  sleep 1
done
if ! curl --fail --silent --connect-timeout 1 --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "error: temporary S3 smoke service did not become healthy" >&2
  tail -n 40 "$APP_HOME/s3-smoke-server.log" >&2 || true
  exit 1
fi

STAMP="$(date +%s)-$RANDOM"
S3_CUSTOM_PATH_ROOT="${BLINKORA_S3_SMOKE_CUSTOM_PATH:-smoke}"
S3_CUSTOM_PATH_ROOT="${S3_CUSTOM_PATH_ROOT%/}"
case "/$S3_CUSTOM_PATH_ROOT/" in
  *"/blinkora/"*|*"/blinkora_local/"*)
    echo "error: smoke:s3-local refuses existing Blinkora data prefixes" >&2
    exit 1
    ;;
esac
S3_CUSTOM_PATH="${S3_CUSTOM_PATH_ROOT:+$S3_CUSTOM_PATH_ROOT/}smoke-$STAMP/"
S3_BROWSER_CUSTOM_PATH="${S3_CUSTOM_PATH}browser-$STAMP/"

BLINKORA_BASE_URL="http://127.0.0.1:$PORT" \
BLINKORA_SMOKE_USER="s3_smoke_$STAMP" \
BLINKORA_SMOKE_PASSWORD="S3Smoke!local" \
BLINKORA_S3_SMOKE_ISOLATED=1 \
BLINKORA_S3_SMOKE_CUSTOM_PATH="$S3_CUSTOM_PATH" \
BLINKORA_UPLOAD_BY_URL_HOST=127.0.0.1 \
BLINKORA_UPLOAD_BY_URL_PORT="$UPLOAD_BY_URL_PORT" \
bun run smoke:s3

BLINKORA_BASE_URL="http://127.0.0.1:$PORT" \
BLINKORA_SMOKE_USER="s3_smoke_$STAMP" \
BLINKORA_SMOKE_PASSWORD="S3Smoke!local" \
BLINKORA_S3_BROWSER_SMOKE_ISOLATED=1 \
BLINKORA_S3_SMOKE_CUSTOM_PATH="$S3_CUSTOM_PATH" \
BLINKORA_S3_BROWSER_CUSTOM_PATH="$S3_BROWSER_CUSTOM_PATH" \
bun run smoke:s3-browser

[[ "$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')" == "ok" ]] || {
  echo "error: SQLite integrity_check failed after real S3 smoke" >&2
  exit 1
}
[[ -z "$(sqlite3 "$DB_PATH" 'PRAGMA foreign_key_check;')" ]] || {
  echo "error: SQLite foreign_key_check reported rows after real S3 smoke" >&2
  exit 1
}

echo "S3 local smoke passed; temporary native service, SQLite data, and smoke objects are cleaned by the test flow"
