#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SERVICE_NAME="blinkora.service"
readonly SERVICE_USER="blinkora"
readonly SERVICE_GROUP="blinkora"
readonly INSTALL_DIR="/opt/blinkora"
readonly BINARY_PATH="$INSTALL_DIR/blinkora-server"
readonly BACKUP_DIR="$INSTALL_DIR/backups"
readonly STATE_DIR="/var/lib/blinkora"
readonly DATA_DIR="$STATE_DIR/data"
readonly CONFIG_DIR="/etc/blinkora"
readonly ENV_PATH="$CONFIG_DIR/blinkora.env"
readonly UNIT_PATH="/etc/systemd/system/$SERVICE_NAME"
readonly EXPECTED_EXEC_START="ExecStart=$BINARY_PATH"

usage() {
  cat <<'EOF'
Usage: ./install.sh <command>

Commands:
  verify-package  Verify every packaged file against MANIFEST.sha256.
  check           Verify the package and inspect Linux/systemd compatibility.
  install         Install or upgrade Blinkora. Must run as root.
  status          Show systemd state and check the local health endpoint.
  logs            Show the latest 100 systemd journal lines.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

verify_package() {
  [[ -f "$SCRIPT_DIR/MANIFEST.sha256" ]] || die "MANIFEST.sha256 is missing"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$SCRIPT_DIR" && sha256sum --check MANIFEST.sha256)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$SCRIPT_DIR" && shasum -a 256 --check MANIFEST.sha256)
  else
    die "sha256sum or shasum is required to verify this package"
  fi
}

systemd_state() {
  systemctl is-system-running 2>/dev/null || true
}

assert_supported_platform() {
  [[ "$(uname -s)" == "Linux" ]] || die "this package supports Linux only"
  case "$(uname -m)" in
    x86_64 | amd64) ;;
    *) die "this package requires x86_64 Linux; detected $(uname -m)" ;;
  esac

  require_command systemctl
  require_command journalctl
  require_command install
  require_command getent
  require_command od

  case "$(systemd_state)" in
    running | degraded | starting) ;;
    *) die "systemd is not the active service manager on this host" ;;
  esac
}

assert_safe_existing_layout() {
  local protected_path
  local passwd_entry
  local account_home
  local account_shell
  for protected_path in "$INSTALL_DIR" "$STATE_DIR" "$DATA_DIR" "$CONFIG_DIR" "$UNIT_PATH" "$BINARY_PATH" "$ENV_PATH"; do
    [[ ! -L "$protected_path" ]] || die "$protected_path must not be a symbolic link"
  done
  [[ ! -e "$UNIT_PATH" || -f "$UNIT_PATH" ]] || die "$UNIT_PATH must be a regular file"
  [[ ! -e "$BINARY_PATH" || -f "$BINARY_PATH" ]] || die "$BINARY_PATH must be a regular file"
  [[ ! -e "$ENV_PATH" || -f "$ENV_PATH" ]] || die "$ENV_PATH must be a regular file"

  if [[ -f "$UNIT_PATH" ]] && ! grep -Fxq "$EXPECTED_EXEC_START" "$UNIT_PATH"; then
    die "$UNIT_PATH uses a different ExecStart; refusing to overwrite an unknown deployment"
  fi

  if [[ -f "$ENV_PATH" ]]; then
    local configured_secret
    grep -Fxq "DATA_DIR=$DATA_DIR" "$ENV_PATH" || die "$ENV_PATH uses a different DATA_DIR; refusing to migrate an unknown deployment"
    configured_secret="$(sed -n 's/^BLINKORA_SECRET=//p' "$ENV_PATH" | tail -n 1)"
    configured_secret="${configured_secret//\"/}"
    configured_secret="${configured_secret//\'/}"
    case "$configured_secret" in
      '' | '<GENERATE_A_SECURE_SECRET>' | 'blinkora-secret-change-in-production' | 'dev-only-insecure-secret')
        die "$ENV_PATH does not define a production-safe BLINKORA_SECRET"
        ;;
    esac
  fi

  if id "$SERVICE_USER" >/dev/null 2>&1; then
    [[ "$(id -gn "$SERVICE_USER")" == "$SERVICE_GROUP" ]] || die "$SERVICE_USER exists with a different primary group"
    passwd_entry="$(getent passwd "$SERVICE_USER")"
    IFS=: read -r _ _ _ _ _ account_home account_shell <<<"$passwd_entry"
    [[ "$account_home" == "$STATE_DIR" ]] || die "$SERVICE_USER exists with a different home directory"
    case "$account_shell" in
      */nologin | /bin/false) ;;
      *) die "$SERVICE_USER exists with an interactive shell" ;;
    esac
  fi
}

preflight() {
  verify_package
  assert_supported_platform
  assert_safe_existing_layout
  echo "Preflight passed: Linux x86_64, systemd, package checksum, and existing layout are compatible."
  echo "Install path: $BINARY_PATH"
  echo "Data path: $DATA_DIR"
  echo "Default endpoint: http://127.0.0.1:6676"
}

health_port() {
  local port="6676"
  local configured_port=""
  if [[ -f "$ENV_PATH" ]]; then
    configured_port="$(sed -n 's/^PORT=//p' "$ENV_PATH" | tail -n 1)"
    configured_port="${configured_port//\"/}"
    configured_port="${configured_port//\'/}"
    if [[ "$configured_port" =~ ^[0-9]{1,5}$ ]] && ((configured_port >= 1 && configured_port <= 65535)); then
      port="$configured_port"
    fi
  fi
  printf '%s' "$port"
}

