#!/usr/bin/env bash
# Release step (Task 7): dependency scan + SBOMs. Run before tagging a release; attach the output directory to it.
#   1. npm audit for apps/server (production dependencies = what runs in the container) and apps/ui (production
#      dependencies = what ends up in the browser bundle). Fails at --level or worse (default: high).
#   2. osv-scanner on both lockfiles, when it is installed (second opinion, OSV database).
#   3. SBOMs, CycloneDX JSON: one per package (npm sbom) and one for the image (docker scout sbom, when available).
#   4. Image CVEs (docker scout cves): only when docker scout is logged in; otherwise a NOTE.
# No .env needed, prints no secrets. Output: release/<git sha>/ (git-ignored).
# Usage: scripts/release-audit.sh [--level low|moderate|high|critical] [--image supapim:local] [--out DIR]
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LEVEL=high IMAGE="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --level) LEVEL=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) echo "usage: $0 [--level low|moderate|high|critical] [--image TAG] [--out DIR]" >&2; exit 2 ;;
  esac
done
OUT=${OUT:-$ROOT/release/$(git -C "$ROOT" rev-parse --short HEAD)}
mkdir -p "$OUT"
step() { printf '\n== %s\n' "$*"; }
rc=0

step "1. npm audit (production dependencies, fail at $LEVEL or worse)"
for app in server ui; do
  dir="$ROOT/apps/$app"
  [ -d "$dir/node_modules" ] || (cd "$dir" && npm ci --no-audit --no-fund >/dev/null)
  (cd "$dir" && npm audit --omit=dev --json > "$OUT/npm-audit-$app.json" 2>/dev/null) || true
  summary=$(node -e 'const d=require(process.argv[1]).metadata?.vulnerabilities??{};console.log(["critical","high","moderate","low"].map(k=>`${k} ${d[k]??0}`).join(", "))' "$OUT/npm-audit-$app.json")
  if (cd "$dir" && npm audit --omit=dev --audit-level="$LEVEL" >/dev/null 2>&1); then
    echo "   PASS  apps/$app: $summary"
  else
    echo "   ** FAIL **  apps/$app: $summary (details: npm audit --omit=dev in apps/$app)"; rc=1
  fi
done

step "2. osv-scanner (optional)"
if command -v osv-scanner >/dev/null; then
  if osv-scanner --format json --output "$OUT/osv.json" -L "$ROOT/apps/server/package-lock.json" -L "$ROOT/apps/ui/package-lock.json" >/dev/null 2>&1; then
    echo "   PASS  no known vulnerabilities (OSV)"
  else
    echo "   NOTE  findings in $OUT/osv.json (OSV includes dev dependencies; compare with step 1)"
  fi
else
  echo "   NOTE  osv-scanner not installed, skipped (brew install osv-scanner)"
fi

step "3. SBOMs (CycloneDX)"
for app in server ui; do
  (cd "$ROOT/apps/$app" && npm sbom --sbom-format cyclonedx --omit dev > "$OUT/sbom-$app.cdx.json")
  echo "   apps/$app: $(node -e 'console.log(require(process.argv[1]).components.length)' "$OUT/sbom-$app.cdx.json") components → $(basename "$OUT")/sbom-$app.cdx.json"
done
if [ -n "$IMAGE" ]; then
  if docker scout version >/dev/null 2>&1; then
    if docker scout sbom --format cyclonedx --output "$OUT/sbom-image.cdx.json" "local://$IMAGE" >/dev/null 2>&1; then
      echo "   image $IMAGE → $(basename "$OUT")/sbom-image.cdx.json"
    else echo "   ** FAIL **  docker scout sbom $IMAGE"; rc=1; fi
  else
    echo "   NOTE  docker scout not available: no image SBOM (alternative: syft $IMAGE -o cyclonedx-json)"
  fi
fi

step "4. image CVEs (optional)"
if [ -n "$IMAGE" ] && docker scout version >/dev/null 2>&1; then
  if docker scout cves --format sarif --output "$OUT/image-cves.sarif.json" --only-severity critical,high "local://$IMAGE" >/dev/null 2>&1; then
    echo "   scanned → $(basename "$OUT")/image-cves.sarif.json (critical/high only)"
  else
    echo "   NOTE  docker scout cves needs a Docker login; skipped"
  fi
else
  echo "   NOTE  no --image given or docker scout missing; skipped"
fi

echo
[ $rc = 0 ] && echo "RELEASE AUDIT PASSED → $OUT" || echo "RELEASE AUDIT FAILED → $OUT"
exit $rc
