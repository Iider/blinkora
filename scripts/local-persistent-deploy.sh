#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
APP_HOME="${BLINKORA_LOCAL_HOME:-$HOME/.blinkora/local}"
RELEASE_DIR="$APP_HOME/release"
ENV_FILE="$APP_HOME/blinkora.env"
RUNNER="$APP_HOME/run-blinkora.sh"
LOG_DIR="$APP_HOME/logs"
DATA_DIR="$APP_HOME/data"
LOCAL_BIN_DIR="$APP_HOME/bin"
LOCAL_BIN="$LOCAL_BIN_DIR/blinkora-server"
LABEL="${BLINKORA_LAUNCHD_LABEL:-com.blinkora.local}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-6676}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/blinkora-server-target-local}"

usage() {
  cat <<EOF
Usage: scripts/local-persistent-deploy.sh <command>

Commands:
  install     Build native Blinkora, install and start the launchd service
  update      Rebuild native Blinkora and restart the launchd service
  build       Build native Blinkora release artifacts only
  start       Start the launchd service
  stop        Stop the launchd service
  restart     Restart the launchd service
  rotate-secret
              Replace BLINKORA_SECRET and restart; invalidates login/API JWTs
  status      Show launchd service status
  logs        Tail local Blinkora service logs
  uninstall   Stop the service and remove its plist; keep all local data

This installation needs no Docker. SQLite and attachments are both kept in:
  $DATA_DIR
EOF
}

require_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd is required. $hint" >&2
    exit 1
  fi
}

require_bun_and_cargo() {
  require_cmd bun "Install Bun first: https://bun.sh"
  require_cmd cargo "Install Rust first: https://rustup.rs"
}

sign_local_binary() {
  if [[ ! -x "$LOCAL_BIN" ]]; then
    echo "error: local Blinkora binary is missing: $LOCAL_BIN" >&2
    exit 1
  fi
  require_cmd codesign "Install Xcode Command Line Tools; launchd requires a signed local binary."
  # A copied Rust binary can retain Finder provenance. Re-signing the actual
  # launchd executable after clearing that metadata prevents macOS from
  # terminating it with OS_REASON_CODESIGNING.
  xattr -d com.apple.quarantine "$LOCAL_BIN" >/dev/null 2>&1 || true
  xattr -d com.apple.provenance "$LOCAL_BIN" >/dev/null 2>&1 || true
  codesign --force --sign - "$LOCAL_BIN"
  codesign --verify --strict "$LOCAL_BIN"
}

ensure_node_deps() {
  if [[ -x "$ROOT_DIR/node_modules/.bin/turbo" ]]; then
    return
  fi
  echo "node_modules is missing; running bun install"
  (cd "$ROOT_DIR" && bun install)
}

ensure_dirs() {
  umask 077
  mkdir -p "$APP_HOME" "$LOG_DIR" "$DATA_DIR" "$LOCAL_BIN_DIR" "$RELEASE_DIR" "$HOME/Library/LaunchAgents"
  chmod 700 "$APP_HOME" "$LOG_DIR" "$DATA_DIR" "$LOCAL_BIN_DIR"
}

generate_secret() {
  openssl rand -hex 32
}

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "$APP_HOME/.blinkora.env.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

