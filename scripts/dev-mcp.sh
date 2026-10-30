#!/usr/bin/env bash
# Run apps/server with Node on the host (default port 55381) against the running stack's gateway.
# Gets only what the container would get: the gateway URLs and the PUBLIC anon key — no service key.
# Logs (JSON lines) go to stdout; redirect them to a file to inspect them.
source "$(dirname "$0")/lib.sh"
need_env
PORT=${PORT:-55381}
export PORT
export SUPABASE_PUBLIC_URL=$(envval SUPABASE_PUBLIC_URL)
export SUPABASE_ANON_KEY=$(envval ANON_KEY)
# Public base = where clients reach /cms/mcp (default: this process; behind a gateway: PUBLIC_BASE_URL=http://localhost:55321)
export PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:$PORT}
export AUTH_ISSUER=$(envval API_EXTERNAL_URL)
cd "$ROOT/apps/server" && exec node server.mjs
