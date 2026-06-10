#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
APP_HOME="${BLINKORA_LOCAL_HOME:-$HOME/.blinkora/local}"
RELEASE_DIR="$ROOT_DIR/release/local"
ENV_FILE="$APP_HOME/blinkora.env"
RUNNER="$APP_HOME/run-blinkora.sh"
LOG_DIR="$APP_HOME/logs"
DATA_DIR="$APP_HOME/data"
LABEL="${BLINKORA_LAUNCHD_LABEL:-com.blinkora.local}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-6676}"
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:mysecretpassword@127.0.0.1:55433/postgres}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/blinkora-server-target-local}"

usage() {
  cat <<EOF
Usage: scripts/local-persistent-deploy.sh <command>

Commands:
  install     Build native Blinkora, start Docker PostgreSQL, install and start launchd service
  update      Rebuild native Blinkora and restart launchd service
  build       Build native Blinkora release artifacts only
  start       Start launchd service
  stop        Stop launchd service
  restart     Restart launchd service
  status      Show launchd and PostgreSQL status
  logs        Tail local Blinkora service logs
  db-up       Start Docker PostgreSQL only
  db-stop     Stop Docker PostgreSQL only
  uninstall   Stop launchd service and remove plist; keep data and database

Local app home: $APP_HOME
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

ensure_node_deps() {
  if [[ -x "$ROOT_DIR/node_modules/.bin/turbo" ]]; then
    return
  fi
  echo "node_modules is missing; running bun install"
  (cd "$ROOT_DIR" && bun install)
}

ensure_dirs() {
  mkdir -p "$APP_HOME" "$LOG_DIR" "$DATA_DIR" "$RELEASE_DIR" "$HOME/Library/LaunchAgents"
}

generate_secret() {
  openssl rand -hex 32
}

ensure_env_file() {
  ensure_dirs
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi
  require_cmd openssl "macOS should include openssl; install it if missing."
  local secret
  secret="$(generate_secret)"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$PORT
DATABASE_URL=$DATABASE_URL
PUBLIC_PATH=$RELEASE_DIR/public
DATA_DIR=$DATA_DIR
SCHEMA_PATH=$RELEASE_DIR/db/schema.sql
BLINKORA_SECRET=$secret
RUST_LOG=info
EOF
  chmod 600 "$ENV_FILE"
  echo "created $ENV_FILE"
}

build_native() {
  require_bun_and_cargo
  ensure_dirs
  ensure_node_deps
  cd "$ROOT_DIR"
  bun run build:web --force
  CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo build --release --locked --manifest-path server/Cargo.toml
  cp "$CARGO_TARGET_DIR/release/blinkora-server" "$RELEASE_DIR/blinkora-server"
  rm -rf "$RELEASE_DIR/public"
  cp -R dist/public "$RELEASE_DIR/public"
  mkdir -p "$RELEASE_DIR/db"
  cp db/schema.sql "$RELEASE_DIR/db/schema.sql"
  chmod +x "$RELEASE_DIR/blinkora-server"
  echo "native release artifacts are ready in $RELEASE_DIR"
}

db_up() {
  require_cmd docker "Install Docker or OrbStack first."
  (cd "$ROOT_DIR/docker" && docker compose up -d db)
}

db_stop() {
  require_cmd docker "Install Docker or OrbStack first."
  (cd "$ROOT_DIR/docker" && docker compose stop db)
}

stop_web_container() {
  if command -v docker >/dev/null 2>&1; then
    (cd "$ROOT_DIR/docker" && docker compose stop web >/dev/null 2>&1 || true)
  fi
}

write_runner() {
  ensure_env_file
  cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:\$PATH"
set -a
source "$ENV_FILE"
set +a
exec "$RELEASE_DIR/blinkora-server"
EOF
  chmod +x "$RUNNER"
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

start_service() {
  write_plist
  local domain
  domain="$(launchd_domain)"
  launchctl bootout "$domain" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$PLIST"
  launchctl kickstart -k "$domain/$LABEL"
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
  echo "== launchd =="
  launchctl print "$domain/$LABEL" 2>/dev/null || echo "service is not loaded"
  echo
  echo "== docker db =="
  if command -v docker >/dev/null 2>&1; then
    (cd "$ROOT_DIR/docker" && docker compose ps db)
  else
    echo "docker is not installed"
  fi
}

tail_logs() {
  ensure_dirs
  touch "$LOG_DIR/blinkora.out.log" "$LOG_DIR/blinkora.err.log"
  tail -f "$LOG_DIR/blinkora.out.log" "$LOG_DIR/blinkora.err.log"
}

install() {
  db_up
  stop_web_container
  build_native
  ensure_env_file
  start_service
}

update() {
  db_up
  stop_web_container
  build_native
  restart_service
}

restart_service() {
  stop_service
  start_service
}

uninstall() {
  stop_service
  rm -f "$PLIST"
  echo "removed $PLIST"
  echo "kept local data: $APP_HOME"
  echo "kept PostgreSQL data: $ROOT_DIR/docker/data/postgres"
}

cmd="${1:-}"
case "$cmd" in
  install) install ;;
  update) update ;;
  build) build_native ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  status) status ;;
  logs) tail_logs ;;
  db-up) db_up ;;
  db-stop) db_stop ;;
  uninstall) uninstall ;;
  -h | --help | help | "") usage ;;
  *) echo "error: unknown command: $cmd" >&2; usage; exit 1 ;;
esac
