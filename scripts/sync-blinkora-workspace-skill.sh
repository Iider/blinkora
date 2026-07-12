#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/.agents/skills/blinkora-workspace"
MODE="${1:---check}"

usage() {
  cat <<'EOF'
Usage:
  bun run skill:sync -- [--check|--apply]

Copies Blinkora's canonical workspace skill package to the local Hermes, generic
Agents, Codex, and SSD archive locations. --check is a dry run; --apply makes the
targets exactly match the canonical package.
EOF
}

case "$MODE" in
  --check) IS_DRY_RUN=true ;;
  --apply) IS_DRY_RUN=false ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if ! command -v rsync >/dev/null 2>&1; then
  echo "error: rsync is required to synchronize the Blinkora workspace skill" >&2
  exit 1
fi

REQUIRED_FILES=(
  "$SOURCE_DIR/SKILL.md"
  "$SOURCE_DIR/references/mcp-guide.md"
  "$SOURCE_DIR/references/mcp-sse-python-client.md"
)

for required_file in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "error: canonical skill package is incomplete: $required_file" >&2
    exit 1
  fi
done

ARCHIVE_ROOT="${BLINKORA_SKILLS_ARCHIVE_ROOT:-/Volumes/SSD/skills}"
TARGETS=(
  "$HOME/.hermes/skills/blinkora-workspace"
  "$HOME/.agents/skills/blinkora-workspace"
  "$HOME/.codex/skills/blinkora-workspace"
  "$ARCHIVE_ROOT/blinkora-workspace"
)

for target in "${TARGETS[@]}"; do
  parent_dir="$(dirname "$target")"
  if [[ ! -d "$parent_dir" ]]; then
    echo "error: target parent is unavailable: $parent_dir" >&2
    exit 1
  fi
done

RSYNC_ARGS=(
  -a
  --delete
  --itemize-changes
  --exclude=.DS_Store
  --exclude=__pycache__/
  --exclude='*.pyc'
)

for target in "${TARGETS[@]}"; do
  printf '%s %s\n' "Syncing Blinkora workspace skill to" "$target"
  if [[ "$IS_DRY_RUN" == true ]]; then
    rsync "${RSYNC_ARGS[@]}" --dry-run "$SOURCE_DIR/" "$target/"
  else
    rsync "${RSYNC_ARGS[@]}" "$SOURCE_DIR/" "$target/"
  fi
done

if [[ "$MODE" == "--check" ]]; then
  echo "Dry run complete. Re-run with --apply to synchronize these targets."
else
  echo "Sync complete. Restart Hermes Gateway, then use /reset in existing Hermes conversations."
fi
