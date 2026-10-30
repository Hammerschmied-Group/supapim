#!/usr/bin/env bash
# Assemble the two release archives from this checkout. Version = root package.json. Nothing is uploaded.
#
#   scripts/build-package.sh [--with-image] [--out dir]
#
#   dist/supapim-selfhosted-<version>.tar.gz   unpack in the Supabase docker directory → ./cms/
#                                                   (compose files for Envoy and Kong, gateway wrappers, install.sh, SQL, docs)
#   dist/supapim-cloud-<version>.tar.gz        unpack anywhere → ./supapim-cloud/
#                                                   (compose file for the external container, SQL, docs)
#   dist/SHA256SUMS
#
#   --with-image   also put the multi-arch OCI archive (scripts/build-image.sh --oci) into both archives, so a customer
#                  can `docker load` the image without any registry. Without it the archives are small and the image
#                  comes from the registry named in CMS_IMAGE.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
die() { echo "error: $*" >&2; exit 1; }
VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json" | head -1)
[ -n "$VERSION" ] || die "no version in package.json"
OUT=$ROOT/dist WITH_IMAGE=0
while [ $# -gt 0 ]; do case "$1" in --with-image) WITH_IMAGE=1; shift ;; --out) OUT=${2:?}; shift 2 ;; *) die "unknown option $1" ;; esac; done
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

OCI=""
if [ "$WITH_IMAGE" = 1 ]; then
  OCI=$OUT/supapim-$VERSION.oci.tar
  "$ROOT/scripts/build-image.sh" --oci "$OCI" >"$WORK/image-build.log" 2>&1 || { tail -30 "$WORK/image-build.log" >&2; die "image build failed"; }
fi

common_docs() {  # common_docs <dest> <doc…>
  local dest=$1; shift; mkdir -p "$dest"
  for d in "$@"; do [ -f "$ROOT/docs/$d" ] && cp "$ROOT/docs/$d" "$dest/" || echo "note: docs/$d missing, skipped" >&2; done
}
put_image() { [ -z "$OCI" ] || { mkdir -p "$1/image"; cp "$OCI" "$1/image/"; }; }

# ── self-hosted ──────────────────────────────────────────────────────────────────────────────
P=$WORK/cms; mkdir -p "$P/sql"
cp -R "$ROOT/deploy/selfhosted/." "$P/"
rm -f "$P/README.md.in"
sed -i.bak "s/@VERSION@/$VERSION/g" "$P/env.example" && rm -f "$P/env.example.bak"
cp "$ROOT/packages/sql/install.sql" "$ROOT/packages/sql/uninstall.sql" "$ROOT/scripts/sql/brand-bootstrap.sql" "$ROOT/scripts/sql/agency.sql" "$P/sql/"
common_docs "$P/docs" install-selfhosted.md upgrade.md compatibility.md brand-bootstrap.md storage-s3.md
echo "$VERSION" > "$P/VERSION"
put_image "$P"
tar -C "$WORK" -czf "$OUT/supapim-selfhosted-$VERSION.tar.gz" cms
rm -rf "$P"

# ── cloud ────────────────────────────────────────────────────────────────────────────────────
C=$WORK/supapim-cloud; mkdir -p "$C/sql"
cp -R "$ROOT/deploy/cloud/." "$C/"
sed -i.bak "s/@VERSION@/$VERSION/g" "$C/env.example" && rm -f "$C/env.example.bak"
cp "$ROOT/packages/sql/install.sql" "$ROOT/packages/sql/uninstall.sql" "$ROOT/scripts/sql/brand-bootstrap.sql" "$ROOT/scripts/sql/agency.sql" "$C/sql/"
common_docs "$C/docs" install-cloud.md upgrade.md compatibility.md brand-bootstrap.md
echo "$VERSION" > "$C/VERSION"
put_image "$C"
tar -C "$WORK" -czf "$OUT/supapim-cloud-$VERSION.tar.gz" supapim-cloud

( cd "$OUT" && shasum -a 256 supapim-selfhosted-$VERSION.tar.gz supapim-cloud-$VERSION.tar.gz > SHA256SUMS )
ls -lh "$OUT"/*.tar.gz | awk '{print "   " $5 "  " $NF}'
