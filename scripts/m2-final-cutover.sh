#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_HOST="${BLINKORA_M2_SOURCE_HOST:-192.168.2.25}"
SOURCE_USER="${BLINKORA_M2_SOURCE_USER:-weio}"
SOURCE_TARGET="${SOURCE_USER}@${SOURCE_HOST}"
SOURCE_ENV_FILE="${BLINKORA_M2_SOURCE_ENV_FILE:-/vol1/1000/docker/blinkora/local/blinkora.env}"
SOURCE_WEB_UNIT="${BLINKORA_M2_SOURCE_WEB_UNIT:-blinkora.service}"
SOURCE_DB_UNIT="${BLINKORA_M2_SOURCE_DB_UNIT:-blinkora-db.service}"
SOURCE_HEALTH_URL="${BLINKORA_M2_SOURCE_HEALTH_URL:-http://127.0.0.1:6676/health}"
REMOTE_ROOT="${BLINKORA_M2_REMOTE_ROOT:-.blinkora-migration}"

LOCAL_HOME="${BLINKORA_LOCAL_HOME:-$HOME/.blinkora/local}"
LOCAL_DATA="$LOCAL_HOME/data"
LOCAL_ENV="$LOCAL_HOME/blinkora.env"
LOCAL_HEALTH_URL="${BLINKORA_M2_LOCAL_HEALTH_URL:-http://127.0.0.1:6676/health}"
MIGRATIONS_ROOT="${BLINKORA_M2_MIGRATIONS_ROOT:-$HOME/.blinkora/migrations}"

MODE="dry-run"
RUN_ID=""
RTO_SECONDS=1800
HEALTH_TIMEOUT=30
PG_PORT="${BLINKORA_M2_POSTGRES_PORT:-55434}"

RUN_DIR=""
SOURCE_DIR=""
CANDIDATE_DATA=""
CANDIDATE_ENV=""
PRE_DATA=""
PRE_ENV=""
FAILED_DATA=""
FAILED_ENV=""
PRE_BACKUP=""
POST_BACKUP=""
REMOTE_RUN=""
WATCHDOG_UNIT=""
STATE_FILE=""
EVENTS_FILE=""

SOURCE_GUARD_ARMED=false
SOURCE_RECOVERY_ATTEMPTED=false
LOCAL_STOPPED=false
DATA_MOVED_TO_PRE=false
ENV_MOVED_TO_PRE=false
CANDIDATE_DATA_ACTIVE=false
CANDIDATE_ENV_ACTIVE=false
CUTOVER_COMMITTED=false
ROLLBACK_RUNNING=false
CUTOVER_DEADLINE_EPOCH=0

usage() {
  cat <<'EOF'
Usage:
  scripts/m2-final-cutover.sh
  scripts/m2-final-cutover.sh --prepare [options]
  scripts/m2-final-cutover.sh --confirm-cutover [options]

Modes:
  no arguments       Print the plan only; no network, service, or file changes
  --prepare          Run read-only source/local preflight; do not stop or move data
  --confirm-cutover  Run final snapshot, migration, isolated smoke, activation,
                     post-activation backup checks, and guarded source retirement

Options:
  --run-id <id>             Unique id; default m2-final-<UTC timestamp>
  --rto-seconds <seconds>   Remote auto-recovery budget, minimum 600 (default 1800)
  --health-timeout <secs>   Health wait per service (default 30)
  --postgres-port <port>    Local isolated PostgreSQL port (default 55434)
  -h, --help                Show this help

--confirm-cutover is only the first authorization. After the final candidate
passes migration and isolated smoke, a controlling terminal must receive the
exact text "ACTIVATE <run-id>". There is no non-interactive bypass.
EOF
}

log() {
  printf '[m2-cutover] %s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  return 1
}

set_state() {
  local state="$1"
  [[ -n "$STATE_FILE" ]] || return 0
  local temporary="${STATE_FILE}.tmp.$$"
  printf 'runId=%s\nstate=%s\nupdatedAt=%s\n' \
    "$RUN_ID" "$state" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$STATE_FILE"
  printf '%s state=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$state" >>"$EVENTS_FILE"
  chmod 600 "$EVENTS_FILE"
}

parse_args() {
  if (($# == 0)); then
    return 0
  fi
  while (($#)); do
    case "$1" in
      --prepare)
        [[ "$MODE" == "dry-run" ]] || fail "choose only one mode"
        MODE="prepare"
        shift
        ;;
      --confirm-cutover)
        [[ "$MODE" == "dry-run" ]] || fail "choose only one mode"
        MODE="execute"
        shift
        ;;
      --run-id)
        RUN_ID="${2:?--run-id requires a value}"
        shift 2
        ;;
      --rto-seconds)
        RTO_SECONDS="${2:?--rto-seconds requires a value}"
        shift 2
        ;;
      --health-timeout)
        HEALTH_TIMEOUT="${2:?--health-timeout requires a value}"
        shift 2
        ;;
      --postgres-port)
        PG_PORT="${2:?--postgres-port requires a value}"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "unknown argument: $1"
        ;;
    esac
  done
}

