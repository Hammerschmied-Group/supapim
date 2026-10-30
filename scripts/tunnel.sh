#!/usr/bin/env bash
# Point the local stack at a public HTTPS tunnel so claude.ai / Claude Desktop / ChatGPT can reach it,
# and point it back. This script only edits .env (with a backup). It starts no tunnel and no containers,
# and it never makes anything public by itself: you start the tunnel, then apply the change.
#
#   scripts/tunnel.sh on https://<name>.trycloudflare.com   set SUPABASE_PUBLIC_URL, API_EXTERNAL_URL, SITE_URL
#   scripts/tunnel.sh off                                   restore the values from before
#   scripts/tunnel.sh status                                show what .env points at now (URLs only)
#
# The tunnel target is the gateway:  cloudflared tunnel --url http://localhost:$(API_GW_HTTP_PORT)
# One public host carries issuer (/auth/v1), MCP (/cms/mcp), the consent page (/oauth/consent) and storage.
# While it is on, the stack is reachable from the internet: test users, test data only. Turn it off afterwards.
# .env is shared by every session that uses the stack; ask before switching it while others are testing.
source "$(dirname "$0")/lib.sh"
need_env

REAL=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$ENV_FILE")   # .env may be a symlink
BACKUP="$REAL.tunnel-backup"
KEYS="SUPABASE_PUBLIC_URL API_EXTERNAL_URL SITE_URL"

setval() {  # setval KEY VALUE — rewrite one KEY=… line in place (through the symlink, keeping mode)
  KEY=$1 VAL=$2 python3 - "$REAL" <<'PY'
import os, re, sys
p, k, v = sys.argv[1], os.environ['KEY'], os.environ['VAL']
lines = open(p).read().split('\n')
out, hit = [], False
for l in lines:
    if re.match(rf'^{k}=', l): out.append(f'{k}={v}'); hit = True
    else: out.append(l)
if not hit: sys.exit(f'{k} not found in .env')
open(p, 'w').write('\n'.join(out))
PY
}

status() {
  for k in $KEYS; do echo "   $k=$(envval "$k")"; done
  [ -f "$BACKUP" ] && echo "   (tunnel mode on; backup: $(basename "$BACKUP"))" || echo "   (local mode)"
}

case "${1:-}" in
  on)
    url=${2:-}
    [[ "$url" =~ ^https://[A-Za-z0-9.-]+$ ]] || die "usage: scripts/tunnel.sh on https://<host>   (https, no path, no trailing slash)"
    [[ "$url" =~ (localhost|127\.0\.0\.1) ]] && die "that is a local address, not a tunnel"
    [ -f "$BACKUP" ] && die "tunnel mode is already on (run 'scripts/tunnel.sh off' first)"
    cp -p "$REAL" "$BACKUP"
    setval SUPABASE_PUBLIC_URL "$url"
    setval API_EXTERNAL_URL "$url/auth/v1"
    setval SITE_URL "$url"
    step ".env now points at $url"; status
    cat <<MSG

Next (nothing is applied yet):
  1. the tunnel must already run:  cloudflared tunnel --url $(gw_url)
  2. scripts/start.sh              recreates the containers whose environment changed (auth, gateway, cms, …)
  3. claude.ai → Settings → Connectors → add custom connector:  $url/cms/mcp
  4. when done:  scripts/tunnel.sh off  and  scripts/start.sh,  then stop the tunnel
MSG
    ;;
  off)
    [ -f "$BACKUP" ] || die "tunnel mode is not on (no backup found)"
    cp -p "$BACKUP" "$REAL" && rm "$BACKUP"
    step ".env restored"; status
    echo; echo "Next: scripts/start.sh (recreates the containers), then stop the tunnel."
    ;;
  status) status ;;
  *) die "usage: scripts/tunnel.sh on <https-url> | off | status" ;;
esac
