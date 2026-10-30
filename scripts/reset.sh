#!/usr/bin/env bash
# Reset the demo.
#   scripts/reset.sh          re-seed: demo schemas, roles, users, audit log and files back to the seed state (~10 s)
#   scripts/reset.sh --wipe   destroy the whole stack incl. database + storage volumes, then start fresh (~45 s with images cached)
source "$(dirname "$0")/lib.sh"
need_env

if [ "${1:-}" = "--wipe" ]; then
  step "wipe stack (containers, volumes, db data, storage files)"
  compose down -v --remove-orphans
  # The db data dir is a bind mount owned by the container user; remove it from inside a container.
  # Storage files live in the named volume storage-data, which down -v already removed.
  docker run --rm -v "$UPSTREAM/volumes:/v" alpine:3.22 sh -c 'rm -rf /v/db/data'
  exec "$ROOT/scripts/start.sh"
fi

"$ROOT/scripts/seed.sh"
