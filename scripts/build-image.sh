#!/usr/bin/env bash
# Build the plugin image (Dockerfile at the repo root: UI + MCP server + admin API in one image).
# The version is the one in the root package.json; the git revision goes into the image label.
# This script never pushes anything; the registry is a decision for the owner (docs/release.md).
#
#   scripts/build-image.sh                 check build for linux/amd64 + linux/arm64 (cache only, nothing is kept)
#   scripts/build-image.sh --load          build for this machine's architecture, load it as ghcr.io/hammerschmied-group/supapim:<version> (+ :local)
#   scripts/build-image.sh --oci [file]    multi-arch OCI archive, default dist/supapim-<version>.oci.tar
#                                          (docker load -i file / ctr / skopeo; ships without any registry)
#   scripts/build-image.sh --push <repo>   multi-arch build and push <repo>:<version>  — the only form that publishes,
#                                          and it needs the repository named explicitly
#
# Options: --platforms linux/amd64,linux/arm64 (default), --image <name> (default ghcr.io/hammerschmied-group/supapim)
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
die() { echo "error: $*" >&2; exit 1; }

VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json" | head -1)
[ -n "$VERSION" ] || die "no version in $ROOT/package.json"
REVISION=$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null || REVISION="$REVISION-dirty"

MODE=check PLATFORMS=linux/amd64,linux/arm64 IMAGE=ghcr.io/hammerschmied-group/supapim OUT="" REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --load) MODE=load; shift ;;
    --oci) MODE=oci; shift; if [ $# -gt 0 ] && [[ "$1" != --* ]]; then OUT=$1; shift; fi ;;
    --push) MODE=push; REPO=${2:?--push needs the repository, e.g. ghcr.io/hammerschmied-group/supapim}; shift 2 ;;
    --platforms) PLATFORMS=${2:?}; shift 2 ;;
    --image) IMAGE=${2:?}; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

docker buildx version >/dev/null 2>&1 || die "docker buildx is required"
args=(--file "$ROOT/Dockerfile" --build-arg "VERSION=$VERSION" --build-arg "REVISION=$REVISION")

echo "SupaPIM $VERSION ($REVISION) — mode: $MODE"
START=$(date +%s)

# Multi-platform builds need the containerd image store (Docker Desktop: Settings → General) or a
# docker-container builder. Detect the first and fall back to a throwaway builder otherwise.
BUILDER_ARGS=()
if [ "$MODE" != load ] && [ "$(docker info -f '{{.DriverStatus}}' 2>/dev/null | grep -c containerd)" = 0 ]; then
  BUILDER=supapim-multiarch
  docker buildx inspect "$BUILDER" >/dev/null 2>&1 || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
  BUILDER_ARGS=(--builder "$BUILDER")
  echo "note: using the buildx builder '$BUILDER' (remove with: docker buildx rm $BUILDER)"
fi

case "$MODE" in
  check)
    docker buildx build "${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"}" "${args[@]}" --platform "$PLATFORMS" "$ROOT"
    ;;
  load)
    docker buildx build "${args[@]}" --load -t "$IMAGE:$VERSION" -t "$IMAGE:local" "$ROOT"
    echo "loaded $IMAGE:$VERSION and $IMAGE:local ($(docker image inspect "$IMAGE:$VERSION" -f '{{.Architecture}}'))"
    ;;
  oci)
    OUT=${OUT:-$ROOT/dist/$IMAGE-$VERSION.oci.tar}
    mkdir -p "$(dirname "$OUT")"
    docker buildx build "${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"}" "${args[@]}" --platform "$PLATFORMS" \
      --output "type=oci,dest=$OUT,name=$IMAGE:$VERSION" "$ROOT"
    echo "wrote $OUT ($(du -h "$OUT" | cut -f1)); platforms: $PLATFORMS"
    ;;
  push)
    docker buildx build "${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"}" "${args[@]}" --platform "$PLATFORMS" \
      -t "$REPO:$VERSION" --push "$ROOT"
    ;;
esac
echo "done in $(( $(date +%s) - START )) s"
