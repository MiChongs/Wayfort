#!/usr/bin/env bash
# Build the jumpserver gateway binary. No CGo — pure Go, works on every
# OS Go supports.
#
# Usage:
#   scripts/build-gateway.sh                # output to ./bin
#   scripts/build-gateway.sh ~/jumpserver   # output to a custom dir

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTDIR="${1:-$ROOT/bin}"
mkdir -p "$OUTDIR"

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
    *) EXT="" ;;
esac

cd "$ROOT"
echo "[build-gateway] go build -trimpath -o $OUTDIR/jumpserver$EXT ./cmd/jumpserver"
go build -trimpath -o "$OUTDIR/jumpserver$EXT" ./cmd/jumpserver
ls -lh "$OUTDIR/jumpserver$EXT"