validate_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be an integer"
  (( value >= minimum )) || fail "$name must be at least $minimum"
}

derive_paths() {
  if [[ -z "$RUN_ID" ]]; then
    RUN_ID="m2-final-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  [[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || \
    fail "run id may contain only letters, digits, underscore, and hyphen"
  validate_integer "rto-seconds" "$RTO_SECONDS" 600
  validate_integer "health-timeout" "$HEALTH_TIMEOUT" 1
  validate_integer "postgres-port" "$PG_PORT" 1024
  (( PG_PORT <= 65535 )) || fail "postgres-port must be at most 65535"
  [[ "$PG_PORT" != "6676" ]] || fail "isolated PostgreSQL cannot use service port 6676"

  RUN_DIR="$MIGRATIONS_ROOT/$RUN_ID"
  SOURCE_DIR="$RUN_DIR/source"
  CANDIDATE_DATA="$LOCAL_HOME/data.m2-candidate-$RUN_ID"
  CANDIDATE_ENV="$LOCAL_HOME/blinkora.env.m2-candidate-$RUN_ID"
  PRE_DATA="$LOCAL_HOME/data.pre-$RUN_ID"
  PRE_ENV="$LOCAL_HOME/blinkora.env.pre-$RUN_ID"
  FAILED_DATA="$LOCAL_HOME/data.failed-$RUN_ID"
  FAILED_ENV="$LOCAL_HOME/blinkora.env.failed-$RUN_ID"
  PRE_BACKUP="$RUN_DIR/pre-activation-backup"
  POST_BACKUP="$RUN_DIR/post-activation-backup"
  REMOTE_RUN="$REMOTE_ROOT/$RUN_ID"
  WATCHDOG_UNIT="blinkora-m2-watchdog-$RUN_ID"
  STATE_FILE="$RUN_DIR/state"
  EVENTS_FILE="$RUN_DIR/events.log"
}

print_plan() {
  cat <<EOF
M2 final cutover plan (dry-run)

1. Read-only preflight both services and all required local paths.
2. Arm a ${RTO_SECONDS}s source-side systemd recovery timer, then stop only $SOURCE_WEB_UNIT.
3. Create and verify a final PostgreSQL/files/secret snapshot under $REMOTE_RUN.
4. Restore PostgreSQL locally, migrate all 14 tables, and run isolated browser/MCP/backup smoke.
5. Require exact TTY confirmation: ACTIVATE $RUN_ID
6. Back up and atomically swap local data plus BLINKORA_SECRET as one pair.
7. On any failure, restore the source first, then restore the complete local pair.
8. After final gates, disable source Web auto-start and cancel its recovery timer.

No command has connected to $SOURCE_TARGET or changed local files.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is missing: $1"
}

reject_symlink() {
  local path="$1"
  [[ ! -L "$path" ]] || fail "symbolic links are not allowed: $path"
}

device_id() {
  if stat -f '%d' "$1" >/dev/null 2>&1; then
    stat -f '%d' "$1"
  else
    stat -c '%d' "$1"
  fi
}

local_preflight() {
  for command in ssh scp base64 tr sqlite3 tar shasum pg_config cargo bun curl; do
    require_command "$command"
  done
  [[ -d "$LOCAL_HOME" ]] || fail "local deployment directory is missing: $LOCAL_HOME"
  [[ -d "$LOCAL_DATA" && -f "$LOCAL_DATA/blinkora.sqlite3" ]] || \
    fail "local data is incomplete: $LOCAL_DATA"
  [[ -f "$LOCAL_ENV" ]] || fail "local environment file is missing: $LOCAL_ENV"
  [[ "$(grep -c '^BLINKORA_SECRET=' "$LOCAL_ENV")" == "1" ]] || \
    fail "local environment must contain exactly one BLINKORA_SECRET"
  [[ -x "$LOCAL_HOME/bin/blinkora-server" ]] || \
    fail "local release binary is missing: $LOCAL_HOME/bin/blinkora-server"
  reject_symlink "$LOCAL_HOME"
  reject_symlink "$LOCAL_DATA"
  reject_symlink "$LOCAL_ENV"
  [[ "$(sqlite3 "$LOCAL_DATA/blinkora.sqlite3" 'PRAGMA integrity_check;')" == "ok" ]] || \
    fail "current local SQLite database failed integrity_check"
  [[ "$(sqlite3 "$LOCAL_DATA/blinkora.sqlite3" 'SELECT COUNT(*) FROM pragma_foreign_key_check;')" == "0" ]] || \
    fail "current local SQLite database failed foreign_key_check"
  local_health
}

