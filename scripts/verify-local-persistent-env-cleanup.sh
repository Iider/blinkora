#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/blinkora-local-env.XXXXXX")"

cleanup() {
  rm -rf "$FIXTURE"
}
trap cleanup EXIT INT TERM

mkdir -p "$FIXTURE/app" "$FIXTURE/home"
cat > "$FIXTURE/app/blinkora.env" <<'EOF'
NODE_ENV=production
DATABASE_URL=postgresql://legacy.invalid/blinkora
PGPASSWORD=legacy-password
POSTGRES_PASSWORD=legacy-password
BLINKORA_SECRET=preserve-this-test-secret
PUBLIC_PATH=/legacy/public
SCHEMA_PATH=/legacy/schema.sql
EOF
chmod 600 "$FIXTURE/app/blinkora.env"

HOME="$FIXTURE/home" BLINKORA_LOCAL_HOME="$FIXTURE/app" bash -c '
  script="$1"
  set -- help
  source "$script" >/dev/null
  ensure_env_file >/dev/null
' _ "$ROOT_DIR/scripts/local-persistent-deploy.sh"

if grep -Eq '^(DATABASE_URL|PGPASSWORD|POSTGRES_PASSWORD)=' "$FIXTURE/app/blinkora.env"; then
  echo "error: local deployment kept a deprecated PostgreSQL setting" >&2
  exit 1
fi
grep -q '^BLINKORA_SECRET=preserve-this-test-secret$' "$FIXTURE/app/blinkora.env"
grep -q "^PUBLIC_PATH=$FIXTURE/app/release/public$" "$FIXTURE/app/blinkora.env"
grep -q "^SCHEMA_PATH=$FIXTURE/app/release/db/schema.sqlite.sql$" "$FIXTURE/app/blinkora.env"

permissions="$(stat -f '%Lp' "$FIXTURE/app/blinkora.env" 2>/dev/null || stat -c '%a' "$FIXTURE/app/blinkora.env")"
if [[ "$permissions" != 600 ]]; then
  echo "error: local deployment environment permissions are $permissions, expected 600" >&2
  exit 1
fi
if find "$FIXTURE/app" -maxdepth 1 -name '.blinkora.env.*' -print -quit | grep -q .; then
  echo "error: local deployment left a temporary environment file" >&2
  exit 1
fi

echo "local deployment PostgreSQL environment cleanup passed"
