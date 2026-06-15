#!/usr/bin/env bash
# Build the reverse-connect gateway-agent binary for the platforms an isolated
# Linux host is likely to run. Pure Go, statically linked (CGO disabled) so the
# single file drops onto any matching host with no runtime dependencies.
#
# Usage:
#   scripts/build-agent.sh                  # → ./dist/agent  (linux amd64 + arm64)
#   scripts/build-agent.sh /srv/agent-dist  # custom output dir
#   TARGETS="linux/amd64" scripts/build-agent.sh   # build a subset
#
# The gateway serves these to operators over GET /dl/gateway-agent?os=&arch= so
# the install command on the network-domain page is copy-paste runnable. Point
# `agent.dist_dir` (config) at this output directory (default ./dist/agent).

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTDIR="${1:-$ROOT/dist/agent}"
mkdir -p "$OUTDIR"

# Stamp the build so the gateway can show which agent version is connected.
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)}"
TARGETS="${TARGETS:-linux/amd64 linux/arm64}"

cd "$ROOT"
for t in $TARGETS; do
    os="${t%/*}"
    arch="${t#*/}"
    out="$OUTDIR/gateway-agent-${os}-${arch}"
    [ "$os" = "windows" ] && out="${out}.exe"
    echo "[build-agent] $t → $out (version $VERSION)"
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
        go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
        -o "$out" ./cmd/gateway-agent
done

echo "[build-agent] done:"
ls -lh "$OUTDIR"
