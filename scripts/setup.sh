#!/usr/bin/env bash
# One-time setup: fetch the upstream self-hosted stack and generate local test secrets.
#   scripts/setup.sh            fetch upstream (if missing) + create .env (if missing)
#   scripts/setup.sh --refetch  replace stack/upstream with the tag in stack/SUPABASE_VERSION
# Secrets go to .env only (gitignored, mode 600) and are never printed.
source "$(dirname "$0")/lib.sh"

REF=$(cat "$ROOT/stack/SUPABASE_VERSION")

if [ "${1:-}" = "--refetch" ] && [ -d "$UPSTREAM" ]; then
  [ -d "$UPSTREAM/volumes/db/data" ] && die "stack has data — run scripts/reset.sh --wipe first"
  rm -rf "$UPSTREAM"
fi

if [ ! -f "$UPSTREAM/docker-compose.yml" ]; then
  step "fetch supabase/supabase docker/ at $REF"
  tmp=$(mktemp -d)
  git clone -q --depth 1 --branch "$REF" --filter=blob:none --sparse \
    https://github.com/supabase/supabase.git "$tmp/src" 2>/dev/null
  git -C "$tmp/src" sparse-checkout set docker
  mkdir -p "$UPSTREAM"
  cp -R "$tmp/src/docker/." "$UPSTREAM/"
  echo "$REF" > "$UPSTREAM/.supabase-version"
  rm -rf "$tmp"
fi

if [ ! -f "$ENV_FILE" ]; then
  step "generate .env with fresh local test secrets (upstream utils/*.sh)"
  kg="$ROOT/stack/.keygen"; rm -rf "$kg"; mkdir -p "$kg"
  cp "$UPSTREAM/.env.example" "$kg/.env"
  cp "$UPSTREAM/docker-compose.yml" "$kg/"          # add-new-auth-keys.sh edits a compose file; give it a scratch copy
  ( cd "$kg" && sh "$UPSTREAM/utils/generate-keys.sh" --update-env >/dev/null \
             && sh "$UPSTREAM/utils/add-new-auth-keys.sh" --update-env >/dev/null )

  set_kv() {  # replace or append KEY=VALUE in the scratch .env
    if grep -q "^$1=" "$kg/.env"; then
      sed -i.old -e "s|^$1=.*$|$1=$2|" "$kg/.env"
    else
      echo "$1=$2" >> "$kg/.env"
    fi
  }
  # Ports: 8000/5432 are taken on this Mac and 54321–54329 belong to `supabase start` (CLI).
  set_kv API_GW_HTTP_PORT 55321
  set_kv KONG_HTTP_PORT 55321
  set_kv POOLER_HOST_PORT_SESSION 55322
  set_kv POOLER_HOST_PORT_TRANSACTION 55329
  set_kv CMS_MCP_PORT 55380
  set_kv SUPABASE_PUBLIC_URL http://localhost:55321
  set_kv API_EXTERNAL_URL http://localhost:55321/auth/v1
  # SITE_URL is where Supabase Auth sends users for OAuth consent (served by the cms container).
  set_kv SITE_URL http://localhost:55380
  set_kv POOLER_TENANT_ID cms-local
  # cms_api = the plugin's RPC schema (describe/whoami/effective_rights); cms itself stays internal.
  set_kv PGRST_DB_SCHEMAS public,graphql_public,nordwind,suedwind,cms_api
  set_kv DISABLE_SIGNUP true
  set_kv ENABLE_PHONE_SIGNUP false
  set_kv STUDIO_DEFAULT_ORGANIZATION '"Supabase CMS"'
  set_kv STUDIO_DEFAULT_PROJECT '"Lokal"'
  set_kv OPENAI_API_KEY ''
  set_kv TEST_USER_PASSWORD "$(openssl rand -hex 12)"
  sed -i.old -e '/^COMPOSE_FILE=/d' "$kg/.env"

  install -m 600 "$kg/.env" "$ENV_FILE"
  rm -rf "$kg"
  echo "   .env written (mode 600, $(grep -c '=' "$ENV_FILE") keys)"
fi

echo "setup done — next: scripts/start.sh"
