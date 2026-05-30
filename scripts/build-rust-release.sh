#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/release/rust"
TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/blinkora-rust-target}"
TARGET_OS="${TARGETOS:-linux}"
HOST_ARCH="$(uname -m)"
case "${TARGETARCH:-}" in
  amd64) TARGET_ARCH="x86_64" ;;
  arm64) TARGET_ARCH="aarch64" ;;
  "") TARGET_ARCH="$HOST_ARCH" ;;
  *) TARGET_ARCH="$TARGETARCH" ;;
esac
case "$TARGET_ARCH" in
  x86_64 | amd64) RUST_TARGET_ARCH="x86_64" ;;
  arm64 | aarch64) RUST_TARGET_ARCH="aarch64" ;;
  *) echo "error: unsupported Rust target architecture: $TARGET_ARCH" >&2; exit 1 ;;
esac
if [[ "$TARGET_OS" != "linux" ]]; then
  echo "error: only linux Rust release artifacts are supported for Docker deployment" >&2
  exit 1
fi
RUST_TARGET="${RUST_TARGET:-${RUST_TARGET_ARCH}-unknown-linux-musl}"

cd "$ROOT_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build frontend release artifacts" >&2
  exit 1
fi
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

bun run build:web --force

build_with_cargo() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo is required for native Rust release build" >&2
    return 1
  fi
  (
    cd server-rust
    rustup target list --installed | grep -qx "$RUST_TARGET" || {
      echo "error: Rust target $RUST_TARGET is not installed. Run: rustup target add $RUST_TARGET" >&2
      exit 1
    }
    CARGO_TARGET_DIR="$TARGET_DIR" cargo build --release --locked --target "$RUST_TARGET"
    cp "$TARGET_DIR/$RUST_TARGET/release/blinkora-rust" "$RELEASE_DIR/blinkora-rust"
  )
}

build_with_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required for Rust Linux binary fallback" >&2
    exit 1
  fi
  local image="blinkora-rust-binary-builder:local"
  local container_id

  docker build \
    --target backend-builder \
    -f docker/dockerfile.rust.fullbuild \
    -t "$image" \
    .
  container_id="$(docker create "$image")"
  trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' RETURN
  docker cp "$container_id:/build/server-rust/target/release/blinkora-rust" "$RELEASE_DIR/blinkora-rust"
}

if [[ "${BLINKORA_RUST_DOCKER_BUILD:-0}" == "1" ]]; then
  build_with_docker
elif ! build_with_cargo; then
  echo "warning: native Rust Linux build failed; falling back to Docker binary builder" >&2
  build_with_docker
fi

if ! file "$RELEASE_DIR/blinkora-rust" | grep -q 'ELF .* executable'; then
  file "$RELEASE_DIR/blinkora-rust" >&2
  echo "error: release/rust/blinkora-rust must be a Linux ELF executable for Docker runtime" >&2
  exit 1
fi

cp -R dist/public "$RELEASE_DIR/public"
mkdir -p "$RELEASE_DIR/public/dist/js/lute"
cp server/lute.min.js "$RELEASE_DIR/public/dist/js/lute/lute.min.js"
cp -R server/vditor/js "$RELEASE_DIR/public/dist/js"
mkdir -p "$RELEASE_DIR/public/dist/js/icons"
cp "$RELEASE_DIR/public/dist/js/lute/lute.min.js" "$RELEASE_DIR/public/dist/js/icons/ant.js"
mkdir -p "$RELEASE_DIR/public/vditor-assets/dist"
cp -R "$RELEASE_DIR/public/dist/js" "$RELEASE_DIR/public/vditor-assets/dist/js"

chmod +x "$RELEASE_DIR/blinkora-rust"
echo "Rust release artifacts are ready in $RELEASE_DIR"
