#!/bin/sh
# api-gw entrypoint wrapper for Envoy (wired in docker-compose.envoy.yml; upstream files stay untouched).
# Builds the plugin's routes into the config the upstream entrypoint reads, then runs that entrypoint unchanged:
#   oauth-routes.sh  open route /auth/v1/oauth/ (upstream only opens the OAuth discovery routes)
#   cms-routes.sh    cluster `cms` + routes /cms, /cms/mcp, /cms/api/admin/*, /oauth/consent, resource metadata
set -e
DIR=$(dirname "$0")
/bin/sh "$DIR/oauth-routes.sh"
/bin/sh "$DIR/cms-routes.sh"
exec /bin/sh /docker-entrypoint.sh "$@"
