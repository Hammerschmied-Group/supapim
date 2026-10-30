#!/usr/bin/env bash
# Proves docs/install-selfhosted.md on a throwaway stack: a fresh upstream Supabase (tag in stack/SUPABASE_VERSION) in its own
# Compose project, own container names, own ports and own volumes — then the release archive is unpacked into it and installed
# exactly like the guide says, with a stopwatch. It never touches another stack (no supabase-* container, no 553xx port).
#
#   scripts/test-package.sh envoy|kong [--keep] [--no-chain] [--port 55621]
#
#   --keep       leave the stack running afterwards (default: remove containers, volumes and files again)
#   --no-chain   skip the full end-to-end chain (demo data + scripts/test-chain.mjs) — the install and the smoke checks still run
#   --port N     gateway port on 127.0.0.1 (default 55621 for envoy, 55631 for kong); N+1.. are used for the pooler
#
# Timing lines start with "TIME". Needs Docker, git, curl, openssl, node ≥ 22. Files go to $TMPDIR/cms-package-test-<gateway>.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
GW=${1:-}; shift || true
[ "$GW" = envoy ] || [ "$GW" = kong ] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
KEEP=0 CHAIN=1 PORT=$([ "$GW" = envoy ] && echo 55621 || echo 55631)
while [ $# -gt 0 ]; do case "$1" in --keep) KEEP=1; shift ;; --no-chain) CHAIN=0; shift ;; --port) PORT=${2:?}; shift 2 ;; *) echo "unknown option $1" >&2; exit 1 ;; esac; done

VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json" | head -1)
TAG=$(cat "$ROOT/stack/SUPABASE_VERSION")
PROJECT=cmspkg_$GW
WORK=${TMPDIR:-/tmp}/cms-package-test-$GW
DOCKER_DIR=$WORK/supabase
[[ "$PORT" =~ ^55[0-9]{3}$ ]] || { echo "refusing port $PORT: use 55xxx, never the 553xx range of the shared stack" >&2; exit 1; }
[[ "$PORT" =~ ^553 ]] && { echo "refusing port $PORT (shared stack)" >&2; exit 1; }

t0=$(date +%s); lap() { printf 'TIME %-46s %4d s\n' "$1" $(( $(date +%s) - ${2:-$t0} )); }
step() { printf '\n== %s\n' "$*"; }
dcd() { (cd "$DOCKER_DIR" && docker compose "$@"); }
cleanup() {
  [ "$KEEP" = 1 ] && { echo; echo "kept: $WORK (project $PROJECT). Remove with: (cd $DOCKER_DIR && docker compose down -v --remove-orphans) and rm -rf $WORK (db data needs a container: docker run --rm -v $DOCKER_DIR/volumes:/v alpine rm -rf /v/db/data)"; return; }
  step "remove the throwaway stack"
  [ -d "$DOCKER_DIR" ] && dcd down -v --remove-orphans >/dev/null 2>&1 || true
  [ -d "$DOCKER_DIR/volumes/db/data" ] && docker run --rm -v "$DOCKER_DIR/volumes:/v" alpine:3.22 sh -c 'rm -rf /v/db/data' >/dev/null 2>&1 || true
  rm -rf "$WORK"
  echo "   removed containers, volumes, network and $WORK"
}
trap cleanup EXIT
rm -rf "$WORK"; mkdir -p "$WORK"

# ── 0. the release archive (what a customer downloads) ───────────────────────────────────────
step "0. release archive for $VERSION (with the image inside)"
"$ROOT/scripts/build-package.sh" --with-image --out "$WORK/dist" >/dev/null
ls -lh "$WORK/dist"/*.tar.gz | awk '{print "   " $5 "  " $NF}' | sed "s|$WORK/||"

# ── 1. an existing Supabase: upstream's docker directory, upstream's own key scripts ─────────
step "1. fresh upstream Supabase $TAG (not timed as plugin install)"
s=$(date +%s)
git clone -q --depth 1 --branch "$TAG" --filter=blob:none --sparse https://github.com/supabase/supabase.git "$WORK/src" 2>/dev/null
git -C "$WORK/src" sparse-checkout set docker
mkdir -p "$DOCKER_DIR"; cp -R "$WORK/src/docker/." "$DOCKER_DIR/"; rm -rf "$WORK/src"
cd "$DOCKER_DIR"
# upstream's checkout has no volumes/db/data; without it Docker Desktop creates the bind source inside its VM, where it outlives
# the test directory and the next run starts on a database with the old passwords
mkdir -p volumes/db/data
cp .env.example .env
sh utils/generate-keys.sh --update-env >/dev/null           # legacy keys + secrets; JWT_KEYS stays empty on purpose
set_kv() { if grep -q "^$1=" .env; then awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > .env.n && cat .env.n > .env && rm .env.n; else echo "$1=$2" >> .env; fi; }
set_kv COMPOSE_PROJECT_NAME "$PROJECT"
set_kv API_GW_HTTP_PORT "$PORT"; set_kv KONG_HTTP_PORT "$PORT"; set_kv KONG_HTTPS_PORT $((PORT + 7))
set_kv SUPABASE_PUBLIC_URL "http://localhost:$PORT"; set_kv API_EXTERNAL_URL "http://localhost:$PORT/auth/v1"
set_kv POOLER_TENANT_ID cmspkg; set_kv DISABLE_SIGNUP true; set_kv OPENAI_API_KEY ''
set_kv TEST_USER_PASSWORD "$(openssl rand -hex 12)"
set_kv POSTGRES_PORT $((PORT + 1)); set_kv POOLER_PROXY_PORT_TRANSACTION $((PORT + 8))
# isolation: no fixed container names (they would clash with the running stack), aliases keep the internal names, ports on
# localhost only, file storage in a named volume (Docker Desktop on macOS has no xattrs on bind mounts)
{
  echo "services:"
  for svc in $(docker compose -f docker-compose.yml config --services 2>/dev/null); do
    old=$(docker compose -f docker-compose.yml config --format json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['services']['$svc'].get('container_name',''))")
    echo "  $svc:"
    if [ -n "$old" ]; then echo "    container_name: !reset null"; echo "    networks: { default: { aliases: [$old] } }"; fi
    [ "$svc" = api-gw ] && printf '    ports: !override\n      - 127.0.0.1:%s:8000/tcp\n' "$PORT"
    [ "$svc" = supavisor ] && printf '    ports: !override\n      - 127.0.0.1:%s:5432\n      - 127.0.0.1:%s:6543\n' $((PORT + 1)) $((PORT + 8))
    [ "$svc" = storage ] && printf '    volumes: !override\n      - storage-data:/var/lib/storage\n'
    [ "$svc" = imgproxy ] && printf '    volumes: !override\n      - storage-data:/var/lib/storage\n'
  done
  printf 'volumes:\n  storage-data:\n'
} > isolation.yml
if [ "$GW" = kong ]; then
  set_kv COMPOSE_FILE docker-compose.yml:isolation.yml:docker-compose.kong.yml
  # upstream's Kong override publishes its own ports; keep them on localhost too
  cat >> isolation.yml <<EOF
EOF
  printf 'services:\n  api-gw:\n    ports: !override\n      - 127.0.0.1:%s:8000/tcp\n' "$PORT" > kong-ports.yml
  set_kv COMPOSE_FILE docker-compose.yml:docker-compose.kong.yml:isolation.yml:kong-ports.yml
else
  set_kv COMPOSE_FILE docker-compose.yml:isolation.yml
fi
dcd config >/dev/null
step "   start the existing stack"
# a cold database makes GoTrue's first health checks fail now and then (migrations); a second attempt is what an operator does too
dcd up -d --wait --wait-timeout 300 >/dev/null 2>"$WORK/up.err" || { echo "   first start failed ($(tail -1 "$WORK/up.err")), retrying once"; dcd up -d --wait --wait-timeout 300 >/dev/null 2>"$WORK/up.err" || { tail -20 "$WORK/up.err"; exit 1; }; }
lap "existing Supabase up (incl. image pulls, not part of the install)" "$s"
curl -s -o /dev/null -w '   gateway %{http_code} on the throwaway port\n' "http://localhost:$PORT/auth/v1/health" -H "apikey: $(grep ^ANON_KEY= .env | cut -d= -f2)"

# ── 2. the install, exactly like docs/install-selfhosted.md ──────────────────────────────────
step "2. install the plugin ($GW) — timed"
T=$(date +%s)
tar -xzf "$WORK/dist/supapim-selfhosted-$VERSION.tar.gz" -C "$DOCKER_DIR"                    # → ./cms/
docker load -i "$DOCKER_DIR/cms/image/supapim-$VERSION.oci.tar" >/dev/null                      # image without a registry
lap "unpack + load image" "$T"
cms/install.sh --public-url "http://localhost:$PORT" --generate-keys --gateway "$GW" all admin@example.com 2>&1 | tee "$WORK/install.log" | sed 's/^/   | /'
lap "INSTALL TOTAL (unpack → checks passed)" "$T"
grep -q 'All checks passed' "$WORK/install.log"

# ── 3. functional: the admin signs in, the token carries the role, the admin API lets the admin in ─
step "3. admin signs in (password set through the Auth admin API like the invitation page would), token + API"
KEY=$(grep ^SUPABASE_SECRET_KEY= .env | cut -d= -f2); ANON=$(grep ^ANON_KEY= .env | cut -d= -f2); U="http://localhost:$PORT"
uid=$(dcd exec -T db psql -X -At -h 127.0.0.1 -U postgres -d postgres -c "select id from auth.users where email='admin@example.com'")
pw=$(openssl rand -hex 12)
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$U/auth/v1/admin/users/$uid" -H @<(printf 'apikey: %s\n' "$KEY") -H 'Content-Type: application/json' -d "{\"password\":\"$pw\",\"email_confirm\":true}")
echo "   set password → HTTP $code"; [ "$code" = 200 ]
tok=$(curl -s -X POST "$U/auth/v1/token?grant_type=password" -H @<(printf 'apikey: %s\n' "$ANON") -H 'Content-Type: application/json' -d "{\"email\":\"admin@example.com\",\"password\":\"$pw\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
claim=$(printf '%s' "$tok" | python3 -c "import sys,json,base64; p=sys.stdin.read().split('.')[1]; d=json.loads(base64.urlsafe_b64decode(p+'='*(-len(p)%4))); print(d.get('role'), d.get('email'))")
echo "   token claims: role/email = $claim"; [ "$claim" = "cms_admin admin@example.com" ]
who=$(curl -s -X POST "$U/rest/v1/rpc/whoami" -H @<(printf 'apikey: %s\n' "$ANON") -H "Authorization: Bearer $tok" -H 'Content-Profile: cms_api' -H 'Content-Type: application/json' -d '{}')
echo "   cms_api.whoami → $(printf '%s' "$who" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('role'), 'admin' if d.get('is_admin') else 'no admin')")"
printf '%s' "$who" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('role')=='cms_admin' else 1)"
code=$(curl -s -o "$WORK/inv.json" -w '%{http_code}' -X POST "$U/cms/api/admin/invite" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d '{"email":"someone@example.com"}')
echo "   POST /cms/api/admin/invite as admin → HTTP $code ($(python3 -c "import json; d=json.load(open('$WORK/inv.json')); print(d.get('error') or 'ok')"))   [502 mail_failed = admin accepted, SMTP not configured]"
[[ "$code" =~ ^(200|502)$ ]]
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U/cms/api/admin/invite" -H 'Content-Type: application/json' -d '{"email":"x@example.com"}')
echo "   same without token → HTTP $code"; [ "$code" = 401 ]
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U/cms/api/admin/invite" -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' -d '{"email":"x@example.com"}')
echo "   same with the anon key as token → HTTP $code"; [[ "$code" =~ ^40[13]$ ]]
# hardening that lives in the package (Task 7 findings): storage objects carry CSP + nosniff, the admin API runs in its own container
hdr=$(curl -s -D - -o /dev/null "$U/storage/v1/object/public/images/does-not-exist.svg")
printf '%s' "$hdr" | grep -qi "^content-security-policy: default-src 'none'; sandbox" && printf '%s' "$hdr" | grep -qi '^x-content-type-options: nosniff'
echo "   /storage/v1/object/* answers with CSP + nosniff"
# F-22: the admin API must not reflect a foreign Origin (Envoy reflects every Origin unless the route has its own CORS policy)
for o in https://evil.example "$U"; do
  acao=$(curl -s -D - -o /dev/null -X OPTIONS "$U/cms/api/admin/invite" -H "Origin: $o" -H 'Access-Control-Request-Method: POST' | tr -d '\r' | grep -i '^access-control-allow-origin:' || true)
  echo "   OPTIONS /cms/api/admin/invite from $o → ${acao:-no allow-origin header}"
  if [ "$o" = https://evil.example ]; then [ -z "$acao" ]; elif [ "$GW" = envoy ]; then [ -n "$acao" ]; fi   # Kong sets no CORS headers there at all
done
[ "$(dcd exec -T cms printenv SUPABASE_SECRET_KEY 2>/dev/null | wc -c | tr -d ' ')" = 0 ]; echo "   container cms has no SUPABASE_SECRET_KEY"
[ "$(dcd exec -T cms-admin printenv SUPABASE_SECRET_KEY 2>/dev/null | wc -c | tr -d ' ')" != 0 ]; echo "   container cms-admin has it"
[ "$(dcd exec -T auth printenv GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION)" = true ]; echo "   Auth: password change needs re-authentication; JWT_EXP=$(dcd exec -T auth printenv GOTRUE_JWT_EXP)"
lap "install + functional checks" "$T"

# ── 4. second brand through the package ─────────────────────────────────────────────────────
step "4. new brand through install.sh brand (docs/brand-bootstrap.md)"
cms/install.sh brand testmarke --label "Testmarke" 2>&1 | sed 's/^/   | /'

# ── 5. the full chain: demo data + OAuth 2.1 → hook → MCP → PostgREST/Storage → audit, via THIS gateway ─
if [ "$CHAIN" = 1 ]; then
  step "5. end-to-end chain (scripts/test-chain.mjs) through the package gateway"
  R=$WORK/repo; mkdir -p "$R"; cp -R "$ROOT/scripts" "$ROOT/demo" "$ROOT/packages" "$R/"; cp "$ROOT/package.json" "$R/"
  mkdir -p "$R/stack"; ln -s "$DOCKER_DIR" "$R/stack/upstream"; cp .env "$R/.env"
  DBC=$(dcd ps -q db | head -1); DBN=$(docker inspect -f '{{.Name}}' "$DBC" | tr -d /)
  set_r() { if grep -q "^$1=" "$R/.env"; then awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$R/.env" > "$R/.env.n" && cat "$R/.env.n" > "$R/.env" && rm "$R/.env.n"; else echo "$1=$2" >> "$R/.env"; fi; }
  set_r PGRST_DB_SCHEMAS "$(grep ^PGRST_DB_SCHEMAS= .env | cut -d= -f2),nordwind,suedwind"
  sed -i.bak "s/supabase-db/$DBN/g" "$R/scripts/lib.sh" "$R/scripts/test-chain.mjs" "$R/scripts/test-storage.mjs" && rm -f "$R"/scripts/*.bak
  for sc in nordwind suedwind; do dcd exec -T db psql -X -q -U supabase_admin -d postgres -c "create schema if not exists $sc authorization postgres" >/dev/null; done
  # the demo schemas must be served by PostgREST before the demo SQL's notify; the package's own step for it is `brand`
  cp .env "$WORK/env.before-demo"; cat "$R/.env" > .env
  dcd up -d --no-deps --wait rest >/dev/null 2>&1
  dcd restart api-gw >/dev/null 2>&1   # a recreated container gets a new address; the gateway would keep using the old one for ~25 s
  for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/auth/v1/health" -H "apikey: $(grep ^ANON_KEY= .env | cut -d= -f2)")" = 200 ] && break; sleep 1; done
  ( cd "$R" && scripts/seed.sh 2>&1 | tail -14 | sed 's/^/   | /' )
  rc=0; ( cd "$R" && node scripts/test-chain.mjs > "$WORK/chain.log" 2>&1 ) || rc=$?
  grep -E 'PASS|FAIL' "$WORK/chain.log" | awk '/PASS/{p++} /FAIL/{print "   | " $0} END{print "   | chain: " p " PASS"}' | cut -c1-220
  tail -2 "$WORK/chain.log" | sed 's/^/   | /'
  [ "$rc" = 0 ] || { echo "   chain log kept: $WORK/chain.log"; KEEP=1; exit "$rc"; }
  lap "chain done" "$T"
fi
lap "TOTAL" "$t0"
echo; echo "PASS: $GW"
