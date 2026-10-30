#!/usr/bin/env bash
# Installs SupaPIM into a running (or about to run) self-hosted Supabase stack. Guide: docs/install-selfhosted.md
# Never prints secret values. Run it from anywhere; the package folder (this script's directory) is normally
# <supabase docker dir>/cms.
#
#   cms/install.sh [options] sql              1. install the database migration (sql/install.sql, as postgres; safe to repeat)
#   cms/install.sh [options] env              2. prepare .env: image, cms_api in PGRST_DB_SCHEMAS, COMPOSE_FILE (Envoy or Kong), checks
#                                                then:  docker compose up -d --wait
#   cms/install.sh [options] admin <email>    3. first admin: role cms_admin, invitation link, role assignment
#   cms/install.sh [options] check            4. smoke test through the public URL (routes, OAuth server, PostgREST)
#   cms/install.sh [options] all <email>      sql, env, `docker compose up -d --wait`, admin, check
#   cms/install.sh [options] brand <schema> [--label "Name"] [--no-tables] [--no-agency] [--bucket B | --no-bucket] [--no-settings]
#                                             a new brand schema: rights, RLS, audit, exposure (docs/brand-bootstrap.md; repeatable)
#   cms/install.sh [options] agency <name> [--label "Name"] [--brand S]... [--remove-brand S]...
#                                             an agency for several brands: role agency_<name>, member of agency_<brand> (repeatable)
# The order matters: PostgREST refuses to start when PGRST_DB_SCHEMAS names a schema that does not exist yet.
#
# Options:
#   --docker-dir DIR     the Supabase docker directory (default: the parent of this folder if it holds docker-compose.yml, else .)
#   --public-url URL     the address people use for Supabase (https://supabase.example.com): sets SUPABASE_PUBLIC_URL,
#                        API_EXTERNAL_URL (=URL/auth/v1) and SITE_URL in .env      [env]
#   --gateway envoy|kong force the gateway (default: kong if COMPOSE_FILE names docker-compose.kong.yml, else envoy)  [env]
#   --generate-keys      run upstream's utils/add-new-auth-keys.sh --update-env when JWT_KEYS / SUPABASE_SECRET_KEY are empty  [env]
#   --db-url URL         install the migration with psql against this URL instead of the `db` container (external Postgres)   [sql]
#   --url URL            where `check` and `admin` reach the gateway (default SUPABASE_PUBLIC_URL; use http://localhost:<port> when
#                        the public address is not reachable from this machine yet)
set -euo pipefail

PKG=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok   %s\n' "$*"; }
warn() { printf '   WARN %s\n' "$*"; }
bad() { printf '   FAIL %s\n' "$*"; FAILED=1; }
FAILED=0

DIR="" PUBLIC_URL="" GATEWAY="" GENERATE_KEYS=0 DB_URL="" GW_URL=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --docker-dir) DIR=${2:?}; shift 2 ;;
    --public-url) PUBLIC_URL=${2:?}; shift 2 ;;
    --gateway) GATEWAY=${2:?}; shift 2 ;;
    --generate-keys) GENERATE_KEYS=1; shift ;;
    --db-url) DB_URL=${2:?}; shift 2 ;;
    --url) GW_URL=${2:?}; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
CMD=${ARGS[0]:-}
[ -n "$CMD" ] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

if [ -z "$DIR" ]; then
  if [ -f "$PKG/../docker-compose.yml" ]; then DIR=$(cd "$PKG/.." && pwd); else DIR=$(pwd); fi
fi
[ -f "$DIR/docker-compose.yml" ] || die "no docker-compose.yml in $DIR — pass --docker-dir <the Supabase docker directory>"
ENV_FILE="$DIR/.env"
[ -f "$ENV_FILE" ] || die "no .env in $DIR — create it first (upstream: sh setup.sh, or cp .env.example .env and sh utils/generate-keys.sh)"

