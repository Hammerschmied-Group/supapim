#!/bin/sh
# Gateway routes of the plugin container, run by entrypoint.sh after oauth-routes.sh; upstream files stay
# untouched. Adds, in front of the apikey-protected catch-alls:
#
#   cluster `cms`  → the plugin container (default cms:8080; CMS_UPSTREAM_HOST / CMS_UPSTREAM_PORT override)
#   /cms/mcp       → remote MCP server (Streamable HTTP, 120 s), open at the gateway: OAuth 2.1 bearer tokens are
#                    checked by the MCP server itself (MCP clients send no apikey)
#   /.well-known/oauth-protected-resource[/cms/mcp] → RFC 9728 metadata that points clients to Supabase Auth
#   /oauth/consent → the OAuth consent page (GoTrue redirects to SITE_URL + /oauth/consent; the container forwards to /cms/#/consent)
#   /cms           → everything else of the plugin: the CMS UI (/cms/, /cms/config.json) and the admin API
#                    (/cms/api/admin/*). Open at the gateway as well; the admin API checks the person's token
#                    itself and then asks the database whether they are an admin.
#
# The path is not rewritten: the container serves all of these itself, so one hostname (domain or tunnel)
# carries issuer, MCP, UI and admin API. Keep new routes after cms-mcp (first match wins) and open only what
# the container secures itself. The Kong counterpart is ../kong/entrypoint.sh.
set -e

DIR=${ENVOY_DIR:-/etc/envoy}

# ── clusters ────────────────────────────────────────────────────────────────────────────────
# cms = UI, MCP, consent; cms-admin = the admin API (the only container with the secret key, same image)
cluster() {  # cluster NAME HOST PORT
  cat <<YAML

  - '@type': type.googleapis.com/envoy.config.cluster.v3.Cluster
    name: $1
    connect_timeout: 5s
    type: STRICT_DNS
    dns_refresh_rate: 5s
    dns_failure_refresh_rate:
      base_interval: 1s
      max_interval: 1s
    lb_policy: ROUND_ROBIN
    load_assignment:
      cluster_name: $1
      endpoints:
        - lb_endpoints:
            - endpoint:
                address:
                  socket_address:
                    address: $2
                    port_value: $3
    circuit_breakers:
      thresholds:
        - priority: DEFAULT
          max_connections: 10000
          max_pending_requests: 10000
          max_requests: 10000
YAML
}
{
  cat "$DIR/cds.upstream.yaml"
  cluster cms "${CMS_UPSTREAM_HOST:-cms}" "${CMS_UPSTREAM_PORT:-8080}"
  cluster cms-admin "${CMS_ADMIN_UPSTREAM_HOST:-cms-admin}" "${CMS_ADMIN_UPSTREAM_PORT:-8081}"
} > "$DIR/cds.yaml"

