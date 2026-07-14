#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/sqlite-backup.sh --offline --data-dir <DATA_DIR> --output <backup-directory>

Create a physical Blinkora backup containing a SQLite-consistent database
snapshot and the local attachment tree. --offline is mandatory: stop the
single Blinkora service first so attachment deletion and creation cannot race
the filesystem copy. The database itself is copied with SQLite .backup, never
by copying its main file while WAL may still contain committed pages.
EOF
}

data_dir=""
output_dir=""
offline=false
while (($#)); do
  case "$1" in
    --data-dir) data_dir="${2:?--data-dir requires a value}"; shift 2 ;;
    --output) output_dir="${2:?--output requires a value}"; shift 2 ;;
    --offline) offline=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$offline" != true || -z "$data_dir" || -z "$output_dir" ]]; then
  echo "error: --offline, --data-dir and --output are required" >&2
  usage >&2
  exit 2
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 is required for a consistent SQLite backup" >&2
  exit 1
fi

source_db="$data_dir/blinkora.sqlite3"
if [[ ! -f "$source_db" ]]; then
  echo "error: SQLite database not found: $source_db" >&2
  exit 1
fi
if [[ -e "$output_dir" ]]; then
  echo "error: backup output already exists: $output_dir" >&2
  exit 1
fi
if [[ "$output_dir" == *$'\n'* || "$output_dir" == *"'"* ]]; then
  echo "error: backup output cannot contain a quote or newline" >&2
  exit 2
fi

umask 077
mkdir -p "$output_dir"
chmod 700 "$output_dir"
trap 'rm -rf "$output_dir"' ERR INT TERM

sqlite3 "$source_db" ".timeout 5000" ".backup '$output_dir/blinkora.sqlite3'"
if [[ "$(sqlite3 "$output_dir/blinkora.sqlite3" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "error: SQLite backup failed integrity_check" >&2
  exit 1
fi

if [[ -d "$data_dir/files" ]]; then
  cp -a "$data_dir/files" "$output_dir/files"
else
  mkdir "$output_dir/files"
fi
chmod 600 "$output_dir/blinkora.sqlite3"
find "$output_dir/files" -type d -exec chmod 700 {} +
find "$output_dir/files" -type f -exec chmod 600 {} +

printf 'format=blinkora.sqlite.physical.v1\ncreatedAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$output_dir/manifest"
chmod 600 "$output_dir/manifest"
trap - ERR INT TERM
echo "backup created: $output_dir"
