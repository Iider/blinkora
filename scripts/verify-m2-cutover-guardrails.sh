#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CUTOVER_SCRIPT="$ROOT_DIR/scripts/m2-final-cutover.sh"
CASE_COUNT=0
CLEANUP_ROOTS=()

cleanup() {
  local path
  for path in "${CLEANUP_ROOTS[@]}"; do
    case "$path" in
      "${TMPDIR:-/tmp}"/blinkora-m2-*|/tmp/blinkora-m2-*) rm -rf -- "$path" ;;
    esac
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail_test() {
  printf 'guardrail test failed: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  grep -Fq "$2" "$1" || fail_test "$1 does not contain $2"
}

assert_not_contains() {
  ! grep -R -Fq "$2" "$1" || fail_test "$1 leaked a protected value"
}

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

run_case() {
  local name="$1"
  local expected="$2"
  local fault="${3:-none}"
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-m2-guard.XXXXXX")"
  CLEANUP_ROOTS+=("$root")
  local status=0

  set +e
  (
    set -Eeuo pipefail
    source "$CUTOVER_SCRIPT"
    HOME="$root/home"
    LOCAL_HOME="$root/local"
    LOCAL_DATA="$LOCAL_HOME/data"
    LOCAL_ENV="$LOCAL_HOME/blinkora.env"
    MIGRATIONS_ROOT="$root/migrations"
    RUN_ID="guard-$name"
    MODE="execute"
    HEALTH_TIMEOUT=1
    RTO_SECONDS=600
    PG_PORT=15544
    derive_paths
    mkdir -p "$LOCAL_DATA/files" "$LOCAL_HOME/bin" "$MIGRATIONS_ROOT"
    printf 'old-data\n' >"$LOCAL_DATA/marker"
    printf 'BLINKORA_SECRET=old-secret\nDATA_DIR=%s\n' "$LOCAL_DATA" >"$LOCAL_ENV"
    chmod 700 "$LOCAL_HOME" "$LOCAL_DATA" "$LOCAL_DATA/files" "$LOCAL_HOME/bin" "$MIGRATIONS_ROOT"
    chmod 600 "$LOCAL_ENV" "$LOCAL_DATA/marker"
    : >"$LOCAL_DATA/blinkora.sqlite3"
    : >"$LOCAL_HOME/bin/blinkora-server"
    chmod 700 "$LOCAL_HOME/bin/blinkora-server"
    CALLS="$root/calls"
    : >"$CALLS"
    LOCAL_STOP_CALLS=0

    require_activation_terminal() { :; }
    local_preflight() { printf 'local-preflight\n' >>"$CALLS"; }
    remote_preflight() { printf 'remote-preflight\n' >>"$CALLS"; }
    remote_stop_and_snapshot() {
      printf 'remote-stop-snapshot\n' >>"$CALLS"
      SOURCE_GUARD_ARMED=true
      set_state SNAPSHOT_READY
    }
    copy_snapshot() {
      mkdir "$SOURCE_DIR"
      printf 'BLINKORA_SECRET=new-secret\n' >"$SOURCE_DIR/blinkora-secret.env"
      chmod 600 "$SOURCE_DIR/blinkora-secret.env"
    }
    verify_snapshot() { set_state SNAPSHOT_VERIFIED; }
    build_candidate() {
      [[ "$fault" != candidate ]] || return 1
      mkdir -p "$CANDIDATE_DATA/files"
      printf 'new-data\n' >"$CANDIDATE_DATA/marker"
      : >"$CANDIDATE_DATA/blinkora.sqlite3"
      chmod 700 "$CANDIDATE_DATA" "$CANDIDATE_DATA/files"
      chmod 600 "$CANDIDATE_DATA/marker" "$CANDIDATE_DATA/blinkora.sqlite3"
    }
    validate_candidate() {
      write_candidate_env
      set_state CANDIDATE_VALID
    }
    run_candidate_smoke() { set_state CANDIDATE_SMOKE_PASSED; }
    source_is_stopped() { printf 'source-stopped\n' >>"$CALLS"; }
    confirm_activation() {
      set_state AWAITING_ACTIVATION_CONFIRM
      if [[ "$fault" == signal ]]; then
        sh -c 'kill -TERM "$PPID"'
        sleep 5
      fi
      [[ "$fault" != reject ]]
    }
    local_stop() {
      LOCAL_STOP_CALLS=$((LOCAL_STOP_CALLS + 1))
      printf 'local-stop\n' >>"$CALLS"
      if [[ "$fault" == rollback-stop && "$LOCAL_STOP_CALLS" -ge 2 ]]; then
        return 1
      fi
      LOCAL_STOPPED=true
    }
    local_start() { printf 'local-start\n' >>"$CALLS"; LOCAL_STOPPED=false; }
    local_health() {
      printf 'local-health\n' >>"$CALLS"
      [[ "$fault" != health && "$fault" != rollback-stop || -f "$root/health-failed" ]] || {
        : >"$root/health-failed"
        return 1
      }
    }
    backup_live() {
      mkdir "$PRE_BACKUP"
      cp "$LOCAL_DATA/marker" "$PRE_BACKUP/marker"
      cp "$LOCAL_ENV" "$PRE_BACKUP/blinkora.env"
      chmod 700 "$PRE_BACKUP"
      chmod 600 "$PRE_BACKUP"/*
    }
    move_path() {
      if [[ "$fault" == second-move && "$1" == "$LOCAL_ENV" ]]; then
        return 1
      fi
      if [[ "$fault" == candidate-data-move && "$1" == "$CANDIDATE_DATA" ]]; then
        return 1
      fi
      if [[ "$fault" == candidate-env-move && "$1" == "$CANDIDATE_ENV" ]]; then
        return 1
      fi
      mv "$1" "$2"
    }
    post_activation_gates() { set_state FINAL_GATES_PASSED; }
    remote_commit() { printf 'remote-commit\n' >>"$CALLS"; SOURCE_GUARD_ARMED=false; }
    remote_recover() {
      [[ "$SOURCE_GUARD_ARMED" == true && "$SOURCE_RECOVERY_ATTEMPTED" == false ]] || return 0
      SOURCE_RECOVERY_ATTEMPTED=true
      printf 'remote-recover\n' >>"$CALLS"
    }
    remote_hold_source() {
      printf 'remote-hold\n' >>"$CALLS"
      SOURCE_GUARD_ARMED=false
    }
    check_cutover_deadline() { :; }

    if [[ "$fault" == conflict ]]; then
      mkdir "$PRE_DATA"
    fi
    run_execute
  ) >"$root/output" 2>&1
  status=$?
  set -e

  case "$expected" in
    success)
      [[ "$status" == 0 ]] || fail_test "$name unexpectedly failed"
      assert_file_contains "$root/local/data/marker" "new-data"
      assert_file_contains "$root/local/data.pre-guard-$name/marker" "old-data"
      assert_file_contains "$root/local/blinkora.env" "BLINKORA_SECRET=new-secret"
      assert_file_contains "$root/calls" "remote-commit"
      ! grep -Fq 'remote-recover' "$root/calls" || fail_test "$name recovered the source after success"
      [[ "$(mode_of "$root/local/data")" == 700 ]] || fail_test "$name activated data with unsafe permissions"
      [[ "$(mode_of "$root/local/blinkora.env")" == 600 ]] || fail_test "$name activated env with unsafe permissions"
      [[ "$(mode_of "$root/migrations/guard-$name/state")" == 600 ]] || fail_test "$name state has unsafe permissions"
      [[ "$(mode_of "$root/migrations/guard-$name/events.log")" == 600 ]] || fail_test "$name event log has unsafe permissions"
      ;;
    rollback)
      [[ "$status" != 0 ]] || fail_test "$name unexpectedly succeeded"
      assert_file_contains "$root/local/data/marker" "old-data"
      assert_file_contains "$root/local/blinkora.env" "BLINKORA_SECRET=old-secret"
      [[ "$(grep -Fc 'remote-recover' "$root/calls")" == 1 ]] || fail_test "$name did not recover source exactly once"
      if [[ "$fault" == health || "$fault" == candidate-env-move ]]; then
        [[ -d "$root/local/data.failed-guard-$name" ]] || fail_test "$name did not retain failed candidate data"
      fi
      ;;
    rollback-failed)
      [[ "$status" != 0 ]] || fail_test "$name unexpectedly succeeded"
      assert_file_contains "$root/local/data/marker" "new-data"
      assert_file_contains "$root/calls" "remote-hold"
      ! grep -Fq 'remote-recover' "$root/calls" || fail_test "$name created a second primary after local stop failure"
      assert_file_contains "$root/migrations/guard-$name/state" "state=ROLLBACK_FAILED"
      ;;
    reject-before-stop)
      [[ "$status" != 0 ]] || fail_test "$name unexpectedly succeeded"
      ! grep -Fq 'remote-stop-snapshot' "$root/calls" || fail_test "$name stopped source before rejecting conflict"
      assert_file_contains "$root/local/data/marker" "old-data"
      ;;
  esac
  assert_not_contains "$root/output" "old-secret"
  assert_not_contains "$root/output" "new-secret"
  assert_not_contains "$root/calls" "old-secret"
  assert_not_contains "$root/calls" "new-secret"
  if [[ -d "$root/migrations" ]]; then
    if find "$root/migrations" -type f \( -name state -o -name events.log \) \
      -exec grep -Fl 'old-secret' {} + | grep -q .; then
      fail_test "$name leaked the old secret into state"
    fi
    if find "$root/migrations" -type f \( -name state -o -name events.log \) \
      -exec grep -Fl 'new-secret' {} + | grep -q .; then
      fail_test "$name leaked the new secret into state"
    fi
  fi
  rm -rf "$root"
  CASE_COUNT=$((CASE_COUNT + 1))
}

dry_root="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-m2-dry.XXXXXX")"
CLEANUP_ROOTS+=("$dry_root")
HOME="$dry_root" bash "$CUTOVER_SCRIPT" --run-id guard-dry >"$dry_root/output"
[[ "$(find "$dry_root" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" == 1 ]] || \
  fail_test "dry-run changed local files"
assert_file_contains "$dry_root/output" "No command has connected"
rm -rf "$dry_root"
CASE_COUNT=$((CASE_COUNT + 1))

prepare_root="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-m2-prepare.XXXXXX")"
CLEANUP_ROOTS+=("$prepare_root")
(
  source "$CUTOVER_SCRIPT"
  MODE=prepare
  RUN_ID=guard-prepare
  LOCAL_HOME="$prepare_root/local"
  LOCAL_DATA="$LOCAL_HOME/data"
  LOCAL_ENV="$LOCAL_HOME/blinkora.env"
  MIGRATIONS_ROOT="$prepare_root/migrations"
  derive_paths
  local_preflight() { printf 'local-preflight\n' >>"$prepare_root/calls"; }
  remote_preflight() { printf 'remote-preflight\n' >>"$prepare_root/calls"; }
  run_prepare
) >"$prepare_root/output"
[[ ! -e "$prepare_root/migrations" ]] || fail_test "prepare mode created a migration directory"
[[ "$(wc -l <"$prepare_root/calls" | tr -d ' ')" == 2 ]] || fail_test "prepare mode changed a service"
rm -rf "$prepare_root"
CASE_COUNT=$((CASE_COUNT + 1))

grep -Fq 'sha256sum blinkora-postgres.dump files.tar blinkora-secret.env' "$CUTOVER_SCRIPT" || \
  fail_test "snapshot manifest does not use portable basenames"
CASE_COUNT=$((CASE_COUNT + 1))

privileged_root="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-m2-privileged.XXXXXX")"
CLEANUP_ROOTS+=("$privileged_root")
(
  source "$CUTOVER_SCRIPT"
  SOURCE_TARGET=guard@example.invalid
  ssh() { printf '%s\n' "$@" >"$privileged_root/ssh-args"; }
  remote_privileged_exec $'exit 0\n' 'argument with space'
)
privileged_command="$(tail -n 1 "$privileged_root/ssh-args")"
[[ "$privileged_command" == *'sudo -v && '* ]] || fail_test "privileged helper does not authorize sudo in its SSH TTY"
[[ "$privileged_command" == *'bash -s -- argument\ with\ space' ]] || fail_test "privileged helper does not preserve argument boundaries"
encoded_script="$(printf '%s\n' "$privileged_command" | awk -F"'" '{ print $4 }')"
[[ "$(printf '%s' "$encoded_script" | base64 -d)" == 'exit 0' ]] || fail_test "privileged helper changed its remote script"
rm -rf "$privileged_root"
CASE_COUNT=$((CASE_COUNT + 1))

remote_syntax_root="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-m2-remote-syntax.XXXXXX")"
CLEANUP_ROOTS+=("$remote_syntax_root")
awk -v root="$remote_syntax_root" '
  index($0, "<<\047REMOTE\047") {
    capture = 1
    part += 1
    file = sprintf("%s/remote-%02d.sh", root, part)
    next
  }
  capture && $0 == "REMOTE" {
    close(file)
    capture = 0
    next
  }
  capture { print >file }
' "$CUTOVER_SCRIPT"
remote_part_count=0
for remote_part in "$remote_syntax_root"/remote-*.sh; do
  bash -n "$remote_part"
  remote_part_count=$((remote_part_count + 1))
done
[[ "$remote_part_count" == 6 ]] || fail_test "unexpected remote helper count: $remote_part_count"
rm -rf "$remote_syntax_root"
CASE_COUNT=$((CASE_COUNT + 1))

run_case success success
run_case candidate rollback candidate
run_case reject rollback reject
run_case conflict reject-before-stop conflict
run_case second-move rollback second-move
run_case candidate-data-move rollback candidate-data-move
run_case candidate-env-move rollback candidate-env-move
run_case health rollback health
run_case rollback-stop rollback-failed rollback-stop
run_case signal rollback signal

printf 'M2 cutover guardrails passed: %s isolated cases; no network, service, S3, or port 6676 access\n' "$CASE_COUNT"
