#!/usr/bin/env bash
# Install/upgrade the plugin (packages/sql/install.sql, as postgres) and (re)create the demo on top:
# schemas, roles, plugin settings, test users, data and storage files.
# Idempotent and deterministic — running it twice yields the same state. Leaves the rest of the
# instance (auth config, other schemas) alone. Prints no secrets.
source "$(dirname "$0")/lib.sh"
need_env

GW=$(gw_url)
SERVICE_KEY=$(envval SERVICE_ROLE_KEY)
PW=$(envval TEST_USER_PASSWORD)
api() {  # api METHOD PATH [curl args...] — gateway call as service_role, prints HTTP status
  local m=$1 p=$2; shift 2
  curl -s -o /dev/null -w '%{http_code}' -X "$m" "$GW$p" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" "$@"
}

# Demo files into the buckets through the Storage API (works with either storage backend).
seed_storage() {
  step "storage files (backend: $(envval STORAGE_BACKEND 2>/dev/null || true))"
  for b in images hr-files; do
    echo "   empty bucket $b → HTTP $(api POST "/storage/v1/bucket/$b/empty")"
    ( cd "$ROOT/demo/files/$b" && find . -type f | sed 's|^\./||' | sort ) | while read -r obj; do
      case "$obj" in *.png) ct=image/png ;; *.md) ct=text/markdown ;; *) ct=application/octet-stream ;; esac
      echo "   $b/$obj → HTTP $(api POST "/storage/v1/object/$b/$obj" -H "Content-Type: $ct" -H 'x-upsert: true' \
        --data-binary "@$ROOT/demo/files/$b/$obj")"
    done
  done
}

# scripts/seed.sh --storage-only: only re-upload the demo files (e.g. after switching the storage backend)
if [ "${1:-}" = "--storage-only" ]; then seed_storage; exit 0; fi

step "clean previous demo state"
psql_admin <<'SQL'
do $$ begin
  if to_regclass('cms.user_roles') is not null then delete from cms.user_roles; end if;
  if to_regclass('audit.change_log') is not null then truncate audit.change_log restart identity; end if;
end $$;
-- test users (and their sessions, identities, OAuth grants via FK cascade) + dynamically registered clients
delete from auth.users where email like '%@example.com';
delete from auth.oauth_clients;
SQL

step "plugin: packages/sql/install.sql (as postgres, like on Supabase Cloud)"
out=$(psql_owner -o /dev/null < "$ROOT/packages/sql/install.sql" 2>&1) || { echo "$out"; die "install.sql failed"; }
echo "   install.sql ok (schema version $(psql_admin -Atc 'select max(version) from cms.schema_version'))"

step "demo SQL"
demo_sql() { out=$(psql_admin -o /dev/null < "$ROOT/demo/sql/$1" 2>&1) || { echo "$out"; die "$1 failed"; }; echo "   demo/sql/$1 ok"; }
demo_sql 00-demo-schema.sql
# the demo brands are built like every other brand (docs/brand-bootstrap.md)
for brand in nordwind:Nordwind suedwind:Südwind; do
  out=$(psql_admin -o /dev/null -v schema="${brand%%:*}" -v label="${brand#*:}" -v tables=template -v agency=yes -v bucket=images \
        -v settings=yes < "$ROOT/scripts/sql/brand-bootstrap.sql" 2>&1) || { echo "$out"; die "brand bootstrap ${brand%%:*} failed"; }
  echo "   brand bootstrap ${brand%%:*} ok"
done
# an agency for both brands (docs/brand-bootstrap.md, "Agentur für mehrere Marken")
out=$(psql_admin -o /dev/null -v name=northstar -v label='Northstar Agency' -v brands=nordwind,suedwind -v remove= \
      < "$ROOT/scripts/sql/agency.sql" 2>&1) || { echo "$out"; die "agency northstar failed"; }
echo "   agency northstar (nordwind, suedwind) ok"
for f in 10-roles.sql 20-plugin-settings.sql 30-postgrest.sql; do demo_sql "$f"; done
# PostgREST caches the schema; reload so new tables/roles are visible immediately.
psql_admin -c "notify pgrst, 'reload schema'; notify pgrst, 'reload config';"

step "test users (GoTrue admin API, fixed ids, password = TEST_USER_PASSWORD in .env)"
i=0
for email in admin@example.com agentur.nordwind@example.com agentur.suedwind@example.com hr@example.com ohne.rolle@example.com; do
  i=$((i + 1))
  id=$(printf '00000000-0000-4000-8000-%012d' $i)
  code=$(api POST /auth/v1/admin/users -H 'Content-Type: application/json' \
    -d "{\"id\":\"$id\",\"email\":\"$email\",\"password\":\"$PW\",\"email_confirm\":true}")
  echo "   $email → HTTP $code"
  [ "$code" = "200" ] || die "user creation failed"
done

step "demo data"
psql_admin < "$ROOT/demo/sql/seed.sql" && echo "   seed.sql ok"
# The seed rows themselves are not "changes" — start every reset with an empty audit log.
psql_admin -c "truncate audit.change_log restart identity"

seed_storage

step "summary"
psql_admin -At <<'SQL'
select format('   %-26s %s', t, n) from (
  select 'nordwind.products' t, count(*) n from nordwind.products union all
  select 'suedwind.products', count(*) from suedwind.products union all
  select 'nordwind+suedwind.faq', (select count(*) from nordwind.faq) + (select count(*) from suedwind.faq) union all
  select 'public.documents', count(*) from public.documents union all
  select 'storage.objects', count(*) from storage.objects union all
  select 'cms.user_roles', count(*) from cms.user_roles) s;
SQL