remote_exec() {
  ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "$SOURCE_TARGET" "$@"
}

remote_privileged_exec() {
  local script="$1"
  shift
  local encoded
  encoded="$(printf '%s' "$script" | base64 | tr -d '\n')"
  local remote_command="sudo -v && printf '%s' '$encoded' | base64 -d | bash -s --"
  local argument
  local quoted
  for argument in "$@"; do
    printf -v quoted '%q' "$argument"
    remote_command+=" $quoted"
  done
  ssh -t -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    "$SOURCE_TARGET" "$remote_command"
}

remote_preflight() {
  remote_exec bash -s -- "$SOURCE_ENV_FILE" "$SOURCE_WEB_UNIT" "$SOURCE_DB_UNIT" "$SOURCE_HEALTH_URL" <<'REMOTE'
set -euo pipefail
env_file="$1"
web_unit="$2"
db_unit="$3"
health_url="$4"
test -f "$env_file"
test "$(grep -c '^DATABASE_URL=' "$env_file")" -eq 1
test "$(grep -c '^DATA_DIR=' "$env_file")" -eq 1
test "$(grep -c '^BLINKORA_SECRET=' "$env_file")" -eq 1
test "$(systemctl is-active "$web_unit")" = active
test "$(systemctl is-active "$db_unit")" = active
for command in base64 bash pg_dump pg_restore tar sha256sum curl systemctl systemd-run; do
  command -v "$command" >/dev/null
done
curl --fail --silent --connect-timeout 2 --max-time 5 "$health_url" >/dev/null
printf 'source preflight passed\n'
REMOTE
}

require_activation_terminal() {
  [[ -r /dev/tty && -w /dev/tty ]] || \
    fail "final cutover requires a controlling terminal for the second confirmation"
}

create_run_directory() {
  [[ ! -e "$RUN_DIR" ]] || fail "run id already exists: $RUN_DIR"
  for path in "$CANDIDATE_DATA" "$CANDIDATE_ENV" "$PRE_DATA" "$PRE_ENV" \
    "$FAILED_DATA" "$FAILED_ENV"; do
    [[ ! -e "$path" ]] || fail "cutover path already exists: $path"
  done
  umask 077
  mkdir -p "$MIGRATIONS_ROOT"
  chmod 700 "$MIGRATIONS_ROOT"
  mkdir "$RUN_DIR"
  chmod 700 "$RUN_DIR"
  : >"$EVENTS_FILE"
  chmod 600 "$EVENTS_FILE"
  set_state INIT
}

remote_stop_and_snapshot() {
  local watchdog_delay=$((RTO_SECONDS - 60))
  CUTOVER_DEADLINE_EPOCH=$(( $(date +%s) + watchdog_delay ))
  SOURCE_GUARD_ARMED=true
  local remote_script
  remote_script="$(cat <<'REMOTE'
set -Eeuo pipefail
run_id="$1"
remote_run="$2"
watchdog_unit="$3"
watchdog_delay="$4"
env_file="$5"
web_unit="$6"
db_unit="$7"
restore_source() {
  sudo -n systemctl stop "${watchdog_unit}.timer" >/dev/null 2>&1 || true
  sudo -n systemctl start "$web_unit" >/dev/null 2>&1 || true
}
trap restore_source ERR INT TERM HUP
umask 077
test ! -e "$remote_run"
mkdir -p "$remote_run"
chmod 700 "$remote_run"
enabled_state="$(systemctl is-enabled "$web_unit" 2>/dev/null || true)"
case "$enabled_state" in enabled|enabled-runtime|disabled) ;; *) exit 1 ;; esac
printf '%s\n' "$enabled_state" >"$remote_run/web-unit-enabled-state"
chmod 600 "$remote_run/web-unit-enabled-state"
sudo -n systemd-run \
  --unit="$watchdog_unit" \
  --on-active="${watchdog_delay}s" \
  /usr/bin/systemctl start "$web_unit" >/dev/null
test "$(systemctl is-active "${watchdog_unit}.timer")" = active
sudo -n systemctl stop "$web_unit"
web_state="$(systemctl is-active "$web_unit" || true)"
case "$web_state" in inactive|failed) ;; *) exit 1 ;; esac
test "$(systemctl is-active "$db_unit")" = active

database_url="$(sed -n 's/^DATABASE_URL=//p' "$env_file")"
data_dir="$(sed -n 's/^DATA_DIR=//p' "$env_file")"
secret_line="$(sed -n 's/^BLINKORA_SECRET=/BLINKORA_SECRET=/p' "$env_file")"
test -n "$database_url"
test -n "$data_dir"
test -d "$data_dir/files"
test -n "$secret_line"

