#!/usr/bin/env bash
# Bootstrap a brand schema for the CMS and MCP — reusable and idempotent (run it again any time,
# e.g. after adding tables in Studio). Docs: docs/brand-bootstrap.md
#
#   scripts/brand-bootstrap.sh <schema> [--label "Acme Outdoor"] [--no-tables] [--no-agency]
#                                       [--bucket images|--no-bucket] [--no-settings]
#
#   <schema>      lower-case a-z, 0-9, _ ; created if missing
#   --label       human name (schema comment, shown in the docs / Studio)
#   --no-tables   do not create the standard tables (products, product_images, faq); use this for a
#                 schema whose tables you create yourself — rights, audit and exposure still apply
#   --no-agency   no agency_<schema> role
#   --bucket      image bucket for the image column and the agency's read folder <schema>/ (default images)
#   --no-settings no settings table (the brand's "Settings" page: name, website, default currency, SEO, logo)
#
# Steps: SQL (scripts/sql/brand-bootstrap.sql) → schema into PGRST_DB_SCHEMAS (.env) and recreate
# rest + studio if it was missing → check that PostgREST serves it and the admin role sees it.
source "$(dirname "$0")/lib.sh"
need_env

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }

SCHEMA="" LABEL="" TABLES=template AGENCY=yes BUCKET=images SETTINGS=yes
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --no-tables) TABLES=none; shift ;;
    --no-agency) AGENCY=no; shift ;;
    --bucket) BUCKET="${2:?--bucket needs a value}"; shift 2 ;;
    --no-bucket) BUCKET=""; shift ;;
    --no-settings) SETTINGS=no; shift ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option $1" >&2; usage ;;
    *) [ -z "$SCHEMA" ] || usage; SCHEMA="$1"; shift ;;
  esac
done
[ -n "$SCHEMA" ] || usage
[[ "$SCHEMA" =~ ^[a-z_][a-z0-9_]{0,55}$ ]] || die "schema must be lower-case a-z, 0-9, _ (max 56 chars)"

step "SQL: schema, tables, rights, agency role, audit ($SCHEMA)"
psql_admin -v schema="$SCHEMA" -v label="$LABEL" -v tables="$TABLES" -v agency="$AGENCY" -v bucket="$BUCKET" -v settings="$SETTINGS" \
  -At < "$ROOT/scripts/sql/brand-bootstrap.sql" | grep -v '^$' | grep -v '|' | sed 's/^/   /'

step "expose the schema in PostgREST (PGRST_DB_SCHEMAS)"
current=$(envval PGRST_DB_SCHEMAS)
if [[ ",$current," == *",$SCHEMA,"* ]]; then
  echo "   already exposed"
else
  cp "$ENV_FILE" "$ENV_FILE.bak.brand-$(date +%Y%m%d%H%M%S)"
  sed -i '' -e "s|^PGRST_DB_SCHEMAS=.*$|PGRST_DB_SCHEMAS=$current,$SCHEMA|" "$ENV_FILE"
  echo "   added (backup of .env next to it); recreating rest + studio"
  compose up -d --no-deps --wait rest studio 2>&1 | grep -E 'Recreated|Started|Healthy|Error' | sed 's/^/   /' || true
fi

step "check"
GW=$(gw_url); KEY=$(envval SERVICE_ROLE_KEY)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$GW/rest/v1/" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Accept-Profile: $SCHEMA")
  [ "$code" = 200 ] && break; sleep 1
done
echo "   PostgREST serves schema $SCHEMA → HTTP $code"
[ "$code" = 200 ] || die "PostgREST does not serve $SCHEMA yet (check PGRST_DB_SCHEMAS and the rest container)"
psql_admin -At <<SQL | sed 's/^/   /'
select format('admin role %s sees %s table(s) in %s', r,
              (select coalesce(sum(jsonb_array_length(sc -> 'tables')), 0)
                 from jsonb_array_elements(cms.describe_role(r::name) -> 'schemas') sc
                where sc ->> 'name' = '$SCHEMA'), '$SCHEMA')
  from unnest((select admin_roles from cms.settings)) r;
SQL

cat <<EOF

Done. Next:
  - CMS: reload http://localhost:$(envval CMS_MCP_PORT)/cms/ (sign in again so the menu is rebuilt)
  - Agency access: Admin → People → role agency_$SCHEMA$([ "$AGENCY" = yes ] || echo " (not created: --no-agency)")
  - Images: upload into bucket ${BUCKET:-<none>} under the folder $SCHEMA/
  - Own tables later? Create them in Studio, then run this script again.
EOF
