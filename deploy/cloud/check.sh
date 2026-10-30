#!/usr/bin/env bash
# Read-only checks for a Supabase Cloud project (and, with a second argument, for the plugin container).
# Creates nothing: no account, no OAuth client (the registration call sends an empty body and is refused by Auth).
# Prints no keys. Guide: docs/install-cloud.md
#
#   ./check.sh https://<ref>.supabase.co [https://cms.example.com]
#
# Reads SUPABASE_PUBLISHABLE_KEY from the environment or from ./.env (needed only for the PostgREST check).
set -uo pipefail
P=${1:?usage: check.sh https://<ref>.supabase.co [https://cms.example.com]}; P=${P%/}
C=${2:-}; C=${C%/}
FAILED=0; ok() { printf '   ok   %s\n' "$*"; }; bad() { printf '   FAIL %s\n' "$*"; FAILED=1; }; warn() { printf '   WARN %s\n' "$*"; }
KEY=${SUPABASE_PUBLISHABLE_KEY:-}
[ -n "$KEY" ] || [ ! -f .env ] || KEY=$(grep -E '^SUPABASE_PUBLISHABLE_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"')
F=$(mktemp); H=$(mktemp); trap 'rm -f "$F" "$H"' EXIT
http() { curl -sS -o "$F" -D "$H" -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || echo 000; }

echo "== project $P"
c=$(http "$P/.well-known/oauth-authorization-server/auth/v1")
if [ "$c" = 200 ]; then ok "OAuth server metadata → 200"
  grep -q registration_endpoint "$F" && ok "dynamic client registration is advertised" || bad "no registration_endpoint: enable 'Allow dynamic OAuth apps' (Authentication → OAuth Server)"
  grep -q "\"issuer\" *: *\"$P/auth/v1\"" "$F" && ok "issuer = $P/auth/v1" || warn "issuer differs from $P/auth/v1 (custom domain?): set AUTH_ISSUER of the container to the issuer shown in the metadata"
else bad "OAuth server metadata → $c (OAuth server not enabled?)"; fi
c=$(http "$P/auth/v1/.well-known/jwks.json")
if [ "$c" = 200 ]; then
  algs=$(grep -oE '"alg" *: *"[A-Z0-9]+"' "$F" | grep -oE '[A-Z0-9]+"$' | tr -d '"' | sort -u | tr '\n' ' ')
  case "$algs" in *ES256*|*RS256*) ok "JWKS has asymmetric key(s): $algs" ;; *) bad "JWKS has no asymmetric signing key (found: ${algs:-none}): migrate to JWT signing keys (Authentication → Signing Keys)" ;; esac
else bad "JWKS → $c"; fi

echo "== known gap: are the OAuth endpoints reachable WITHOUT an apikey? (MCP clients send none)"
for spec in "POST /auth/v1/oauth/clients/register" "POST /auth/v1/oauth/token" "GET /auth/v1/oauth/authorize"; do
  m=${spec%% *}; path=${spec#* }
  if [ "$m" = POST ]; then c=$(http -X POST -H 'Content-Type: application/json' -d '{}' "$P$path"); else c=$(http "$P$path"); fi
  case "$c" in
    400|422) ok "$spec without apikey → $c (reached Auth, refused the empty request: open)" ;;
    401|403) bad "$spec without apikey → $c — BLOCKED by the gateway; generic MCP clients cannot sign in against this project: $(head -c 120 "$F")" ;;
    404) bad "$spec → 404 (OAuth server not enabled?)" ;;
    *) warn "$spec → $c (unexpected): $(head -c 120 "$F")" ;;
  esac
done

if [ -n "$KEY" ]; then
  echo "== PostgREST"
  c=$(http -X POST -H "apikey: $KEY" -H 'Content-Profile: cms_api' -H 'Content-Type: application/json' -d '{}' "$P/rest/v1/rpc/describe")
  case "$c" in
    401|403) ok "cms_api.describe is served (refused for anon, as designed) → $c" ;;
    404|406) bad "cms_api not served ($c): add cms_api to Settings → API → Exposed schemas, and run sql/install.sql" ;;
    *) warn "rpc/describe → $c: $(head -c 120 "$F")" ;;
  esac
else warn "SUPABASE_PUBLISHABLE_KEY not set: skipping the PostgREST check"; fi

if [ -n "$C" ]; then
  echo "== plugin container $C"
  [ "$(http "$C/health")" = 200 ] && ok "health → $(head -c 80 "$F")" || bad "container not reachable at $C/health"
  [ "$(http "$C/cms/")" = 200 ] && ok "CMS UI → 200" || bad "GET /cms/ failed"
  c=$(http -X POST -H 'Content-Type: application/json' -d '{}' "$C/cms/mcp"); [ "$c" = 401 ] && ok "MCP answers 401 without a token" || bad "POST /cms/mcp → $c (expected 401)"
  grep -qi '^www-authenticate:.*resource_metadata' "$H" && ok "…with the resource_metadata hint" || bad "no WWW-Authenticate resource_metadata"
  c=$(http "$C/.well-known/oauth-protected-resource/cms/mcp")
  if [ "$c" = 200 ]; then grep -q "$P/auth/v1" "$F" && ok "metadata names $P/auth/v1 as authorization server" || bad "metadata does not name $P/auth/v1 (SUPABASE_URL of the container?)"; else bad "protected-resource metadata → $c"; fi
  c=$(http "$C/oauth/consent"); [[ "$c" =~ ^(200|302)$ ]] && ok "consent page → $c" || bad "/oauth/consent → $c"
  case "$C" in https://*) ok "https" ;; *) warn "not https: Claude and ChatGPT only connect to https addresses" ;; esac
fi
[ $FAILED = 0 ] && echo && echo "All checks passed." || { echo && echo "Some checks failed."; exit 1; }
