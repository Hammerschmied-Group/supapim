#!/usr/bin/env bash
# Start the local stack (setup on first run), wait until healthy, then seed if the demo is missing.
source "$(dirname "$0")/lib.sh"

[ -f "$ENV_FILE" ] && [ -f "$UPSTREAM/docker-compose.yml" ] || "$ROOT/scripts/setup.sh"
need_env

step "docker compose up ($(cat "$UPSTREAM/.supabase-version"))"
# PostgREST stays unhealthy while a schema in PGRST_DB_SCHEMAS is missing, so make sure they all
# exist (empty is fine) before the rest of the stack waits on it. seed.sh fills them.
compose up -d --wait --wait-timeout 300 db
for s in $(envval PGRST_DB_SCHEMAS | tr ',' ' '); do
  psql_admin -c "create schema if not exists \"$s\" authorization postgres" 2>/dev/null
done
compose up -d --build --wait --wait-timeout 300

if [ "$(psql_admin -Atc "select count(*) from pg_namespace where nspname = 'cms'")" = "0" ]; then
  "$ROOT/scripts/seed.sh"
fi

cat <<EOF

Stack is up:
  API gateway (Envoy)   $(gw_url)          (Studio behind basic auth: DASHBOARD_USERNAME/PASSWORD in .env)
  Postgres via pooler   localhost:$(envval POOLER_HOST_PORT_SESSION)   (user postgres.$(envval POOLER_TENANT_ID))
  MCP server            $(gw_url)/cms/mcp   (through the gateway)
  OAuth consent page    $(mcp_url)/oauth/consent
EOF