# ── .env helpers (values never printed) ──────────────────────────────────────────────────────
envval() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" | tr -d '\r'; }
setenv() {  # setenv KEY VALUE — replace the line or append it
  local tmp; tmp=$(mktemp)
  KEY=$1 VAL=$2 awk 'BEGIN{k=ENVIRON["KEY"]; v=ENVIRON["VAL"]; done=0}
    $0 ~ "^"k"=" { if(!done){print k"="v; done=1}; next } {print}
    END{ if(!done) print k"="v }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"     # keep the file's mode and owner
}
backup_env() { [ -n "${BACKED_UP:-}" ] || { cp -p "$ENV_FILE" "$ENV_FILE.bak.cms-$(date +%Y%m%d%H%M%S)"; BACKED_UP=1; echo "   backup of .env written next to it (.env.bak.cms-…)"; }; }
gw_url() { echo "${GW_URL:-$(envval SUPABASE_PUBLIC_URL)}"; }

dc() { (cd "$DIR" && docker compose "$@"); }

# ── env ──────────────────────────────────────────────────────────────────────────────────────
cmd_env() {
  step "prepare .env ($ENV_FILE)"
  [ "$(basename "$PKG")" = cms ] && [ "$(cd "$PKG/.." && pwd)" = "$DIR" ] \
    || warn "the package folder is not $DIR/cms — set CMS_PKG_DIR in .env to its path relative to $DIR (or absolute)"

  # image: take the one in env.example (the release's own tag) unless already set
  if [ -z "$(envval CMS_IMAGE)" ]; then
    img=$(grep -E '^CMS_IMAGE=' "$PKG/env.example" | head -1 | cut -d= -f2-)
    backup_env; setenv CMS_IMAGE "$img"; ok "CMS_IMAGE=$img"
  else ok "CMS_IMAGE is set"; fi

  if [ -n "$PUBLIC_URL" ]; then
    [[ "$PUBLIC_URL" =~ ^https?://[A-Za-z0-9.:-]+$ ]] || die "--public-url must look like https://supabase.example.com (no path, no trailing slash)"
    backup_env
    setenv SUPABASE_PUBLIC_URL "$PUBLIC_URL"; setenv API_EXTERNAL_URL "$PUBLIC_URL/auth/v1"; setenv SITE_URL "$PUBLIC_URL"
    ok "public URL $PUBLIC_URL (SUPABASE_PUBLIC_URL, API_EXTERNAL_URL, SITE_URL)"
  fi
  pub=$(envval SUPABASE_PUBLIC_URL)
  [ "$(envval API_EXTERNAL_URL)" = "$pub/auth/v1" ] && ok "API_EXTERNAL_URL = SUPABASE_PUBLIC_URL/auth/v1" \
    || bad "API_EXTERNAL_URL must be SUPABASE_PUBLIC_URL + /auth/v1 (it is the token issuer the MCP server checks); use --public-url"
  [ "$(envval SITE_URL)" = "$pub" ] && ok "SITE_URL = SUPABASE_PUBLIC_URL (OAuth consent page lives on the gateway host)" \
    || warn "SITE_URL differs from SUPABASE_PUBLIC_URL: the consent page is opened at SITE_URL + /oauth/consent, so that host must route /oauth/consent to the plugin"
  case "$pub" in https://*) ok "public URL is https" ;; *) warn "public URL is not https: Claude and ChatGPT only connect to https addresses (fine for local tests)" ;; esac

  # PostgREST must serve cms_api
  cur=$(envval PGRST_DB_SCHEMAS)
  if [[ ",$cur," == *",cms_api,"* ]]; then ok "PGRST_DB_SCHEMAS contains cms_api"
  else backup_env; setenv PGRST_DB_SCHEMAS "${cur:+$cur,}cms_api"; ok "cms_api added to PGRST_DB_SCHEMAS"; fi

  # keys that upstream ships empty
  missing=""; for k in JWT_KEYS JWT_JWKS SUPABASE_SECRET_KEY; do [ -n "$(envval $k)" ] || missing="$missing $k"; done
  if [ -n "$missing" ]; then
    if [ "$GENERATE_KEYS" = 1 ]; then
      backup_env; (cd "$DIR" && sh utils/add-new-auth-keys.sh --update-env >/dev/null) && ok "generated JWT_KEYS, JWT_JWKS and the opaque API keys"
    else
      bad "empty in .env:$missing — run  (cd $DIR && sh utils/add-new-auth-keys.sh --update-env)  or use --generate-keys"
    fi
  else ok "JWT_KEYS, JWT_JWKS, SUPABASE_SECRET_KEY are set"; fi

  # COMPOSE_FILE: upstream's native layering
  cf=$(envval COMPOSE_FILE); cf=${cf:-docker-compose.yml}
  if [ -z "$GATEWAY" ]; then case ":$cf:" in *docker-compose.kong.yml*) GATEWAY=kong ;; *) GATEWAY=envoy ;; esac; fi
  [ "$GATEWAY" = envoy ] || [ "$GATEWAY" = kong ] || die "--gateway must be envoy or kong"
  [ "$GATEWAY" != kong ] || case ":$cf:" in *docker-compose.kong.yml*) ;; *) die "Kong: add upstream's Kong override first (cd $DIR && sh run.sh config add kong), then run this again" ;; esac
  rel=cms; [ -n "$(envval CMS_PKG_DIR)" ] && rel=$(envval CMS_PKG_DIR)
  new=$cf
  for f in "$rel/docker-compose.cms.yml" "$rel/docker-compose.$GATEWAY.yml"; do case ":$new:" in *":$f:"*) ;; *) new="$new:$f" ;; esac; done
  if [ "$new" != "$cf" ]; then backup_env; setenv COMPOSE_FILE "$new"; ok "COMPOSE_FILE extended ($GATEWAY gateway)"; else ok "COMPOSE_FILE already names the package ($GATEWAY gateway)"; fi

  if dc config >/dev/null 2>"${TMPDIR:-/tmp}/cms-config.err"; then ok "docker compose config is valid"
  else bad "docker compose config fails: $(head -3 "${TMPDIR:-/tmp}/cms-config.err" | tr '\n' ' ')"; fi
  [ "$FAILED" = 0 ] || die ".env needs attention (see FAIL lines)"
  echo; echo "Next:  cd $DIR && docker compose up -d --wait   then   $0 admin <email>"
}

