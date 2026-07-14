#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/sqlite-restore.sh --backup <backup-directory> --data-dir <empty-DATA_DIR>

Restore a backup made by sqlite-backup.sh into an empty Blinkora DATA_DIR.
The target is deliberately refused when it already contains a database or
attachments, preventing an accidental overwrite of a live installation.
EOF
}

backup_dir=""
data_dir=""
while (($#)); do
  case "$1" in
    --backup) backup_dir="${2:?--backup requires a value}"; shift 2 ;;
    --data-dir) data_dir="${2:?--data-dir requires a value}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$backup_dir" || -z "$data_dir" ]]; then
  echo "error: --backup and --data-dir are required" >&2
  exit 2
fi
if [[ ! -f "$backup_dir/blinkora.sqlite3" || ! -f "$backup_dir/manifest" ]]; then
  echo "error: backup is missing its SQLite database or manifest" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 is required to validate the physical backup" >&2
  exit 1
fi
if [[ "$(awk -F= '$1 == "format" { print $2 }' "$backup_dir/manifest")" != "blinkora.sqlite.physical.v1" ]]; then
  echo "error: unsupported physical backup format" >&2
  exit 1
fi
if [[ "$(sqlite3 "$backup_dir/blinkora.sqlite3" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "error: backup database failed integrity_check" >&2
  exit 1
fi
if [[ "$(sqlite3 "$backup_dir/blinkora.sqlite3" 'SELECT COUNT(*) FROM pragma_foreign_key_check;')" != "0" ]]; then
  echo "error: backup database failed foreign_key_check" >&2
  exit 1
fi
if [[ -e "$data_dir/blinkora.sqlite3" || -e "$data_dir/files" ]]; then
  echo "error: target DATA_DIR already contains Blinkora data" >&2
  exit 1
fi
if [[ ! -d "$data_dir" ]]; then
  mkdir -p "$data_dir"
elif [[ -n "$(find "$data_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "error: target DATA_DIR must be empty" >&2
  exit 1
fi

umask 077
chmod 700 "$data_dir"
cp "$backup_dir/blinkora.sqlite3" "$data_dir/blinkora.sqlite3"
if [[ -d "$backup_dir/files" ]]; then
  cp -a "$backup_dir/files" "$data_dir/files"
else
  mkdir "$data_dir/files"
fi
chmod 600 "$data_dir/blinkora.sqlite3"
find "$data_dir/files" -type d -exec chmod 700 {} +
find "$data_dir/files" -type f -exec chmod 600 {} +
echo "restore completed: $data_dir"
