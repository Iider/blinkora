#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-share-verify.XXXXXX")"
OUTPUT_DIR="$TEMP_DIR/output"
EXTRACT_DIR="$TEMP_DIR/extracted"
VERSION="verify-1.0.0"
PACKAGE_NAME="blinkora-$VERSION-linux-x86_64"
ARCHIVE_NAME="$PACKAGE_NAME.tar.gz"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$OUTPUT_DIR" "$EXTRACT_DIR"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TEMP_DIR/blinkora-server"
chmod 0755 "$TEMP_DIR/blinkora-server"

BLINKORA_SHARE_OUTPUT_DIR="$OUTPUT_DIR" \
  "$ROOT_DIR/scripts/package-linux-share.sh" "$TEMP_DIR/blinkora-server" "$VERSION" >/dev/null

[[ -f "$OUTPUT_DIR/$ARCHIVE_NAME" ]]
[[ -f "$OUTPUT_DIR/$ARCHIVE_NAME.sha256" ]]
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUTPUT_DIR" && sha256sum --check "$ARCHIVE_NAME.sha256" >/dev/null)
else
  (cd "$OUTPUT_DIR" && shasum -a 256 --check "$ARCHIVE_NAME.sha256" >/dev/null)
fi

tar -xzf "$OUTPUT_DIR/$ARCHIVE_NAME" -C "$EXTRACT_DIR"
PACKAGE_DIR="$EXTRACT_DIR/$PACKAGE_NAME"
expected_files=(
  AGENTS.md
  BLINKORA_PACKAGE.json
  LICENSE
  MANIFEST.sha256
  README.md
  VERSION
  blinkora-server
  blinkora.env.example
  blinkora.service
  install.sh
)
actual_files="$(find "$PACKAGE_DIR" -mindepth 1 -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)"
expected_list="$(printf '%s\n' "${expected_files[@]}" | LC_ALL=C sort)"
[[ "$actual_files" == "$expected_list" ]] || {
  echo "error: share package file list differs from the expected contract" >&2
  diff -u <(printf '%s\n' "$expected_list") <(printf '%s\n' "$actual_files") >&2 || true
  exit 1
}

bash -n "$PACKAGE_DIR/install.sh"
"$PACKAGE_DIR/install.sh" verify-package >/dev/null
node -e '
  const fs = require("node:fs");
  const metadata = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (metadata.formatVersion !== 1 || metadata.version !== process.argv[2]) process.exit(1);
  if (metadata.target.os !== "linux" || metadata.target.arch !== "x86_64") process.exit(1);
  if (metadata.runtime.serviceManager !== "systemd" || metadata.data.preservedOnUpgrade !== true) process.exit(1);
' "$PACKAGE_DIR/BLINKORA_PACKAGE.json" "$VERSION"

grep -Fxq 'ExecStart=/opt/blinkora/blinkora-server' "$PACKAGE_DIR/blinkora.service"
grep -Fq '不要删除或覆盖 `/var/lib/blinkora/data`' "$PACKAGE_DIR/AGENTS.md"
grep -Fq 'sudo ./install.sh install' "$PACKAGE_DIR/README.md"
grep -Fq 'must not be a symbolic link' "$PACKAGE_DIR/install.sh"
grep -Fq 'uses a different DATA_DIR; refusing to migrate an unknown deployment' "$PACKAGE_DIR/install.sh"
grep -Fq 'restore_previous_runtime' "$PACKAGE_DIR/install.sh"
if rg -n -i 'docker[[:space:]-]+compose|blinkora-web|docker/data/blinkora' "$PACKAGE_DIR"; then
  echo "error: share package contains retired container-runtime instructions" >&2
  exit 1
fi

printf '\nchecksum-tamper-test\n' >>"$PACKAGE_DIR/README.md"
if "$PACKAGE_DIR/install.sh" verify-package >/dev/null 2>&1; then
  echo "error: package checksum verification accepted modified content" >&2
  exit 1
fi

echo "Linux share package guardrails passed (archive, manifest, metadata, Agent guide, installer, tamper rejection)."