# ── sql ──────────────────────────────────────────────────────────────────────────────────────
sqlfile() {
  for d in "$PKG/sql" "$PKG/../../packages/sql"; do [ -f "$d/$1" ] && { echo "$d/$1"; return; }; done
  die "$1 not found next to the package (sql/) — is this the full release?"
}
psql_owner() {   # as postgres: what the SQL editor of Supabase Cloud does
  if [ -n "$DB_URL" ]; then psql -X -q -v ON_ERROR_STOP=1 "$DB_URL" "$@"
  else dc exec -T db psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres "$@"; fi
}
cmd_sql() {
  step "database migration (sql/install.sql, as postgres)"
  f=$(sqlfile install.sql)
  out=$(psql_owner -o /dev/null < "$f" 2>&1) || { echo "$out" >&2; die "install.sql failed (see docs/install-selfhosted.md → Troubleshooting)"; }
  v=$(psql_owner -Atc "select max(version) from cms.schema_version")
  ok "installed, schema version $v"
  psql_owner -c "notify pgrst, 'reload schema'" >/dev/null && ok "PostgREST told to reload its schema"
}

# ── admin ────────────────────────────────────────────────────────────────────────────────────
cmd_admin() {
  email=${ARGS[1]:-}; [[ "$email" =~ ^[^[:space:]@\'\"\;\\]+@[A-Za-z0-9.-]+$ ]] || die "usage: install.sh admin <email>"
  step "first admin: $email"
  key=$(envval SUPABASE_SECRET_KEY); [ -n "$key" ] || die "SUPABASE_SECRET_KEY is empty in .env"
  psql_owner >/dev/null <<'SQL'
-- group role for admins: no login, no DDL; rights on data come from brand-bootstrap / your own GRANTs
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'cms_admin') then create role cms_admin nologin; end if;
end $$;
comment on role cms_admin is 'Group: CMS admins (cms.settings.admin_roles). Invite people, assign roles, read the audit log.';
grant cms_admin to authenticator;
update cms.settings set admin_roles = (select array_agg(distinct r order by r) from unnest(admin_roles || '{cms_admin}'::name[]) r), updated_at = now();
grant usage on schema audit to cms_admin;
grant select on audit.change_log to cms_admin;
SQL
  ok "role cms_admin exists and is the admin role"
  uid=$(psql_owner -Atc "select id from auth.users where lower(email) = lower('$email')" 2>/dev/null || true)
  link=""
  if [ -z "$uid" ]; then
    # an invitation creates the person and gives a one-time link that opens the "choose a password" page of the CMS
    resp=$(curl -sS -X POST "$(gw_url)/auth/v1/admin/generate_link" -H @<(printf 'apikey: %s\n' "$key") \
      -H 'Content-Type: application/json' -d "{\"type\":\"invite\",\"email\":\"$email\",\"redirect_to\":\"$(envval SUPABASE_PUBLIC_URL)/cms/\"}") \
      || die "cannot reach $(gw_url) — is the stack up? (use --url if the public address is not reachable from here)"
    link=$(printf '%s' "$resp" | sed -n 's/.*"action_link":"\([^"]*\)".*/\1/p' | sed 's/\\u0026/\&/g')
    uid=$(psql_owner -Atc "select id from auth.users where lower(email) = lower('$email')" 2>/dev/null || true)
    [ -n "$uid" ] || die "the Auth API did not create the person: $(printf '%s' "$resp" | head -c 200)"
    ok "person created (invited)"
  else ok "person exists already"; fi
  psql_owner -c "insert into cms.user_roles (user_id, db_role) values ('$uid', 'cms_admin') on conflict (user_id) do update set db_role = excluded.db_role" >/dev/null
  ok "role cms_admin assigned"
  if [ -n "$link" ]; then
    cat <<EOF

   One-time sign-in link for $email (opens the CMS and asks for a password; valid for a day):

   $link

EOF
  else
    echo "   $email can sign in at $(envval SUPABASE_PUBLIC_URL)/cms/ with their existing password (or 'Forgot password?')."
  fi
}

# ── check ────────────────────────────────────────────────────────────────────────────────────
cmd_check() {
  gw=$(gw_url); pub=$(envval SUPABASE_PUBLIC_URL)
  step "smoke test through $gw"
  http() { curl -sS -o "$TMPF" -D "$TMPH" -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || echo 000; }
  TMPF=$(mktemp); TMPH=$(mktemp); trap 'rm -f "$TMPF" "$TMPH"' EXIT
  t() {  # t <description> <expected status regex> <curl args…>
    local d=$1 want=$2; shift 2; local c; c=$(http "$@")
    if [[ "$c" =~ ^($want)$ ]]; then ok "$d → $c"; else bad "$d → $c (expected $want)"; fi
  }
  t "CMS UI served (GET /cms/)" 200 "$gw/cms/"
  t "UI runtime config (GET /cms/config.json)" 200 "$gw/cms/config.json"
  grep -q '"supabaseUrl"' "$TMPF" || bad "/cms/config.json has no supabaseUrl"
  t "MCP endpoint answers without a token (POST /cms/mcp)" 401 -X POST -H 'Content-Type: application/json' -d '{}' "$gw/cms/mcp"
  grep -qi '^www-authenticate:.*resource_metadata' "$TMPH" && ok "…with the resource_metadata hint" || bad "401 lacks WWW-Authenticate resource_metadata"
  t "protected-resource metadata (/.well-known/oauth-protected-resource/cms/mcp)" 200 "$gw/.well-known/oauth-protected-resource/cms/mcp"
  grep -q "$pub/auth/v1" "$TMPF" && ok "…names $pub/auth/v1 as authorization server" || bad "metadata does not name $pub/auth/v1 (API_EXTERNAL_URL / PUBLIC_BASE_URL?)"
  t "OAuth server metadata (/.well-known/oauth-authorization-server/auth/v1)" 200 "$gw/.well-known/oauth-authorization-server/auth/v1"
  grep -q 'registration_endpoint' "$TMPF" && ok "…dynamic client registration is on" || bad "no registration_endpoint (GOTRUE_OAUTH_SERVER_* not applied? recreate auth)"
  # the known gap of upstream gateways: /auth/v1/oauth/* needs an apikey. An empty body is rejected by GoTrue itself (400)
  # — which proves the request got through the gateway without an apikey and registers nothing.
  t "OAuth routes open without apikey (POST /auth/v1/oauth/clients/register, empty body)" 400 -X POST -H 'Content-Type: application/json' -d '{}' "$gw/auth/v1/oauth/clients/register"
  t "rest of /auth/v1 still needs an apikey (GET /auth/v1/user)" 401 "$gw/auth/v1/user"
  t "consent page forwards to the UI (GET /oauth/consent)" '200|302' "$gw/oauth/consent"
  # cms_api exposed? anon is refused by describe() itself (403/401), an unexposed schema would answer 404/406
  anon=$(envval ANON_KEY)
  t "cms_api is served by PostgREST (rpc/describe as anon is refused, not unknown)" '401|403' -X POST -H @<(printf 'apikey: %s\n' "$anon") \
    -H 'Content-Profile: cms_api' -H 'Content-Type: application/json' -d '{}' "$gw/rest/v1/rpc/describe"
  if [ -n "$(dc ps -q db 2>/dev/null)" ] || [ -n "$DB_URL" ]; then
    n=$(psql_owner -Atc "select count(*) from cms.user_roles ur join cms.settings s on ur.db_role = any(s.admin_roles)" 2>/dev/null || echo "?")
    [ "$n" != "?" ] && ok "database: plugin installed, $n admin(s) assigned" || bad "database: cms schema not installed (run: install.sh sql)"
  fi
  [ "$FAILED" = 0 ] && { echo; echo "All checks passed. Open $pub/cms/"; } || { echo; echo "Some checks failed — see docs/install-selfhosted.md → Troubleshooting"; exit 1; }
}

# ── brand ────────────────────────────────────────────────────────────────────────────────────
psql_admin() {   # as supabase_admin (self-hosted superuser, unix socket in the db container)
  if [ -n "$DB_URL" ]; then psql -X -q -v ON_ERROR_STOP=1 "$DB_URL" "$@"
  else dc exec -T db psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres "$@"; fi
}
cmd_brand() {
  schema=${ARGS[1]:-}; [[ "$schema" =~ ^[a-z_][a-z0-9_]{0,55}$ ]] || die "usage: install.sh brand <schema> [--label ..] [--no-tables] [--no-agency] [--bucket B|--no-bucket] [--no-settings]  (schema: a-z, 0-9, _)"
  label="" tables=template agency=yes bucket=images settings=yes
  set -- "${ARGS[@]:2}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) label=${2:?}; shift 2 ;; --no-tables) tables=none; shift ;; --no-agency) agency=no; shift ;;
      --bucket) bucket=${2:?}; shift 2 ;; --no-bucket) bucket=""; shift ;; --no-settings) settings=no; shift ;; *) die "unknown brand option $1" ;;
    esac
  done
  step "brand $schema: schema, tables, rights, audit"
  out=$(psql_admin -v schema="$schema" -v label="$label" -v tables="$tables" -v agency="$agency" -v bucket="$bucket" -v settings="$settings" -At \
    < "$(sqlfile brand-bootstrap.sql)" 2>&1) || { echo "$out" | grep -E 'ERROR|DETAIL|HINT' >&2; die "the brand SQL failed; nothing was exposed (the statement is repeatable once the cause is fixed)"; }
  printf '%s\n' "$out" | grep -v '^$' | grep -v '|' | sed 's/^/   /' || true
  cur=$(envval PGRST_DB_SCHEMAS)
  if [[ ",$cur," == *",$schema,"* ]]; then ok "already exposed in PGRST_DB_SCHEMAS"
  else
    backup_env; setenv PGRST_DB_SCHEMAS "$cur,$schema"; ok "$schema added to PGRST_DB_SCHEMAS; recreating rest + studio"
  fi
  # recreate only what changed; also repairs a PostgREST that could not start before the schema existed
  dc up -d --no-deps --wait rest studio >/dev/null 2>&1 || warn "could not recreate rest/studio — run: docker compose up -d rest studio"
  # A recreated container gets a new address; Envoy and Kong re-resolve names only every few seconds and Envoy waits for health
  # checks, so for up to ~25 s the old address (possibly reused by another container, e.g. Studio) is still used. Restart the gateway.
  dc restart api-gw >/dev/null 2>&1 || warn "could not restart the gateway — run: docker compose restart api-gw"
  psql_admin -c "notify pgrst, 'reload schema'" >/dev/null
  key=$(envval SERVICE_ROLE_KEY); code=000
  for attempt in 1 2; do
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      code=$(curl -s -o /dev/null -w '%{http_code}' "$(gw_url)/rest/v1/" -H @<(printf 'apikey: %s\n' "$key") -H "Accept-Profile: $schema" || true)
      [ "$code" = 200 ] && break; sleep 1
    done
    [ "$code" = 200 ] && break
    [ "$attempt" = 1 ] && { warn "PostgREST answers $code; restarting it once"; dc restart rest >/dev/null 2>&1 || true; sleep 3; }
  done
  [ "$code" = 200 ] && ok "PostgREST serves schema $schema" || bad "PostgREST does not serve $schema yet (HTTP $code) — see docs/brand-bootstrap.md, checklist"
  [ "$FAILED" = 0 ] || exit 1
  echo; echo "Done. Sign in to the CMS again so the menu is rebuilt; assign people under Admin → People (role agency_$schema or cms_admin)."
}

