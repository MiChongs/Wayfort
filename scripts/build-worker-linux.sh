#!/usr/bin/env bash
# Build + install the freerdp-worker binary on Linux.
#
# Usage:
#   scripts/build-worker-linux.sh                # default install dir: /usr/local/bin
#   scripts/build-worker-linux.sh ~/.local/bin   # custom install dir (no sudo needed)
#   SKIP_DEPS=1 scripts/build-worker-linux.sh    # skip apt/dnf/apk, build only
#
# Installs libfreerdp 3.x + pkg-config + go via the distro's package
# manager, then `go build -tags freerdp`. The worker is placed at one of
# the paths internal/desktop/bootstrap_paths.go searches, so the gateway
# picks it up on startup without any extra config.

set -euo pipefail

PREFIX="${1:-/usr/local/bin}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if [ ! -f /etc/os-release ]; then
    echo "ERROR: /etc/os-release missing — can't detect distro." >&2
    echo "Install libfreerdp 3.x + pkg-config + go ≥1.22 manually, then re-run with SKIP_DEPS=1." >&2
    exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release
FAMILY=unknown
for hint in "${ID:-}" ${ID_LIKE:-}; do
    case "$hint" in
        ubuntu|debian|linuxmint|raspbian|pop)
            FAMILY=debian ;;
        fedora|rhel|centos|rocky|almalinux|amzn|ol)
            FAMILY=fedora ;;
        alpine)
            FAMILY=alpine ;;
    esac
    [ "$FAMILY" != "unknown" ] && break
done

if [ "$FAMILY" = "unknown" ]; then
    echo "ERROR: unsupported distro (ID=${ID:-?}, ID_LIKE=${ID_LIKE:-?})." >&2
    echo "Install libfreerdp 3.x + pkg-config + go ≥1.22 manually, then re-run with SKIP_DEPS=1." >&2
    exit 1
fi

if [ -z "${SKIP_DEPS:-}" ]; then
    echo "[build-worker-linux] installing build deps via $FAMILY package manager"
    case "$FAMILY" in
        debian)
            sudo apt-get update
            sudo apt-get install -y --no-install-recommends \
                freerdp3-dev libwinpr3-dev libvpx-dev libaom-dev libturbojpeg0-dev \
                pkg-config build-essential golang
            ;;
        fedora)
            sudo dnf install -y freerdp-devel libvpx-devel libaom-devel turbojpeg-devel \
                pkg-config gcc golang
            ;;
        alpine)
            sudo apk add --no-cache freerdp-dev libvpx-dev aom-dev libjpeg-turbo-dev \
                pkgconfig build-base go
            ;;
    esac
fi

echo "[build-worker-linux] verifying toolchain"
command -v go        >/dev/null || { echo "go not on PATH after install" >&2; exit 1; }
command -v pkg-config >/dev/null || { echo "pkg-config not on PATH after install" >&2; exit 1; }
pkg-config --exists freerdp3 || { echo "pkg-config can't find freerdp3 — package install failed silently" >&2; exit 1; }
pkg-config --exists vpx || { echo "pkg-config can't find vpx (libvpx-dev) — needed by the WebRTC VP8/VP9 encoder" >&2; exit 1; }
pkg-config --exists aom || { echo "pkg-config can't find aom (libaom-dev) — needed by the WebRTC AV1 encoder" >&2; exit 1; }
pkg-config --exists libturbojpeg || { echo "pkg-config can't find libturbojpeg (libturbojpeg0-dev) — needed by the SIMD JPEG rect encoder" >&2; exit 1; }

echo "[build-worker-linux] compiling (this typically takes 10-30s)"
cd "$ROOT"
TMP_OUT="$(mktemp -d)/freerdp-worker"
trap 'rm -rf "$(dirname "$TMP_OUT")"' EXIT
CGO_ENABLED=1 go build -tags freerdp -trimpath -o "$TMP_OUT" ./cmd/freerdp-worker

echo "[build-worker-linux] installing to $PREFIX/freerdp-worker"
mkdir -p "$PREFIX"
if [ -w "$PREFIX" ]; then
    mv "$TMP_OUT" "$PREFIX/freerdp-worker"
else
    sudo mv "$TMP_OUT" "$PREFIX/freerdp-worker"
fi
chmod +x "$PREFIX/freerdp-worker" 2>/dev/null || sudo chmod +x "$PREFIX/freerdp-worker"

echo "[build-worker-linux] done"
ls -lh "$PREFIX/freerdp-worker"
