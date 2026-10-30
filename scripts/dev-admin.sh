#!/usr/bin/env bash
# Run apps/server with Node on the host, WITH the admin API (the service key comes from .env into this
# process's environment only; nothing is printed). Default port 55381 like dev-mcp.sh; PORT=… to change.
# Invites return the one-time link instead of sending mail (the local stack has no SMTP).
source "$(dirname "$0")/lib.sh"
need_env
PORT=${PORT:-55381}
export PORT
export SUPABASE_PUBLIC_URL=$(envval SUPABASE_PUBLIC_URL)
export SUPABASE_ANON_KEY=$(envval ANON_KEY)
export PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:$PORT}
export AUTH_ISSUER=$(envval API_EXTERNAL_URL)
export SUPABASE_SECRET_KEY=$(envval SUPABASE_SECRET_KEY)
export CMS_ADMIN_INVITE_DELIVERY=${CMS_ADMIN_INVITE_DELIVERY:-link}
cd "$ROOT/apps/server" && exec node server.mjs
