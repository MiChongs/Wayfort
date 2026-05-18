#!/usr/bin/env bash
# Build + install the freerdp-worker binary on macOS via Homebrew.
#
# Usage:
#   scripts/build-worker-darwin.sh                       # install to $(brew --prefix)/bin
#   scripts/build-worker-darwin.sh ~/.local/bin          # custom install dir
#   SKIP_DEPS=1 scripts/build-worker-darwin.sh           # skip brew install

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

if ! command -v brew >/dev/null; then
    echo "ERROR: Homebrew not on PATH. Install via:" >&2
    echo "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"" >&2
    exit 1
fi

BREW_PREFIX="$(brew --prefix)"
PREFIX="${1:-$BREW_PREFIX/bin}"

if [ -z "${SKIP_DEPS:-}" ]; then
    echo "[build-worker-darwin] installing build deps via Homebrew"
    brew install freerdp pkg-config go || true
fi

export PKG_CONFIG_PATH="$BREW_PREFIX/lib/pkgconfig:$BREW_PREFIX/share/pkgconfig:${PKG_CONFIG_PATH:-}"
export PATH="$BREW_PREFIX/bin:$PATH"

echo "[build-worker-darwin] verifying toolchain"
command -v go        >/dev/null || { echo "go not on PATH after install" >&2; exit 1; }
command -v pkg-config >/dev/null || { echo "pkg-config not on PATH" >&2; exit 1; }
pkg-config --exists freerdp3 || { echo "pkg-config can't find freerdp3 — brew install likely failed" >&2; exit 1; }

echo "[build-worker-darwin] compiling (this typically takes 10-30s)"
cd "$ROOT"
TMP_OUT="$(mktemp -d)/freerdp-worker"
trap 'rm -rf "$(dirname "$TMP_OUT")"' EXIT
CGO_ENABLED=1 go build -tags freerdp -trimpath -o "$TMP_OUT" ./cmd/freerdp-worker

echo "[build-worker-darwin] installing to $PREFIX/freerdp-worker"
mkdir -p "$PREFIX"
mv "$TMP_OUT" "$PREFIX/freerdp-worker"
chmod +x "$PREFIX/freerdp-worker"

echo "[build-worker-darwin] done"
ls -lh "$PREFIX/freerdp-worker"
