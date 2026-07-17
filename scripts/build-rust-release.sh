#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/release/rust"
TARGET_DIR="${CARGO_TARGET_DIR:-/private/tmp/blinkora-server-target}"
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
  echo "error: only Linux Rust release artifacts are supported" >&2
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
if [[ ! -f "$ROOT_DIR/dist/public/index.html" ]]; then
  echo "error: frontend build did not produce dist/public/index.html" >&2
  exit 1
fi

build_with_cargo() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo is required for native Rust release build" >&2
    return 1
  fi
  (
    cd server
    if command -v rustup >/dev/null 2>&1; then
      rustup target list --installed | grep -qx "$RUST_TARGET" || {
        echo "error: Rust target $RUST_TARGET is not installed. Run: rustup target add $RUST_TARGET" >&2
        exit 1
      }
    else
      echo "warning: rustup is unavailable; attempting the configured cargo target directly" >&2
    fi
    if ! CARGO_TARGET_DIR="$TARGET_DIR" cargo build --release --locked --target "$RUST_TARGET"; then
      exit 1
    fi
    cp "$TARGET_DIR/$RUST_TARGET/release/blinkora-server" "$RELEASE_DIR/blinkora-server"
  )
}

build_with_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required for Rust Linux binary fallback" >&2
    exit 1
  fi
  local image="blinkora-server-builder:local"
  local container_id

  docker build \
    --target backend-builder \
    -f docker/rust-builder.Dockerfile \
    --build-arg "RUST_TARGET=$RUST_TARGET" \
    -t "$image" \
    .
  container_id="$(docker create "$image")"
  trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' RETURN
  docker cp "$container_id:/build/server/target/$RUST_TARGET/release/blinkora-server" "$RELEASE_DIR/blinkora-server"
  docker rm -f "$container_id" >/dev/null 2>&1 || true
  docker rmi "$image" >/dev/null 2>&1 || true
}

if [[ "${BLINKORA_RUST_DOCKER_BUILD:-0}" == "1" ]]; then
  build_with_docker
elif ! build_with_cargo; then
  echo "warning: native Rust Linux build failed; falling back to Docker binary builder" >&2
  build_with_docker
fi

if ! file "$RELEASE_DIR/blinkora-server" | grep -q 'ELF .* executable'; then
  file "$RELEASE_DIR/blinkora-server" >&2
  echo "error: release/rust/blinkora-server must be a Linux ELF executable" >&2
  exit 1
fi
if ! file "$RELEASE_DIR/blinkora-server" | grep -Eq 'statically linked|static-pie linked'; then
  file "$RELEASE_DIR/blinkora-server" >&2
  echo "error: release/rust/blinkora-server must be statically linked for portable Linux delivery" >&2
  exit 1
fi

chmod +x "$RELEASE_DIR/blinkora-server"
echo "Single-binary Linux release is ready in $RELEASE_DIR/blinkora-server"
