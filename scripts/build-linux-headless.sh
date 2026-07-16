#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/release/rust"
OUTPUT_DIR="${BLINKORA_HEADLESS_OUTPUT_DIR:-$ROOT_DIR/release/linux}"
VERSION="${BLINKORA_RELEASE_VERSION:-$(git -C "$ROOT_DIR" describe --always --dirty)}"

if [[ ! "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "error: BLINKORA_RELEASE_VERSION contains unsupported characters" >&2
  exit 2
fi

TARGETARCH=amd64 \
  DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-linux/amd64}" \
  "$ROOT_DIR/scripts/build-rust-release.sh"

if ! file "$RELEASE_DIR/blinkora-server" | grep -q 'ELF 64-bit.*x86-64'; then
  echo "error: expected an x86_64 Linux server binary" >&2
  file "$RELEASE_DIR/blinkora-server" >&2
  exit 1
fi

OUTPUT_PATH="$OUTPUT_DIR/blinkora-server-$VERSION-linux-x86_64"
mkdir -p "$OUTPUT_DIR"
install -m 0755 "$RELEASE_DIR/blinkora-server" "$OUTPUT_PATH"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUTPUT_PATH" > "$OUTPUT_PATH.sha256"
else
  shasum -a 256 "$OUTPUT_PATH" > "$OUTPUT_PATH.sha256"
fi

echo "Linux headless single binary created: $OUTPUT_PATH"
