#!/usr/bin/env bash
# Test the plugin migration in throwaway supabase/postgres containers (no stack, no network, no
# .env — runs the same in CI). Per Postgres image:
#   1. install, install again          → catalog diff must be empty (idempotent)
#   2. uninstall                       → catalog must equal the state before install
#   3. install + demo + tests          → all tests green
#   4. uninstall keeping the audit log → only audit.change_log left, rows intact
#   5. install over the kept log + demo + tests → green, old log rows still there
#   6. uninstall twice                 → no plugin residue
# The plugin is installed as postgres (like on Supabase Cloud), the demo as supabase_admin.
# Usage: scripts/test-sql.sh [image-tag ...]   default: 17.6.1.136 15.14.1.122
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SQL="$ROOT/packages/sql"
TAGS=("$@")
[ ${#TAGS[@]} -gt 0 ] || TAGS=(17.6.1.136 15.14.1.122)
WORK=$(mktemp -d)
# uninstall.sql refuses to run until the operator confirms the token hook is off (see its header)
{ echo "set cms.hook_disabled = on;"; cat "$SQL/uninstall.sql"; } > "$WORK/uninstall.sql"
C=""
cleanup() { [ -n "$C" ] && docker rm -f "$C" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT

failed=0
pass() { echo "   PASS  $*"; }
fail() { echo "   ** FAIL **  $*"; failed=$((failed + 1)); }
step() { printf '\n== %s\n' "$*"; }

# TCP on localhost (trust in the image's pg_hba). The unix socket needs a password for
# supabase_admin in 15.14.1.122 (scram), while 17.6.1.136 trusts it.
su()  { docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U supabase_admin -d postgres "$@"; }
own() { docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres "$@"; }
snap() { su -At < "$SQL/test/catalog.sql" > "$WORK/$1"; }
# run FILE as WHO (su|own); print the output only when it fails
apply() {
  local who=$1 file=$2 label=${3:-$(basename "$2")}
  if "$who" -o /dev/null < "$file" > "$WORK/out" 2>&1; then pass "$label"; else fail "$label"; sed 's/^/      /' "$WORK/out"; fi
}
same() {  # same LABEL A B — catalog snapshots must be identical
  if diff "$WORK/$2" "$WORK/$3" > "$WORK/diff"; then pass "$1 ($(wc -l < "$WORK/$2" | tr -d ' ') catalog lines)"
  else fail "$1"; head -40 "$WORK/diff" | sed 's/^/      /'; fi
}
residue() {  # residue LABEL [keep] — plugin leftovers must be empty
  local pre=""; [ "${2:-}" = keep ] && pre="set cms.keep_audit_log = on;"
  { echo "$pre"; cat "$SQL/test/residue.sql"; } | su -At > "$WORK/res"
  if [ ! -s "$WORK/res" ]; then pass "$1"; else fail "$1"; sed 's/^/      /' "$WORK/res"; fi
}
demo() {
  apply su "$ROOT/demo/sql/00-demo-schema.sql" "demo/sql/00-demo-schema.sql"
  for brand in nordwind:Nordwind suedwind:Südwind; do   # the demo brands come from the brand bootstrap, like any brand
    if su -o /dev/null -v schema="${brand%%:*}" -v label="${brand#*:}" -v tables=template -v agency=yes -v bucket=images -v settings=yes \
         < "$ROOT/scripts/sql/brand-bootstrap.sql" > "$WORK/out" 2>&1; then pass "brand bootstrap ${brand%%:*}"
    else fail "brand bootstrap ${brand%%:*}"; sed 's/^/      /' "$WORK/out"; fi
  done
  if su -o /dev/null -v name=northstar -v label='Northstar Agency' -v brands=nordwind,suedwind -v remove= \
       < "$ROOT/scripts/sql/agency.sql" > "$WORK/out" 2>&1; then pass "agency northstar (nordwind, suedwind)"
  else fail "agency northstar"; sed 's/^/      /' "$WORK/out"; fi
  for f in 10-roles.sql 20-plugin-settings.sql 30-postgrest.sql seed.sql; do
    apply su "$ROOT/demo/sql/$f" "demo/sql/$f"
  done
  apply su "$SQL/test/fixture/objects.sql" "fixture: storage objects"
}
tests() {
  if su -P pager=off < "$SQL/test/tests.sql" > "$WORK/tests" 2>&1; then
    pass "tests.sql: $(grep -A2 'passed | failed' "$WORK/tests" | tail -1 | awk '{print $1 " passed, " $3 " failed"}')"
  else
    fail "tests.sql"; grep -E 'FAIL|ERROR|passed|^ +[0-9]+ \| +[0-9]+$' "$WORK/tests" | sed 's/^/      /'
  fi
}

for tag in "${TAGS[@]}"; do
  img="supabase/postgres:$tag"
  step "$img"
  C="supabase-cms-sqltest-$$"
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker run -d --name "$C" --network none -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" "$img" >/dev/null
  # The image initialises, then restarts; TCP on localhost only answers once the final server runs.
  ready=0
  for _ in $(seq 1 90); do
    if docker exec "$C" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null \
       && [ "$(su -Atc "select to_regclass('auth.users') is not null" 2>/dev/null)" = t ]; then ready=1; break; fi
    sleep 2
  done
  [ $ready = 1 ] || { fail "database did not come up"; docker logs "$C" 2>&1 | tail -20; continue; }
  echo "   Postgres $(su -Atc 'show server_version')"
  apply su "$SQL/test/fixture/environment.sql" "fixture: storage tables + auth users (what the services would create)"

  step "1. install twice → identical catalog"
  snap s0
  apply own "$SQL/install.sql" "install.sql (as postgres)"
  snap s1
  apply own "$SQL/install.sql" "install.sql again"
  snap s2
  same "idempotent: second install changes nothing" s1 s2

  step "2. uninstall → back to the state before install"
  if own -o /dev/null < "$SQL/uninstall.sql" > "$WORK/out" 2>&1; then fail "uninstall.sql ran without confirming the hook is off"
  else pass "uninstall.sql refuses until the hook is confirmed off"; fi
  apply own "$WORK/uninstall.sql" "uninstall.sql (hook confirmed off)"
  snap s3
  same "clean: catalog equals the state before install" s0 s3
  residue "no plugin residue"

  step "3. install + demo + tests"
  apply own "$SQL/install.sql" "install.sql"
  demo
  tests

  step "4. uninstall, keep the audit log"
  su -c "update nordwind.products set price = price + 1 where sku = 'NW-1001'" >/dev/null   # one log row
  rows=$(su -Atc "select count(*) from audit.change_log")
  { echo "set cms.keep_audit_log = on;"; cat "$WORK/uninstall.sql"; } > "$WORK/uninstall-keep.sql"
  apply own "$WORK/uninstall-keep.sql" "uninstall.sql with cms.keep_audit_log = on"
  [ "$(su -Atc "select count(*) from audit.change_log")" = "$rows" ] && pass "audit.change_log kept ($rows rows)" || fail "audit.change_log rows lost"
  residue "nothing else left" keep

  step "5. reinstall over the kept log + demo + tests"
  apply own "$SQL/install.sql" "install.sql"
  [ "$(su -Atc "select count(*) from audit.change_log")" = "$rows" ] && pass "old log rows still there" || fail "old log rows lost"
  demo
  tests

  step "6. uninstall twice → no residue"
  apply own "$WORK/uninstall.sql" "uninstall.sql (hook confirmed off)"
  apply own "$WORK/uninstall.sql" "uninstall.sql again"
  residue "no plugin residue"

  docker rm -f "$C" >/dev/null 2>&1; C=""
done

echo
if [ $failed -eq 0 ]; then echo "ALL SQL CHECKS PASSED (${TAGS[*]})"; else echo "$failed CHECK(S) FAILED"; exit 1; fi