# ── agency for several brands ────────────────────────────────────────────────────────────────
cmd_agency() {
  name=${ARGS[1]:-}; [[ "$name" =~ ^[a-z_][a-z0-9_]{0,55}$ ]] || die "usage: install.sh agency <name> [--label ..] [--brand S]... [--remove-brand S]...  (name: a-z, 0-9, _)"
  label="" add="" del=""
  set -- "${ARGS[@]:2}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) label=${2:?}; shift 2 ;; --brand) add="${add:+$add,}${2:?}"; shift 2 ;;
      --remove-brand) del="${del:+$del,}${2:?}"; shift 2 ;; *) die "unknown agency option $1" ;;
    esac
  done
  step "agency $name: role agency_$name and its brands"
  out=$(psql_admin -v name="$name" -v label="$label" -v brands="$add" -v remove="$del" -At < "$(sqlfile agency.sql)" 2>&1) \
    || { echo "$out" | grep -E 'ERROR|DETAIL|HINT' >&2; die "the agency SQL failed (the statement is repeatable once the cause is fixed)"; }
  printf '%s\n' "$out" | grep -v '^$' | grep -v '|' | sed 's/^/   /' || true
  echo; echo "Done. Assign people under Admin → People (role agency_$name); it takes effect with their next sign-in."
}

case "$CMD" in
  brand) cmd_brand ;;
  agency) cmd_agency ;;
  env) cmd_env ;;
  sql) cmd_sql ;;
  admin) cmd_admin ;;
  check) cmd_check ;;
  all)
    [ -n "${ARGS[1]:-}" ] || die "usage: install.sh all <admin-email>"
    cmd_sql; cmd_env
    step "docker compose up -d --wait"
    dc up -d --wait --wait-timeout 300 --quiet-pull 2>&1 | grep -vE ' (Running|Created|Creating|Recreate|Recreated|Started|Starting|Waiting|Healthy)$' || true
    cmd_admin; cmd_check ;;
  *) die "unknown step '$CMD' (env | sql | admin | check | all | brand | agency)" ;;
esac
