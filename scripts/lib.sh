# Shared helpers, sourced by the other scripts. Never prints secret values.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UPSTREAM="$ROOT/stack/upstream"
ENV_FILE="$ROOT/.env"

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

need_env() {
  [ -f "$ENV_FILE" ] || die ".env missing — run scripts/setup.sh first"
  [ -f "$UPSTREAM/docker-compose.yml" ] || die "stack/upstream missing — run scripts/setup.sh first"
}

# Read one value from .env without exporting the whole file into the shell.
envval() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

# docker compose with the upstream files + the plugin package (deploy/selfhosted, Envoy gateway — the same files a
# customer layers in with COMPOSE_FILE) + our local-only override, project dir = upstream copy.
# STORAGE_BACKEND=s3 in .env adds stack/storage-s3.yml (file bytes in an S3 bucket, e.g. Hetzner).
PKG="$ROOT/deploy/selfhosted"
compose() {
  local extra=()
  if [ "$(envval STORAGE_BACKEND 2>/dev/null || true)" = "s3" ]; then extra=(-f "$ROOT/stack/storage-s3.yml"); fi
  # CMS_PKG_DIR: where the gateway wrappers are mounted from; CMS_IMAGE: what `cms` is called when built here
  CMS_PKG_DIR="$PKG" CMS_IMAGE="${CMS_IMAGE:-supapim:local}" CMS_VERSION="${CMS_VERSION:-$(plugin_version)}" \
  docker compose \
    --project-directory "$UPSTREAM" \
    --env-file "$ENV_FILE" \
    -f "$UPSTREAM/docker-compose.yml" \
    -f "$PKG/docker-compose.cms.yml" \
    -f "$PKG/docker-compose.envoy.yml" \
    -f "$ROOT/docker-compose.override.yml" \
    ${extra[@]+"${extra[@]}"} \
    "$@"
}

# Release version: the root package.json (scripts/build-image.sh reads the same)
plugin_version() { sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json" | head -1; }

# psql inside the db container as supabase_admin (unix socket, no password on the command line).
psql_admin() { docker exec -i supabase-db psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"; }
# … and as postgres, the role that installs the plugin on Supabase Cloud (not a superuser).
psql_owner() { docker exec -i supabase-db psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres "$@"; }

gw_url() { echo "http://localhost:$(envval API_GW_HTTP_PORT)"; }
mcp_url() { echo "http://localhost:$(envval CMS_MCP_PORT)"; }