probe_health() {
  local port="$1"
  local status_line=""

  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$port/health" >/dev/null
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget --quiet --timeout=2 --output-document=/dev/null "http://127.0.0.1:$port/health"
    return
  fi

  if exec 3<>"/dev/tcp/127.0.0.1/$port"; then
    printf 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' >&3
    IFS= read -r status_line <&3 || true
    exec 3>&- 3<&-
    [[ "$status_line" == *" 200 "* ]]
    return
  fi
  return 1
}

wait_for_health() {
  local port="$1"
  local attempt
  for attempt in {1..30}; do
    if systemctl is-active --quiet "$SERVICE_NAME" && probe_health "$port"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

create_service_identity() {
  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_GROUP"
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    local nologin_shell
    nologin_shell="$(command -v nologin || true)"
    [[ -n "$nologin_shell" ]] || nologin_shell="/bin/false"
    useradd \
      --system \
      --gid "$SERVICE_GROUP" \
      --home-dir "$STATE_DIR" \
      --shell "$nologin_shell" \
      "$SERVICE_USER"
  fi
}

create_environment_if_missing() {
  [[ -e "$ENV_PATH" ]] && return 0

  local secret
  local temporary_env
  secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  [[ ${#secret} -eq 64 ]] || die "failed to generate BLINKORA_SECRET"
  temporary_env="$CONFIG_DIR/.blinkora.env.new"

  umask 077
  {
    printf 'NODE_ENV=production\n'
    printf 'BIND_ADDR=127.0.0.1\n'
    printf 'PORT=6676\n'
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'BLINKORA_SECRET=%s\n' "$secret"
    printf 'RUST_LOG=info\n'
  } >"$temporary_env"
  install -o root -g root -m 0600 "$temporary_env" "$ENV_PATH"
  rm -f "$temporary_env"
}

install_runtime() {
  [[ "$EUID" -eq 0 ]] || die "install must run as root; use: sudo ./install.sh install"
  preflight
  require_command useradd
  require_command groupadd

  local timestamp
  local previous_binary=""
  local previous_unit=""
  local had_binary=0
  local had_unit=0
  local was_active=0
  local was_enabled=0
  local rollback_pending=0
  local port

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  systemctl is-active --quiet "$SERVICE_NAME" && was_active=1
  systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null && was_enabled=1

  create_service_identity
  install -d -o root -g root -m 0755 "$INSTALL_DIR"
  install -d -o root -g root -m 0700 "$BACKUP_DIR"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$STATE_DIR" "$DATA_DIR"
  install -d -o root -g root -m 0700 "$CONFIG_DIR"
  create_environment_if_missing

  if [[ -f "$BINARY_PATH" ]]; then
    had_binary=1
    previous_binary="$BACKUP_DIR/blinkora-server.pre-$timestamp"
    install -o root -g root -m 0755 "$BINARY_PATH" "$previous_binary"
  fi
  if [[ -f "$UNIT_PATH" ]]; then
    had_unit=1
    previous_unit="$BACKUP_DIR/blinkora.service.pre-$timestamp"
    install -o root -g root -m 0644 "$UNIT_PATH" "$previous_unit"
  fi

  restore_previous_runtime() {
    trap - ERR INT TERM
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true

    if ((had_binary)); then
      install -o root -g root -m 0755 "$previous_binary" "$BINARY_PATH" || true
    else
      rm -f "$BINARY_PATH"
    fi
    if ((had_unit)); then
      install -o root -g root -m 0644 "$previous_unit" "$UNIT_PATH" || true
    else
      rm -f "$UNIT_PATH"
    fi

    systemctl daemon-reload >/dev/null 2>&1 || true
    if ((was_enabled)); then
      systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
    else
      systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
    if ((was_active)); then
      systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
    rollback_pending=0
    echo "Previous Blinkora runtime state restored; data and environment files were preserved." >&2
  }

  handle_install_error() {
    local exit_code="$1"
    if ((rollback_pending)); then
      restore_previous_runtime
    fi
    exit "$exit_code"
  }

  rollback_pending=1
  trap 'handle_install_error $?' ERR
  trap 'handle_install_error 130' INT TERM

  if ((was_active)); then
    systemctl stop "$SERVICE_NAME"
  fi

  install -o root -g root -m 0755 "$SCRIPT_DIR/blinkora-server" "$INSTALL_DIR/.blinkora-server.new"
  mv -f "$INSTALL_DIR/.blinkora-server.new" "$BINARY_PATH"
  install -o root -g root -m 0644 "$SCRIPT_DIR/blinkora.service" "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"

  port="$(health_port)"
  if ! wait_for_health "$port"; then
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
    echo "error: Blinkora did not become healthy on 127.0.0.1:$port" >&2
    restore_previous_runtime
    exit 1
  fi

  rollback_pending=0
  trap - ERR INT TERM
  echo "Blinkora installed successfully."
  echo "Version: $(tr -d '\r\n' <"$SCRIPT_DIR/VERSION")"
  echo "Service: $SERVICE_NAME"
  echo "Endpoint: http://127.0.0.1:$port"
  echo "Data: $DATA_DIR"
  echo "Configuration: $ENV_PATH"
}

show_status() {
  assert_supported_platform
  systemctl status --no-pager "$SERVICE_NAME"
  local port
  port="$(health_port)"
  if probe_health "$port"; then
    echo "Health endpoint: http://127.0.0.1:$port/health (ok)"
  else
    die "health endpoint is unavailable on 127.0.0.1:$port"
  fi
}

show_logs() {
  assert_supported_platform
  journalctl -u "$SERVICE_NAME" -n 100 --no-pager
}

case "${1:-}" in
  verify-package) verify_package ;;
  check) preflight ;;
  install) install_runtime ;;
  status) show_status ;;
  logs) show_logs ;;
  -h | --help | help) usage ;;
  *) usage >&2; exit 2 ;;
esac
