#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$ROOT_DIR/deploy/linux-package"
OUTPUT_DIR="${BLINKORA_SHARE_OUTPUT_DIR:-$ROOT_DIR/release/linux}"
BINARY_INPUT="${1:-}"
VERSION="${2:-}"

if [[ -z "$BINARY_INPUT" || -z "$VERSION" ]]; then
  echo "usage: scripts/package-linux-share.sh <linux-binary> <version>" >&2
  exit 2
fi
if [[ ! "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "error: version contains unsupported characters" >&2
  exit 2
fi
if [[ ! -f "$BINARY_INPUT" || ! -x "$BINARY_INPUT" ]]; then
  echo "error: Linux binary must exist and be executable: $BINARY_INPUT" >&2
  exit 1
fi

BINARY_INPUT="$(cd "$(dirname "$BINARY_INPUT")" && pwd)/$(basename "$BINARY_INPUT")"
PACKAGE_NAME="blinkora-$VERSION-linux-x86_64"
ARCHIVE_NAME="$PACKAGE_NAME.tar.gz"
ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_NAME"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-share.XXXXXX")"
PACKAGE_DIR="$STAGING_DIR/$PACKAGE_NAME"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

checksum_files() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

mkdir -p "$PACKAGE_DIR" "$OUTPUT_DIR"
install -m 0755 "$BINARY_INPUT" "$PACKAGE_DIR/blinkora-server"
install -m 0755 "$TEMPLATE_DIR/install.sh" "$PACKAGE_DIR/install.sh"
install -m 0644 "$TEMPLATE_DIR/AGENTS.md" "$PACKAGE_DIR/AGENTS.md"
install -m 0644 "$TEMPLATE_DIR/README.md" "$PACKAGE_DIR/README.md"
install -m 0644 "$TEMPLATE_DIR/blinkora.env.example" "$PACKAGE_DIR/blinkora.env.example"
install -m 0644 "$TEMPLATE_DIR/blinkora.service" "$PACKAGE_DIR/blinkora.service"
install -m 0644 "$ROOT_DIR/LICENSE" "$PACKAGE_DIR/LICENSE"
printf '%s\n' "$VERSION" >"$PACKAGE_DIR/VERSION"
cat >"$PACKAGE_DIR/BLINKORA_PACKAGE.json" <<EOF
{
  "formatVersion": 1,
  "name": "Blinkora",
  "version": "$VERSION",
  "target": {
    "os": "linux",
    "arch": "x86_64",
    "mode": "headless"
  },
  "runtime": {
    "binary": "blinkora-server",
    "serviceManager": "systemd",
    "service": "blinkora.service",
    "defaultPort": 6676
  },
  "installer": {
    "preflight": "./install.sh check",
    "install": "sudo ./install.sh install"
  },
  "data": {
    "path": "/var/lib/blinkora/data",
    "preservedOnUpgrade": true
  }
}
EOF

manifest_files=(
  AGENTS.md
  BLINKORA_PACKAGE.json
  LICENSE
  README.md
  VERSION
  blinkora-server
  blinkora.env.example
  blinkora.service
  install.sh
)
(
  cd "$PACKAGE_DIR"
  checksum_files "${manifest_files[@]}" >MANIFEST.sha256
)

rm -f "$ARCHIVE_PATH" "$ARCHIVE_PATH.sha256"
COPYFILE_DISABLE=1 tar -czf "$ARCHIVE_PATH" -C "$STAGING_DIR" "$PACKAGE_NAME"
(
  cd "$OUTPUT_DIR"
  checksum_files "$ARCHIVE_NAME" >"$ARCHIVE_NAME.sha256"
)

echo "Linux share package created: $ARCHIVE_PATH"
echo "Package checksum: $ARCHIVE_PATH.sha256"
