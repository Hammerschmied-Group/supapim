#!/usr/bin/env bash
# Run all checks against the running stack: SQL permission tests, MCP unit tests, no-service-key check,
# end-to-end chain (OAuth → token hook → MCP tools → PostgREST/Storage → audit), security suite (role × action
# over UI and MCP, tokens, MFA, service key, web headers; docs/security/), CMS UI (unit tests + Playwright E2E per role).
# The chain talks to the MCP server through the gateway route <SUPABASE_PUBLIC_URL>/cms/mcp by default.
# Against a dev server: scripts/test.sh --mcp-url http://localhost:55381/cms/mcp  (scripts/dev-mcp.sh)
source "$(dirname "$0")/lib.sh"
need_env

step "SQL permission tests (rolled back, data unchanged)"
psql_admin -P pager=off < "$ROOT/packages/sql/test/tests.sql"

step "MCP module unit tests (filters, rate limit, access log, error explanations)"
node --test "$ROOT/apps/server/test/"

step "no service key in the MCP path"
"$ROOT/scripts/check-no-service-key.sh"

step "end-to-end: OAuth 2.1 → token hook → MCP → PostgREST / Storage → audit"
node "$ROOT/scripts/test-chain.mjs" "$@"

step "storage backend (upload, download, render, signed URL, multipart, resumable, policies)"
node "$ROOT/scripts/test-storage.mjs"

step "security: role × action over UI and MCP, tokens, MFA, service key, web headers (docs/security/)"
node "$ROOT/scripts/test-security.mjs"

step "CMS UI: model unit tests + Playwright E2E per role (apps/ui, build served by apps/server/src/ui)"
(
  cd "$ROOT/apps/ui"
  [ -d node_modules ] || npm ci --no-audit --no-fund
  [ -d ../server/node_modules ] || (cd ../server && npm ci --no-audit --no-fund)
  npx playwright install chromium >/dev/null
  npm test --silent
  npm run e2e --silent
)
