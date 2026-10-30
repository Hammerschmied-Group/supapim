#!/usr/bin/env bash
# Proves the MCP path has no service key and no database access. Prints variable NAMES only, never values.
#   1. code      apps/server/src/mcp never reads the environment and names no service/secret key, JWT secret or DB credential
#   2. compose   the plugin container (service `cms`) in deploy/selfhosted/docker-compose.cms.yml and in
#                docker-compose.override.yml (local additions) is given none of them
#   3. runtime   the running container's environment has none of them (when the container exists)
# 1 fails the check. 2 and 3 only print a NOTE unless --strict: Task 5's admin handler is the one place that may
# get a service key, and then this check is where that decision becomes visible.
#   4. admin    (Task 5c) the key is read only under apps/server/src/admin, and the container gets exactly one
#               secret, SUPABASE_SECRET_KEY, for it. Any other secret-like variable fails the check.
source "$(dirname "$0")/lib.sh"
STRICT=0; [ "${1:-}" = "--strict" ] && STRICT=1
NAMES='SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|SERVICE_KEY|JWT_SECRET|JWT_KEYS|POSTGRES_PASSWORD|POSTGRES_URL|DATABASE_URL|DB_URL|SECRET_KEY'
# Secret-like names other than the one the admin API may get (see step 4):
OTHER='SERVICE_ROLE_KEY|SERVICE_KEY|JWT_SECRET|JWT_KEYS|POSTGRES_PASSWORD|POSTGRES_URL|DATABASE_URL|DB_URL|SECRET_KEY'
rc=0

step "1. code: apps/server/src/mcp"
hits=$(grep -rnE "process\.env|$NAMES|createClient|from 'pg'|postgres://" "$ROOT/apps/server/src/mcp" || true)
if [ -n "$hits" ]; then echo "$hits"; echo "FAIL: the MCP module must not read the environment or name secrets"; rc=1
else echo "   none (no process.env, no service key, JWT secret or database credential)"; fi

step "2. compose: environment of service cms"
block=$(for f in "$ROOT/deploy/selfhosted/docker-compose.cms.yml" "$ROOT/docker-compose.override.yml"; do
  awk '/^  cms:/{f=1;next} f&&/^  [a-z]/{f=0} f&&/^volumes:/{f=0} f' "$f"; done)
names=$(printf '%s\n' "$block" | grep -oE "^ +[A-Z_]+:" | tr -d ' :' || true)
bad=$(printf '%s\n' "$names" | grep -E "^($OTHER)$" || true)
refs=$(printf '%s\n' "$block" | grep -oE '\$\{[A-Z_]+' | tr -d '${' | grep -E "^($OTHER)$" || true)
echo "   variables: $(printf '%s' "$names" | tr '\n' ' ')"
compose_names="$names $refs"
if printf '%s\n' $compose_names | grep -qx 'SUPABASE_SECRET_KEY'; then echo "   FAIL: service cms is given SUPABASE_SECRET_KEY; only cms-admin (the admin API container) may hold it"; rc=1; fi
if [ -n "$bad$refs" ]; then echo "   NOTE: secret-like names: $(printf '%s %s' "$bad" "$refs")"; [ $STRICT = 1 ] && rc=1
else echo "   none of: service key, secret key, JWT secret, database credential"; fi

step "2b. compose: environment of service cms-admin (the only one with the secret key)"
ablock=$(for f in "$ROOT/deploy/selfhosted/docker-compose.cms.yml" "$ROOT/docker-compose.override.yml"; do
  awk '/^  cms-admin:/{f=1;next} f&&/^  [a-z]/{f=0} f&&/^volumes:/{f=0} f' "$f"; done)
anames=$(printf '%s\n' "$ablock" | grep -oE "^ +[A-Z_]+:" | tr -d ' :' || true)
echo "   variables: $(printf '%s' "$anames" | tr '\n' ' ')"
printf '%s\n' $anames | grep -qx 'SUPABASE_SECRET_KEY' && echo "   has SUPABASE_SECRET_KEY: yes" || { echo "   FAIL: cms-admin has no SUPABASE_SECRET_KEY"; rc=1; }
abad=$(printf '%s\n' $anames | grep -E "^($OTHER)$" || true)
[ -z "$abad" ] && echo "   nothing else secret-like" || { echo "   FAIL: cms-admin gets $abad"; rc=1; }
cmd=$(awk '/^  cms-admin:/{f=1;next} f&&/^  [a-z]/{f=0} f' "$ROOT/deploy/selfhosted/docker-compose.cms.yml" | grep -c 'admin.mjs' || true)
[ "${cmd:-0}" -gt 0 ] && echo "   runs node admin.mjs (admin routes only)" || { echo "   FAIL: cms-admin does not run admin.mjs"; rc=1; }

step "3. runtime: environment of container supabase-cms"
if docker inspect supabase-cms >/dev/null 2>&1; then
  names=$(docker inspect supabase-cms --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1 | grep -v '^$' | sort)
  echo "   variables: $(printf '%s' "$names" | tr '\n' ' ')"
  bad=$(printf '%s\n' "$names" | grep -E "^($OTHER)$" || true)
  if [ -n "$bad" ]; then echo "   NOTE: secret-like names: $bad"; [ $STRICT = 1 ] && rc=1
  else echo "   none of: service key, secret key, JWT secret, database credential"; fi
  if printf '%s\n' "$names" | grep -qx 'SUPABASE_SECRET_KEY'; then echo "   NOTE: the running container still has SUPABASE_SECRET_KEY (started before the cms/cms-admin split — recreate it)"; [ $STRICT = 1 ] && rc=1; fi
else echo "   (container not running, skipped)"; fi

step "4. admin: the service key is read only in apps/server/src/admin"
others=$(grep -rlE "SUPABASE_SECRET_KEY|SERVICE_ROLE_KEY|SERVICE_KEY|JWT_KEYS" "$ROOT/apps/server" "$ROOT/apps/ui/src" --include='*.mjs' --include='*.js' --include='*.jsx' --exclude-dir=node_modules --exclude-dir=test | sed "s|$ROOT/||" | grep -v '^apps/server/src/admin/' || true)
if [ -n "$others" ]; then echo "$others"; echo "FAIL: only apps/server/src/admin may name the service key"; rc=1
else echo "   no other file under apps/server or apps/ui/src names it"; fi
extra="$bad$refs"
admin_key=$(printf '%s\n' $compose_names | grep -cx 'SUPABASE_SECRET_KEY' || true)
if [ -n "$extra" ]; then echo "   FAIL: unexpected secret-like variables for the cms container: $extra"; rc=1
else echo "   the cms container gets no secret key; cms-admin gets exactly SUPABASE_SECRET_KEY; nothing else secret-like"; fi

[ $rc = 0 ] && echo && echo "OK: no service key in the MCP path; only the separate admin container holds the key" || { echo; echo "FAILED"; }
exit $rc
