#!/usr/bin/env bash
# An agency that works for several brands — reusable and idempotent. Docs: docs/brand-bootstrap.md
#
#   scripts/agency.sh <name> [--label "Northstar Agency"] [--brand nordwind] [--brand suedwind] [--remove-brand suedwind]
#
#   <name>          lower-case a-z, 0-9, _ ; the role is agency_<name> (not the name of a brand)
#   --label         human name (role comment, shown in Admin → People)
#   --brand         add a brand (repeat it; the brand needs its agency role from scripts/brand-bootstrap.sh)
#   --remove-brand  take a brand away (repeat it)
#
# The role is a member of agency_<brand> of every brand, so it can do there what that brand's agency can.
# Assign it in Admin → People; it takes effect with the person's next token.
source "$(dirname "$0")/lib.sh"
need_env

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }

NAME="" LABEL="" ADD="" DEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --brand) ADD="${ADD:+$ADD,}${2:?--brand needs a value}"; shift 2 ;;
    --remove-brand) DEL="${DEL:+$DEL,}${2:?--remove-brand needs a value}"; shift 2 ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option $1" >&2; usage ;;
    *) [ -z "$NAME" ] || usage; NAME="$1"; shift ;;
  esac
done
[ -n "$NAME" ] || usage
[[ "$NAME" =~ ^[a-z_][a-z0-9_]{0,55}$ ]] || die "name must be lower-case a-z, 0-9, _ (max 56 chars)"

step "SQL: role agency_$NAME and its brands"
psql_admin -v name="$NAME" -v label="$LABEL" -v brands="$ADD" -v remove="$DEL" -At \
  < "$ROOT/scripts/sql/agency.sql" | grep -v '^$' | grep -v '|' | sed 's/^/   /'

cat <<EOT

Done. Next:
  - Admin → People → role agency_$NAME (takes effect with the person's next sign-in / token)
  - More brands later: run this script again with --brand <schema>
EOT
