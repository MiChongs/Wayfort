#!/usr/bin/env bash
# Build the wayfort gateway binary. No CGo — pure Go, works on every
# OS Go supports.
#
# Usage:
#   scripts/build-gateway.sh                # output to ./bin
#   scripts/build-gateway.sh ~/wayfort   # output to a custom dir

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTDIR="${1:-$ROOT/bin}"
mkdir -p "$OUTDIR"

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
    *) EXT="" ;;
esac

cd "$ROOT"
echo "[build-gateway] go build -trimpath -o $OUTDIR/wayfort$EXT ./cmd/wayfort"
go build -trimpath -o "$OUTDIR/wayfort$EXT" ./cmd/wayfort
ls -lh "$OUTDIR/wayfort$EXT"
