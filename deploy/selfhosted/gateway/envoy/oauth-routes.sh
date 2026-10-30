#!/bin/sh
# Part of the api-gw entrypoint wrapper (entrypoint.sh, wired in docker-compose.envoy.yml; upstream files stay untouched).
#
# Why: upstream 0.8.3 only opens the OAuth *discovery* routes. Everything else under /auth/v1/
# needs an apikey header, but OAuth 2.1 / MCP clients (Claude, Cursor, …) call the token,
# registration and authorize endpoints without one. This inserts one open route for
# /auth/v1/oauth/ (same shape as the upstream open /auth/v1/verify route) in front of the
# apikey-protected /auth/v1/ catch-all, (entrypoint.sh then runs the upstream entrypoint unchanged).
# The GoTrue endpoints behind it do their own auth: client auth/PKCE for /token, rate limit for
# /clients/register, a user JWT for /authorizations/*.
set -e

awk -v q="'" '
  /^                      - name: auth-v1-protected$/ && !done {
    print "                      - name: auth-v1-oauth-server"
    print "                        match:"
    print "                          prefix: /auth/v1/oauth/"
    print "                        route:"
    print "                          cluster: auth"
    print "                          prefix_rewrite: /oauth/"
    print "                          timeout: 30s"
    print "                        request_headers_to_add:"
    print "                          - header:"
    print "                              key: X-Forwarded-Prefix"
    print "                              value: /auth/v1/oauth/"
    print "                            append_action: ADD_IF_ABSENT"
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
    done = 1
  }
  { print }
  END { if (!done) { print "envoy-oauth-routes: anchor auth-v1-protected not found" > "/dev/stderr"; exit 1 } }
' /etc/envoy/lds.upstream.yaml > /etc/envoy/lds.template.yaml

echo "envoy-oauth-routes: open route /auth/v1/oauth/ inserted"