remove_legacy_database_env() {
  local legacy_pattern
  local temporary
  local removed=false
  legacy_pattern='^[[:space:]]*(DATABASE_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|POSTGRES[A-Z0-9_]*)='
  temporary="$(mktemp "$APP_HOME/.blinkora.env.XXXXXX")"
  if grep -Eq "$legacy_pattern" "$ENV_FILE"; then
    removed=true
  fi
  awk -v legacy_pattern="$legacy_pattern" '
    $0 ~ legacy_pattern { next }
    { print }
  ' "$ENV_FILE" > "$temporary"
  if [[ "$removed" == true ]]; then
    echo "removed deprecated PostgreSQL settings from $ENV_FILE"
  fi
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

sync_runtime_paths() {
  set_env_value PUBLIC_PATH "$RELEASE_DIR/public"
  set_env_value SCHEMA_PATH "$RELEASE_DIR/db/schema.sqlite.sql"
}

ensure_env_file() {
  ensure_dirs
  if [[ ! -f "$ENV_FILE" ]]; then
    require_cmd openssl "macOS should include openssl; install it if missing."
    local secret
    secret="$(generate_secret)"
    cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$PORT
PUBLIC_PATH=$RELEASE_DIR/public
DATA_DIR=$DATA_DIR
SCHEMA_PATH=$RELEASE_DIR/db/schema.sqlite.sql
BLINKORA_SECRET=$secret
RUST_LOG=info
EOF
    chmod 600 "$ENV_FILE"
    echo "created $ENV_FILE"
  fi
  remove_legacy_database_env
  sync_runtime_paths
}

build_native() {
  require_bun_and_cargo
  ensure_dirs
  ensure_node_deps
  cd "$ROOT_DIR"
  bun run build:web --force
  CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo build --release --locked --manifest-path server/Cargo.toml
  cp "$CARGO_TARGET_DIR/release/blinkora-server" "$RELEASE_DIR/blinkora-server"
  cp "$CARGO_TARGET_DIR/release/blinkora-server" "$LOCAL_BIN"
  rm -rf "$RELEASE_DIR/public"
  cp -R dist/public "$RELEASE_DIR/public"
  mkdir -p "$RELEASE_DIR/db"
  cp db/schema.sqlite.sql "$RELEASE_DIR/db/schema.sqlite.sql"
  chmod +x "$RELEASE_DIR/blinkora-server" "$LOCAL_BIN"
  sign_local_binary
  echo "native release artifacts are ready in $RELEASE_DIR"
}

write_runner() {
  ensure_env_file
  if [[ ! -x "$LOCAL_BIN" && -x "$RELEASE_DIR/blinkora-server" ]]; then
    mkdir -p "$LOCAL_BIN_DIR"
    cp "$RELEASE_DIR/blinkora-server" "$LOCAL_BIN"
    chmod +x "$LOCAL_BIN"
  fi
  sign_local_binary
  cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$APP_HOME"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:\$PATH"
set -a
source "$ENV_FILE"
set +a
exec "$LOCAL_BIN"
EOF
  chmod 700 "$RUNNER"
}

write_plist() {
  write_runner
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNNER</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_HOME</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/blinkora.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/blinkora.err.log</string>
</dict>
</plist>
EOF
}

launchd_domain() {
  echo "gui/$(id -u)"
}

wait_for_service_health() {
  require_cmd curl "macOS should include curl; install it before starting Blinkora."

  local attempt=0
  local health_url="http://127.0.0.1:$PORT/health"
  while (( attempt < 30 )); do
    if curl --fail --silent --connect-timeout 1 --max-time 2 "$health_url" >/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "error: Blinkora did not become healthy within 30 seconds: $health_url" >&2
  if [[ -f "$LOG_DIR/blinkora.err.log" ]]; then
    tail -n 40 "$LOG_DIR/blinkora.err.log" >&2
  fi
  return 1
}

start_service() {
  write_plist
  local domain
  domain="$(launchd_domain)"
  launchctl bootout "$domain" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$PLIST"
  launchctl kickstart -k "$domain/$LABEL"
  wait_for_service_health || return 1
  echo "Blinkora local service started: http://localhost:$PORT"
}

stop_service() {
  local domain
  domain="$(launchd_domain)"
  launchctl bootout "$domain" "$PLIST" >/dev/null 2>&1 || true
  echo "Blinkora local service stopped"
}

status() {
  local domain
  domain="$(launchd_domain)"
  launchctl print "$domain/$LABEL" 2>/dev/null || echo "service is not loaded"
  echo
  echo "SQLite data directory: $DATA_DIR"
}

tail_logs() {
  ensure_dirs
  touch "$LOG_DIR/blinkora.out.log" "$LOG_DIR/blinkora.err.log"
  tail -f "$LOG_DIR/blinkora.out.log" "$LOG_DIR/blinkora.err.log"
}

install() {
  build_native
  ensure_env_file
  start_service
}

update() {
  build_native
  restart_service
}

restart_service() {
  stop_service
  start_service
}

rotate_secret() (
  set -Eeuo pipefail
  require_cmd openssl "macOS should include openssl; install it before rotating the auth secret."
  ensure_env_file

  local backup
  backup="$(mktemp "$APP_HOME/.blinkora.env.pre-rotation.XXXXXX")"
  cp "$ENV_FILE" "$backup"
  chmod 600 "$backup"
  local restore_required=false

  cleanup_rotation() {
    local status=$?
    local rollback_failed=false
    trap - EXIT INT TERM
    if [[ "$restore_required" == true ]]; then
      cp "$backup" "$ENV_FILE" || rollback_failed=true
      chmod 600 "$ENV_FILE" || rollback_failed=true
      stop_service >/dev/null 2>&1 || true
      if ! start_service; then
        rollback_failed=true
      fi
    fi
    rm -f "$backup"
    if [[ "$rollback_failed" == true ]]; then
      echo "error: secret rotation failed and the previous local service could not be restored" >&2
      exit 1
    fi
    exit "$status"
  }
  trap cleanup_rotation EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local new_secret
  new_secret="$(generate_secret)"
  [[ -n "$new_secret" ]] || {
    echo "error: generated BLINKORA_SECRET is empty" >&2
    return 1
  }
  set_env_value BLINKORA_SECRET "$new_secret"
  unset new_secret
  restore_required=true

  stop_service
  if ! start_service; then
    echo "error: local service rejected the new secret; restoring the previous environment" >&2
    return 1
  fi

  restore_required=false
  echo "Blinkora local auth secret rotated; existing login sessions and account API tokens are invalid"
)

uninstall() {
  stop_service
  rm -f "$PLIST"
  echo "removed $PLIST"
  echo "kept local data: $APP_HOME"
}

case "${1:-}" in
  install) install ;;
  update) update ;;
  build) build_native ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  rotate-secret) rotate_secret ;;
  status) status ;;
  logs) tail_logs ;;
  uninstall) uninstall ;;
  -h | --help | help | "") usage ;;
  *) echo "error: unknown command: $1" >&2; usage; exit 1 ;;
esac