pg_dump --format=custom --file="$remote_run/blinkora-postgres.dump" "$database_url"
pg_restore --list "$remote_run/blinkora-postgres.dump" >/dev/null
tar -cf "$remote_run/files.tar" -C "$data_dir" files
printf '%s\n' "$secret_line" >"$remote_run/blinkora-secret.env"
(
  cd "$remote_run"
  sha256sum blinkora-postgres.dump files.tar blinkora-secret.env >SHA256SUMS
)
chmod 600 "$remote_run"/*
test "$(systemctl is-active "$db_unit")" = active
web_state="$(systemctl is-active "$web_unit" || true)"
case "$web_state" in inactive|failed) ;; *) exit 1 ;; esac
trap - ERR INT TERM HUP
printf 'source snapshot ready: %s\n' "$run_id"
REMOTE
  )"
  remote_privileged_exec "$remote_script" \
    "$RUN_ID" "$REMOTE_RUN" "$WATCHDOG_UNIT" "$watchdog_delay" \
    "$SOURCE_ENV_FILE" "$SOURCE_WEB_UNIT" "$SOURCE_DB_UNIT"
  set_state SNAPSHOT_READY
}

copy_snapshot() {
  mkdir "$SOURCE_DIR"
  chmod 700 "$SOURCE_DIR"
  scp -q "$SOURCE_TARGET:$REMOTE_RUN/"{blinkora-postgres.dump,files.tar,blinkora-secret.env,SHA256SUMS,web-unit-enabled-state} "$SOURCE_DIR/"
  chmod 600 "$SOURCE_DIR"/*
}

verify_snapshot() {
  (
    cd "$SOURCE_DIR"
    shasum -a 256 -c SHA256SUMS
  ) >"$RUN_DIR/snapshot-checks.txt"
  chmod 600 "$RUN_DIR/snapshot-checks.txt"
  pg_restore --list "$SOURCE_DIR/blinkora-postgres.dump" >/dev/null
  local member
  while IFS= read -r member; do
    case "$member" in
      files|files/*) ;;
      *) fail "attachment archive contains an unsafe member" ;;
    esac
    [[ "$member" != *'/../'* && "$member" != '../'* && "$member" != /* ]] || \
      fail "attachment archive contains a traversal path"
  done < <(tar -tf "$SOURCE_DIR/files.tar")
  if tar -tvf "$SOURCE_DIR/files.tar" | awk 'substr($0,1,1) == "l" || substr($0,1,1) == "h" { found=1 } END { exit !found }'; then
    fail "attachment archive contains links"
  fi
  [[ "$(wc -l <"$SOURCE_DIR/blinkora-secret.env" | tr -d ' ')" == "1" ]] || \
    fail "source secret sidecar must contain exactly one line"
  grep -Eq '^BLINKORA_SECRET=.+$' "$SOURCE_DIR/blinkora-secret.env" || \
    fail "source secret sidecar is invalid"
  set_state SNAPSHOT_VERIFIED
}

postgres_bin() {
  printf '%s/%s\n' "$(pg_config --bindir)" "$1"
}

build_candidate() (
  pgdata="$RUN_DIR/pgdata"
  pgsocket="$(mktemp -d /tmp/blinkora-m2-pg.XXXXXX)"
  postgres_log="$RUN_DIR/postgres.log"
  migration_log="$RUN_DIR/migration-summary.log"
  tool_log="$RUN_DIR/migration-tool.log"
  pg_started=false
  stop_isolated_postgres() {
    if [[ "$pg_started" == true ]]; then
      "$(postgres_bin pg_ctl)" -D "$pgdata" -m fast -w stop >/dev/null 2>&1 || true
      pg_started=false
    fi
    rm -rf "$pgsocket"
  }
  trap stop_isolated_postgres EXIT

  mkdir "$CANDIDATE_DATA"
  chmod 700 "$CANDIDATE_DATA"
  tar -xf "$SOURCE_DIR/files.tar" -C "$CANDIDATE_DATA"
  find "$CANDIDATE_DATA" -type d -exec chmod 700 {} +
  find "$CANDIDATE_DATA" -type f -exec chmod 600 {} +

  "$(postgres_bin initdb)" -D "$pgdata" --auth=trust --encoding=UTF8 --no-locale >"$RUN_DIR/initdb.log"
  chmod 700 "$pgdata" "$pgsocket"
  "$(postgres_bin pg_ctl)" -D "$pgdata" \
    -o "-p $PG_PORT -h 127.0.0.1 -k $pgsocket" -l "$postgres_log" -w start
  pg_started=true
  "$(postgres_bin createuser)" -h 127.0.0.1 -p "$PG_PORT" blinkora_m2
  "$(postgres_bin createdb)" -h 127.0.0.1 -p "$PG_PORT" -O blinkora_m2 blinkora_m2
  "$(postgres_bin psql)" -h 127.0.0.1 -p "$PG_PORT" -d blinkora_m2 \
    -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public;' >/dev/null
  "$(postgres_bin pg_restore)" -h 127.0.0.1 -p "$PG_PORT" -U blinkora_m2 -d blinkora_m2 \
    --no-owner --no-privileges "$SOURCE_DIR/blinkora-postgres.dump"

  (
    cd "$ROOT_DIR"
    BLINKORA_POSTGRES_URL="postgresql://blinkora_m2@127.0.0.1:$PG_PORT/blinkora_m2" \
      cargo run --locked --manifest-path tools/postgres-to-sqlite/Cargo.toml -- \
        --data-dir "$CANDIDATE_DATA" \
        --snapshot-dir "$RUN_DIR/tool-snapshots" \
        >"$migration_log" 2>"$tool_log"
  )
  grep -E '^migration (stage|table|snapshot|attachments)=' "$migration_log" \
    >"$RUN_DIR/migration-evidence.log" || true
  chmod 600 "$RUN_DIR"/*.log "$RUN_DIR/migration-evidence.log"
)

orphan_count() {
  sqlite3 "$1" '
    SELECT
      (SELECT COUNT(*) FROM notes n LEFT JOIN workspaces w ON w.id=n."workspaceId" WHERE n."workspaceId" IS NOT NULL AND w.id IS NULL)
      + (SELECT COUNT(*) FROM tag t LEFT JOIN workspaces w ON w.id=t."workspaceId" WHERE t."workspaceId" IS NOT NULL AND w.id IS NULL)
      + (SELECT COUNT(*) FROM "tagsToNote" x LEFT JOIN tag t ON t.id=x."tagId" LEFT JOIN notes n ON n.id=x."noteId" WHERE t.id IS NULL OR n.id IS NULL)
      + (SELECT COUNT(*) FROM comments c LEFT JOIN notes n ON n.id=c."noteId" WHERE n.id IS NULL)
      + (SELECT COUNT(*) FROM attachments a LEFT JOIN notes n ON n.id=a."noteId" WHERE a."noteId" IS NOT NULL AND n.id IS NULL)
      + (SELECT COUNT(*) FROM "noteHistory" h LEFT JOIN notes n ON n.id=h."noteId" WHERE n.id IS NULL)
      + (SELECT COUNT(*) FROM "noteReference" r LEFT JOIN notes f ON f.id=r."fromNoteId" LEFT JOIN notes t ON t.id=r."toNoteId" WHERE f.id IS NULL OR t.id IS NULL);
  '
}

write_candidate_env() {
  local secret_line
  secret_line="$(<"$SOURCE_DIR/blinkora-secret.env")"
  local found=false
  umask 077
  : >"$CANDIDATE_ENV"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == BLINKORA_SECRET=* ]]; then
      printf '%s\n' "$secret_line" >>"$CANDIDATE_ENV"
      found=true
    else
      printf '%s\n' "$line" >>"$CANDIDATE_ENV"
    fi
  done <"$LOCAL_ENV"
  [[ "$found" == true ]] || printf '%s\n' "$secret_line" >>"$CANDIDATE_ENV"
  chmod 600 "$CANDIDATE_ENV"
}

validate_candidate() {
  local db="$CANDIDATE_DATA/blinkora.sqlite3"
  [[ -f "$db" ]] || fail "candidate SQLite database is missing"
  [[ "$(sqlite3 "$db" 'PRAGMA integrity_check;')" == "ok" ]] || \
    fail "candidate failed integrity_check"
  [[ "$(sqlite3 "$db" 'SELECT COUNT(*) FROM pragma_foreign_key_check;')" == "0" ]] || \
    fail "candidate failed foreign_key_check"
  [[ "$(sqlite3 "$db" 'PRAGMA user_version;')" == "2" ]] || \
    fail "candidate has an unexpected schema version"
  [[ "$(orphan_count "$db")" == "0" ]] || fail "candidate contains orphan rows"
  write_candidate_env
  reject_symlink "$CANDIDATE_DATA"
  reject_symlink "$CANDIDATE_ENV"
  [[ "$(device_id "$LOCAL_HOME")" == "$(device_id "$CANDIDATE_DATA")" ]] || \
    fail "candidate data is not on the local deployment filesystem"
  [[ "$(device_id "$LOCAL_HOME")" == "$(device_id "$CANDIDATE_ENV")" ]] || \
    fail "candidate environment is not on the local deployment filesystem"
  set_state CANDIDATE_VALID
}

run_candidate_smoke() {
  local smoke_backup="$RUN_DIR/candidate-smoke-backup"
  bash "$ROOT_DIR/scripts/sqlite-backup.sh" --offline \
    --data-dir "$CANDIDATE_DATA" --output "$smoke_backup"
  cp "$CANDIDATE_ENV" "$smoke_backup/blinkora.env"
  chmod 600 "$smoke_backup/blinkora.env"
  (
    cd "$ROOT_DIR"
    BLINKORA_M2_SOURCE_BACKUP="$smoke_backup" \
      BLINKORA_M2_RUNTIME_HOME="$LOCAL_HOME" \
      bun run smoke:m2-clone
  ) >"$RUN_DIR/candidate-smoke.log" 2>&1
  chmod 600 "$RUN_DIR/candidate-smoke.log"
  set_state CANDIDATE_SMOKE_PASSED
}

source_is_stopped() {
  remote_exec bash -s -- "$SOURCE_WEB_UNIT" "$SOURCE_DB_UNIT" "$WATCHDOG_UNIT" <<'REMOTE'
set -euo pipefail
web_unit="$1"
db_unit="$2"
watchdog_unit="$3"
web_state="$(systemctl is-active "$web_unit" || true)"
case "$web_state" in inactive|failed) ;; *) exit 1 ;; esac
test "$(systemctl is-active "$db_unit")" = active
test "$(systemctl is-active "${watchdog_unit}.timer")" = active
REMOTE
}

check_cutover_deadline() {
  local minimum_remaining="$1"
  (( CUTOVER_DEADLINE_EPOCH > 0 )) || fail "source recovery deadline is unavailable"
  local remaining=$((CUTOVER_DEADLINE_EPOCH - $(date +%s)))
  (( remaining >= minimum_remaining )) || \
    fail "less than ${minimum_remaining}s remains before automatic source recovery"
}

confirm_activation() {
  local expected="ACTIVATE $RUN_ID"
  local answer=""
  set_state AWAITING_ACTIVATION_CONFIRM
  printf '\nFinal candidate passed. Type exactly "%s" before the RTO deadline: ' "$expected" >/dev/tty
  IFS= read -r answer </dev/tty || return 1
  [[ "$answer" == "$expected" ]]
}

local_stop() {
  (cd "$ROOT_DIR" && bun run deploy:local stop)
  LOCAL_STOPPED=true
}

local_start() {
  (cd "$ROOT_DIR" && bun run deploy:local start)
  LOCAL_STOPPED=false
}

wait_for_health() {
  local url="$1"
  local attempt=0
  while (( attempt < HEALTH_TIMEOUT )); do
    if curl --fail --silent --connect-timeout 1 --max-time 2 "$url" >/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

local_health() {
  wait_for_health "$LOCAL_HEALTH_URL" || fail "local service did not become healthy"
}

backup_live() {
  bash "$ROOT_DIR/scripts/sqlite-backup.sh" --offline \
    --data-dir "$LOCAL_DATA" --output "$PRE_BACKUP"
  cp "$LOCAL_ENV" "$PRE_BACKUP/blinkora.env"
  chmod 600 "$PRE_BACKUP/blinkora.env"
}

move_path() {
  mv "$1" "$2"
}

activate_local_pair() {
  for path in "$PRE_DATA" "$PRE_ENV" "$FAILED_DATA" "$FAILED_ENV" "$PRE_BACKUP" "$POST_BACKUP"; do
    [[ ! -e "$path" ]] || fail "activation path unexpectedly exists: $path"
  done
  reject_symlink "$LOCAL_DATA"
  reject_symlink "$LOCAL_ENV"
  reject_symlink "$CANDIDATE_DATA"
  reject_symlink "$CANDIDATE_ENV"
  local device
  device="$(device_id "$LOCAL_HOME")"
  for path in "$LOCAL_DATA" "$LOCAL_ENV" "$CANDIDATE_DATA" "$CANDIDATE_ENV"; do
    [[ "$(device_id "$path")" == "$device" ]] || fail "activation pair crosses filesystems"
  done

  backup_live
  set_state LOCAL_BACKED_UP
  move_path "$LOCAL_DATA" "$PRE_DATA"
  DATA_MOVED_TO_PRE=true
  move_path "$LOCAL_ENV" "$PRE_ENV"
  ENV_MOVED_TO_PRE=true
  move_path "$CANDIDATE_DATA" "$LOCAL_DATA"
  CANDIDATE_DATA_ACTIVE=true
  move_path "$CANDIDATE_ENV" "$LOCAL_ENV"
  CANDIDATE_ENV_ACTIVE=true
  set_state LOCAL_PAIR_SWAPPED
}

post_activation_gates() {
  local db="$LOCAL_DATA/blinkora.sqlite3"
  [[ "$(sqlite3 "$db" 'PRAGMA integrity_check;')" == "ok" ]] || \
    fail "activated database failed integrity_check"
  [[ "$(sqlite3 "$db" 'SELECT COUNT(*) FROM pragma_foreign_key_check;')" == "0" ]] || \
    fail "activated database failed foreign_key_check"
  [[ "$(orphan_count "$db")" == "0" ]] || fail "activated database contains orphan rows"

  (cd "$ROOT_DIR" && bun run deploy:local stop)
  LOCAL_STOPPED=true
  bash "$ROOT_DIR/scripts/sqlite-backup.sh" --offline \
    --data-dir "$LOCAL_DATA" --output "$POST_BACKUP"
  cp "$LOCAL_ENV" "$POST_BACKUP/blinkora.env"
  chmod 600 "$POST_BACKUP/blinkora.env"
  local restore_dir="$RUN_DIR/post-activation-restore"
  bash "$ROOT_DIR/scripts/sqlite-restore.sh" --backup "$POST_BACKUP" --data-dir "$restore_dir"
  [[ "$(sqlite3 "$restore_dir/blinkora.sqlite3" 'PRAGMA integrity_check;')" == "ok" ]] || \
    fail "post-activation restore failed integrity_check"
  [[ "$(sqlite3 "$restore_dir/blinkora.sqlite3" 'SELECT COUNT(*) FROM pragma_foreign_key_check;')" == "0" ]] || \
    fail "post-activation restore failed foreign_key_check"
  local_start
  local_health
  set_state FINAL_GATES_PASSED
}

remote_commit() {
  local remote_script
  remote_script="$(cat <<'REMOTE'
set -euo pipefail
remote_run="$1"
watchdog_unit="$2"
web_unit="$3"
initial_state="$(cat "$remote_run/web-unit-enabled-state")"
case "$initial_state" in enabled|enabled-runtime|disabled) ;; *) exit 1 ;; esac
if [[ "$initial_state" == enabled || "$initial_state" == enabled-runtime ]]; then
  sudo -n systemctl disable "$web_unit" >/dev/null
fi
sudo -n systemctl stop "${watchdog_unit}.timer" >/dev/null
sudo -n systemctl stop "${watchdog_unit}.service" >/dev/null 2>&1 || true
sudo -n systemctl reset-failed "${watchdog_unit}.service" >/dev/null 2>&1 || true
test "$(systemctl is-active "${watchdog_unit}.timer" || true)" != active
web_state="$(systemctl is-active "$web_unit" || true)"
case "$web_state" in inactive|failed) ;; *) exit 1 ;; esac
enabled_state="$(systemctl is-enabled "$web_unit" 2>/dev/null || true)"
test "$enabled_state" = disabled
REMOTE
  )"
  remote_privileged_exec "$remote_script" "$REMOTE_RUN" "$WATCHDOG_UNIT" "$SOURCE_WEB_UNIT"
  SOURCE_GUARD_ARMED=false
}

remote_recover() {
  [[ "$SOURCE_GUARD_ARMED" == true ]] || return 0
  [[ "$SOURCE_RECOVERY_ATTEMPTED" == false ]] || return 0
  SOURCE_RECOVERY_ATTEMPTED=true
  local remote_script
  remote_script="$(cat <<'REMOTE'
set -euo pipefail
remote_run="$1"
watchdog_unit="$2"
web_unit="$3"
health_url="$4"
sudo -n systemctl stop "${watchdog_unit}.timer" >/dev/null 2>&1 || true
sudo -n systemctl stop "${watchdog_unit}.service" >/dev/null 2>&1 || true
if test -f "$remote_run/web-unit-enabled-state"; then
  initial_state="$(cat "$remote_run/web-unit-enabled-state")"
  case "$initial_state" in
    enabled) sudo -n systemctl enable "$web_unit" >/dev/null ;;
    enabled-runtime) sudo -n systemctl enable --runtime "$web_unit" >/dev/null ;;
    disabled) sudo -n systemctl disable "$web_unit" >/dev/null 2>&1 || true ;;
    *) exit 1 ;;
  esac
fi
sudo -n systemctl reset-failed "$web_unit" >/dev/null 2>&1 || true
sudo -n systemctl start "$web_unit"
for ((attempt = 0; attempt < 30; attempt++)); do
  if curl --fail --silent --connect-timeout 1 --max-time 2 "$health_url" >/dev/null; then
    exit 0
  fi
  sleep 1
done
exit 1
REMOTE
  )"
  remote_privileged_exec "$remote_script" \
    "$REMOTE_RUN" "$WATCHDOG_UNIT" "$SOURCE_WEB_UNIT" "$SOURCE_HEALTH_URL"
}

remote_hold_source() {
  [[ "$SOURCE_GUARD_ARMED" == true ]] || return 0
  local remote_script
  remote_script="$(cat <<'REMOTE'
set -euo pipefail
watchdog_unit="$1"
web_unit="$2"
sudo -n systemctl stop "${watchdog_unit}.timer" >/dev/null
sudo -n systemctl stop "${watchdog_unit}.service" >/dev/null 2>&1 || true
web_state="$(systemctl is-active "$web_unit" || true)"
case "$web_state" in inactive|failed) ;; *) exit 1 ;; esac
REMOTE
  )"
  remote_privileged_exec "$remote_script" "$WATCHDOG_UNIT" "$SOURCE_WEB_UNIT"
  SOURCE_GUARD_ARMED=false
}

rollback_local_pair() {
  local failed=false
  if [[ "$LOCAL_STOPPED" == false ]] && \
    { [[ "$CANDIDATE_DATA_ACTIVE" == true ]] || [[ "$CANDIDATE_ENV_ACTIVE" == true ]]; }; then
    if ! local_stop; then
      fail "could not stop the local candidate; refusing to move live data during rollback"
      return 1
    fi
  fi

  if [[ "$CANDIDATE_DATA_ACTIVE" == true && -e "$LOCAL_DATA" ]]; then
    [[ ! -e "$FAILED_DATA" ]] && move_path "$LOCAL_DATA" "$FAILED_DATA" || failed=true
    CANDIDATE_DATA_ACTIVE=false
  fi
  if [[ "$CANDIDATE_ENV_ACTIVE" == true && -e "$LOCAL_ENV" ]]; then
    [[ ! -e "$FAILED_ENV" ]] && move_path "$LOCAL_ENV" "$FAILED_ENV" || failed=true
    CANDIDATE_ENV_ACTIVE=false
  fi
  if [[ "$DATA_MOVED_TO_PRE" == true && -e "$PRE_DATA" && ! -e "$LOCAL_DATA" ]]; then
    move_path "$PRE_DATA" "$LOCAL_DATA" || failed=true
    DATA_MOVED_TO_PRE=false
  fi
  if [[ "$ENV_MOVED_TO_PRE" == true && -e "$PRE_ENV" && ! -e "$LOCAL_ENV" ]]; then
    move_path "$PRE_ENV" "$LOCAL_ENV" || failed=true
    ENV_MOVED_TO_PRE=false
  fi

  if [[ "$failed" == true || ! -d "$LOCAL_DATA" || ! -f "$LOCAL_ENV" ]]; then
    fail "local pair rollback is incomplete; local service remains stopped"
    return 1
  fi
  if [[ "$LOCAL_STOPPED" == true ]]; then
    local_start
    local_health
  fi
}

rollback() {
  local original_status="${1:-1}"
  [[ "$CUTOVER_COMMITTED" == false ]] || return "$original_status"
  [[ "$ROLLBACK_RUNNING" == false ]] || return "$original_status"
  ROLLBACK_RUNNING=true
  trap - ERR INT TERM HUP EXIT
  [[ -z "$STATE_FILE" || ! -d "$RUN_DIR" ]] || set_state ROLLING_BACK || true

  local rollback_failed=false
  local local_stop_failed=false
  if [[ "$CANDIDATE_DATA_ACTIVE" == true || "$CANDIDATE_ENV_ACTIVE" == true ]] && \
    [[ "$LOCAL_STOPPED" == false ]]; then
    if ! local_stop && ! local_stop; then
      local_stop_failed=true
      rollback_failed=true
    fi
  fi
  if [[ "$local_stop_failed" == true ]]; then
    remote_hold_source || rollback_failed=true
  else
    remote_recover || rollback_failed=true
    rollback_local_pair || rollback_failed=true
  fi

  if [[ -n "$STATE_FILE" && -d "$RUN_DIR" ]]; then
    if [[ "$rollback_failed" == true ]]; then
      set_state ROLLBACK_FAILED || true
    else
      set_state ROLLED_BACK || true
    fi
  fi
  if [[ "$rollback_failed" == true ]]; then
    printf 'error: automatic rollback was incomplete; keep all *.pre-* and *.failed-* paths and inspect %s\n' "$RUN_DIR" >&2
    return 1
  fi
  return "$original_status"
}

run_prepare() {
  local_preflight
  remote_preflight
  log "Read-only preflight passed. No service or data was changed."
}

run_execute() {
  require_activation_terminal
  local_preflight
  remote_preflight
  create_run_directory
  trap 'status=$?; rollback "$status"; exit $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  trap 'exit $?' ERR

  set_state PREFLIGHT_OK
  remote_stop_and_snapshot
  copy_snapshot
  verify_snapshot
  build_candidate
  validate_candidate
  run_candidate_smoke
  source_is_stopped
  confirm_activation || fail "activation confirmation was refused or unavailable"
  source_is_stopped
  check_cutover_deadline 300

  local_stop
  activate_local_pair
  local_start
  local_health
  set_state LOCAL_HEALTHY
  check_cutover_deadline 240
  post_activation_gates
  source_is_stopped
  remote_commit
  set_state CUTOVER_COMMITTED
  CUTOVER_COMMITTED=true
  trap - EXIT ERR INT TERM HUP
  log "Cutover committed. Source PostgreSQL and snapshots were retained; source Web auto-start is disabled."
}

main() {
  parse_args "$@"
  derive_paths
  case "$MODE" in
    dry-run) print_plan ;;
    prepare) run_prepare ;;
    execute) run_execute ;;
    *) fail "internal mode error" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
