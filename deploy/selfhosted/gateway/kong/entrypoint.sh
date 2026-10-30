#!/bin/sh
# api-gw entrypoint wrapper for Kong (wired in docker-compose.kong.yml; upstream files stay untouched).
# Counterpart of ../envoy/*: same routes, same reasons.
#
# Upstream's Kong entrypoint reads its declarative config from /home/kong/temp.yml, a directory that is root-owned
# and read-only for the kong user. The compose override therefore mounts upstream's kong.yml and entrypoint under
# /cms-upstream/; this script writes the merged config (upstream's file + the services below, inserted right
# after `services:`) to /tmp/temp.yml, points a copy of upstream's entrypoint at that path (one sed, checked) and runs
# it. Upstream's files themselves are not edited.
#
# Routes added (all open at the gateway; the services behind them do their own authentication):
#   /auth/v1/oauth/        → Auth /oauth/ : OAuth 2.1 server (client registration, token, authorize). Upstream only opens
#                            the discovery routes, everything else under /auth/v1/ needs an apikey, which MCP clients
#                            do not send. GoTrue protects these endpoints itself (client auth + PKCE, rate limit, user JWT).
#   /cms/api/admin         → cms-admin container (admin API, the only one with the secret key; same image)
#   /storage/v1/object/    → Storage with CSP + nosniff on every response (active content from uploads)
#   /cms                   → plugin container: UI (/cms/, /cms/config.json), MCP (/cms/mcp), admin API (/cms/api/admin/*)
#   /oauth/consent         → plugin container: consent page (GoTrue redirects to SITE_URL + /oauth/consent)
#   /.well-known/oauth-protected-resource[/cms/mcp] → plugin container: RFC 9728 metadata
# Kong picks the most specific path, so these beat upstream's /auth/v1/ and the Studio catch-all /.
# CMS_UPSTREAM_HOST / CMS_UPSTREAM_PORT (default cms:8080) point the routes at another container.
set -e

UP=/cms-upstream/kong.yml
UPSTREAM_ENTRYPOINT=/cms-upstream/kong-entrypoint.sh
OUT=/tmp/temp.yml
HOST=${CMS_UPSTREAM_HOST:-cms}
PORT=${CMS_UPSTREAM_PORT:-8080}
AHOST=${CMS_ADMIN_UPSTREAM_HOST:-cms-admin}
APORT=${CMS_ADMIN_UPSTREAM_PORT:-8081}

[ "$(grep -c '^services:' "$UP")" = 1 ] || { echo "kong-cms-routes: expected exactly one 'services:' in $UP" >&2; exit 1; }

# The only $ in the block is \$LUA_AUTH_EXPR (written \$ in the heredoc): upstream's entrypoint substitutes it in this file.
cat > /tmp/cms-services.yml <<YAML
  ## SupaPIM: OAuth 2.1 server endpoints, open (see the header of this script)
  - name: cms-auth-v1-oauth
    _comment: 'Auth: /auth/v1/oauth/* -> http://auth:9999/oauth/*'
    url: http://auth:9999/oauth/
    routes:
      - name: cms-auth-v1-oauth
        strip_path: true
        paths:
          - /auth/v1/oauth/
    plugins:
      - name: cors
  ## SupaPIM: plugin container (UI, MCP, admin API, consent page, resource metadata)
  - name: cms
    _comment: 'SupaPIM: /cms, /oauth/consent, /.well-known/oauth-protected-resource -> http://${HOST}:${PORT}'
    url: http://${HOST}:${PORT}/
    connect_timeout: 5000
    read_timeout: 120000
    write_timeout: 120000
    routes:
      - name: cms-all
        strip_path: false
        paths:
          - /cms
          - /oauth/consent
          - /.well-known/oauth-protected-resource
  ## SupaPIM: admin API in its own container (same image, the only one with the secret key); more specific than /cms
  - name: cms-admin
    _comment: 'SupaPIM: /cms/api/admin -> http://${AHOST}:${APORT}'
    url: http://${AHOST}:${APORT}/
    connect_timeout: 5000
    read_timeout: 30000
    write_timeout: 30000
    routes:
      - name: cms-admin-all
        strip_path: false
        paths:
          - /cms/api/admin
  ## SupaPIM: files from Storage can be active content (an SVG with a script). Behind one host they would run in the
  ## origin of the UI and could read the session token, so every object response gets a sandboxing CSP and nosniff.
  ## Same service as upstream storage-v1 (its request-transformer and post-function), plus the response headers.
  - name: cms-storage-object
    _comment: 'Storage: /storage/v1/object/* -> http://storage:5000/object/* with CSP + nosniff'
    url: http://storage:5000/object/
    routes:
      - name: cms-storage-object
        strip_path: true
        paths:
          - /storage/v1/object/
    plugins:
      - name: cors
      - name: request-transformer
        config:
          add:
            headers:
              - "Authorization: \$LUA_AUTH_EXPR"
          replace:
            headers:
              - "Authorization: \$LUA_AUTH_EXPR"
      - name: post-function
        config:
          access:
            - |
              local auth = kong.request.get_header("authorization")
              if auth == nil or auth == "" or auth:find("^%s*$") then
                kong.service.request.clear_header("authorization")
              end
          header_filter:
            - |
              kong.response.set_header("Content-Security-Policy", "default-src 'none'; sandbox")
              kong.response.set_header("X-Content-Type-Options", "nosniff")
YAML

awk '{ print } /^services:/ { while ((getline line < "/tmp/cms-services.yml") > 0) print line }' "$UP" > "$OUT"
echo "kong-cms-routes: open routes /auth/v1/oauth/, /cms, /oauth/consent, /.well-known/oauth-protected-resource inserted (cms → ${HOST}:${PORT})"
grep -q '/home/kong/temp.yml' "$UPSTREAM_ENTRYPOINT" || { echo "kong-cms-routes: upstream entrypoint no longer reads /home/kong/temp.yml (new Supabase version?) — see docs/compatibility.md" >&2; exit 1; }
sed 's|/home/kong/temp.yml|'"$OUT"'|g' "$UPSTREAM_ENTRYPOINT" > /tmp/kong-entrypoint.sh
exec /bin/sh /tmp/kong-entrypoint.sh "$@"