# ── routes ──────────────────────────────────────────────────────────────────────────────────
awk -v q="'" '
  function route(name, kind, path, timeout, cl, cors) {
    if (cl == "") cl = "cms"
    print "                      - name: " name
    print "                        match:"
    print "                          " kind ": " path
    print "                        route:"
    print "                          cluster: " cl
    print "                          timeout: " timeout
    print "                        typed_per_filter_config:"
    print "                          envoy.filters.http.basic_auth:"
    print "                            " q "@type" q ": type.googleapis.com/envoy.config.route.v3.FilterConfig"
    print "                            disabled: true"
    if (cors == "same-origin") {
      # CORS policy for this route only (like upstream does for /pg/): without it Envoy reflects any Origin.
      # The CMS UI calls the admin API from the same host, so nothing else needs to be allowed.
      print "                          envoy.filters.http.cors:"
      print "                            " q "@type" q ": type.googleapis.com/envoy.extensions.filters.http.cors.v3.CorsPolicy"
      print "                            allow_origin_string_match:"
      print "                              - exact: " q "${SUPABASE_PUBLIC_URL}" q
      print "                            allow_methods: \"POST,OPTIONS\""
      print "                            allow_headers: \"authorization,content-type\""
      print "                            max_age: \"3600\""
    }
    print "                          envoy.filters.http.rbac:"
    print "                            " q "@type" q ": type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBACPerRoute"
    print "                            rbac:"
    print "                              rules:"
    print "                                action: ALLOW"
    print "                                policies:"
    print "                                  allow_all:"
    print "                                    permissions:"
    print "                                      - any: true"
    print "                                    principals:"
    print "                                      - any: true"
    print ""
  }
  function storage_object() {
    # Files from Storage can be active content (an SVG with a script). Behind one host they would run in the origin of the UI
    # and could read the session token, so every object response gets a sandboxing CSP and nosniff. Same route as the upstream
    # /storage/v1/, plus the two response headers; placed before it.
    print "                      - name: cms-storage-object"
    print "                        match:"
    print "                          prefix: /storage/v1/object/"
    print "                        route:"
    print "                          cluster: storage"
    print "                          prefix_rewrite: /object/"
    print "                          timeout: 30s"
    print "                        request_headers_to_add:"
    print "                          - header:"
    print "                              key: X-Forwarded-Prefix"
    print "                              value: /storage/v1"
    print "                            append_action: ADD_IF_ABSENT"
    print "                        response_headers_to_add:"
    print "                          - header:"
    print "                              key: Content-Security-Policy"
    print "                              value: \"default-src " q "none" q "; sandbox\""
    print "                            append_action: OVERWRITE_IF_EXISTS_OR_ADD"
    print "                          - header:"
    print "                              key: X-Content-Type-Options"
    print "                              value: nosniff"
    print "                            append_action: OVERWRITE_IF_EXISTS_OR_ADD"
    print "                        typed_per_filter_config:"
    print "                          envoy.filters.http.basic_auth:"
    print "                            " q "@type" q ": type.googleapis.com/envoy.config.route.v3.FilterConfig"
    print "                            disabled: true"
    print "                          envoy.filters.http.rbac:"
    print "                            " q "@type" q ": type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBACPerRoute"
    print "                            rbac:"
    print "                              rules:"
    print "                                action: ALLOW"
    print "                                policies:"
    print "                                  allow_all:"
    print "                                    permissions:"
    print "                                      - any: true"
    print "                                    principals:"
    print "                                      - any: true"
    print ""
  }
  # The upstream storage route has no name: hold each "- match:" line and put ours in front of the one for /storage/v1/
  /^                      - match:$/ { held = $0; next }
  held != "" {
    if ($0 ~ /^ +prefix: \/storage\/v1\/$/ && !sdone) { storage_object(); sdone = 1 }
    print held; held = ""
  }
  /^                      - name: auth-v1-oauth-server$/ && !done {
    route("cms-mcp", "path_separated_prefix", "/cms/mcp", "120s")
    route("cms-mcp-resource-metadata", "path", "/.well-known/oauth-protected-resource/cms/mcp", "30s")
    route("cms-resource-metadata-root", "path", "/.well-known/oauth-protected-resource", "30s")
    # OAuth consent: GoTrue redirects to SITE_URL + /oauth/consent; the container forwards to the UI page /cms/#/consent.
    route("cms-oauth-consent", "path", "/oauth/consent", "30s")
    # UI + admin API (after /cms/mcp above)
    # admin API → its own container (before the generic /cms route)
    route("cms-admin", "path_separated_prefix", "/cms/api/admin", "30s", "cms-admin", "same-origin")
    route("cms", "path_separated_prefix", "/cms", "30s")

    done = 1
  }
  { print }
  END { if (!sdone) { print "envoy-cms-routes: anchor /storage/v1/ not found" > "/dev/stderr"; exit 1 }
        if (!done) { print "envoy-cms-routes: anchor auth-v1-oauth-server not found" > "/dev/stderr"; exit 1 } }
' "$DIR/lds.template.yaml" > "$DIR/lds.template.cms.yaml"
mv "$DIR/lds.template.cms.yaml" "$DIR/lds.template.yaml"

echo "envoy-cms-routes: clusters cms, cms-admin; cluster cms → ${CMS_UPSTREAM_HOST:-cms}:${CMS_UPSTREAM_PORT:-8080}; open routes /cms, /cms/mcp, /oauth/consent and /.well-known/oauth-protected-resource inserted"
