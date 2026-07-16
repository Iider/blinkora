#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/release/rust"
APPIMAGETOOL="${APPIMAGETOOL:-appimagetool}"
TARGETARCH="${TARGETARCH:-amd64}"
OUTPUT_DIR="${BLINKORA_APPIMAGE_OUTPUT_DIR:-$ROOT_DIR/release/appimage}"
VERSION="${BLINKORA_RELEASE_VERSION:-$(git -C "$ROOT_DIR" describe --always --dirty)}"

if [[ "$TARGETARCH" != "amd64" && "$TARGETARCH" != "x86_64" ]]; then
  echo "error: Linux portable release currently supports only amd64/x86_64" >&2
  exit 2
fi
if [[ ! "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "error: BLINKORA_RELEASE_VERSION contains unsupported characters" >&2
  exit 2
fi
if ! command -v "$APPIMAGETOOL" >/dev/null 2>&1; then
  echo "error: appimagetool is required; set APPIMAGETOOL to its executable path" >&2
  exit 1
fi

TARGETARCH=amd64 \
  DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-linux/amd64}" \
  "${ROOT_DIR}/scripts/build-rust-release.sh"

if ! file "$RELEASE_DIR/blinkora-server" | grep -q 'ELF 64-bit.*x86-64'; then
  echo "error: expected an x86_64 Linux server binary" >&2
  file "$RELEASE_DIR/blinkora-server" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-appimage.XXXXXX")"
APP_DIR="$WORK_DIR/Blinkora.AppDir"
trap 'rm -rf "$WORK_DIR"' EXIT

install -d -m 0755 \
  "$APP_DIR/usr/lib/blinkora" \
  "$APP_DIR/usr/share/applications" \
  "$APP_DIR/usr/share/icons/hicolor/256x256/apps" \
  "$APP_DIR/usr/share/metainfo"
install -m 0755 "$ROOT_DIR/packaging/linux/AppRun" "$APP_DIR/AppRun"
install -m 0644 "$ROOT_DIR/packaging/linux/Blinkora.desktop" "$APP_DIR/Blinkora.desktop"
install -m 0644 "$ROOT_DIR/packaging/linux/Blinkora.desktop" "$APP_DIR/usr/share/applications/Blinkora.desktop"
install -m 0644 "$ROOT_DIR/packaging/linux/Blinkora.appdata.xml" "$APP_DIR/usr/share/metainfo/io.github.blinkora.Blinkora.appdata.xml"
install -m 0644 "$ROOT_DIR/app/public/logo.png" "$APP_DIR/blinkora.png"
install -m 0644 "$ROOT_DIR/app/public/logo.png" "$APP_DIR/usr/share/icons/hicolor/256x256/apps/blinkora.png"
cp -a "$RELEASE_DIR/blinkora-server" "$APP_DIR/usr/lib/blinkora/blinkora-server"
cp -a "$RELEASE_DIR/public" "$APP_DIR/usr/lib/blinkora/public"
install -d -m 0755 "$APP_DIR/usr/lib/blinkora/db"
install -m 0644 "$RELEASE_DIR/db/schema.sqlite.sql" "$APP_DIR/usr/lib/blinkora/db/schema.sqlite.sql"
printf '%s\n' "$VERSION" > "$APP_DIR/usr/lib/blinkora/VERSION"
chmod 0755 "$APP_DIR/usr/lib/blinkora/blinkora-server"

mkdir -p "$OUTPUT_DIR"
OUTPUT_PATH="$OUTPUT_DIR/Blinkora-$VERSION-x86_64.AppImage"
ARCH=x86_64 "$APPIMAGETOOL" --comp xz "$APP_DIR" "$OUTPUT_PATH"

if [[ ! -x "$OUTPUT_PATH" ]]; then
  echo "error: AppImage was not created: $OUTPUT_PATH" >&2
  exit 1
fi
sha256sum "$OUTPUT_PATH" > "$OUTPUT_PATH.sha256"
echo "Linux portable AppImage created: $OUTPUT_PATH"
