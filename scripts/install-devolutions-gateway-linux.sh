#!/usr/bin/env bash
# install-devolutions-gateway-linux.sh
#
# Downloads the Devolutions Gateway release archive for the current
# Linux distribution + architecture and extracts the binary into
# $INSTALL_PREFIX. Designed to replace the libfreerdp-driven
# `build-worker-linux.sh` chain: no compiler, no MSYS2, no cgo —
# just a static binary distributed by Devolutions.
#
# Environment overrides:
#   DGW_VERSION       — pinned release (default: the version this script
#                       was last validated against; bump in lockstep with
#                       the rest of the repo when upgrading)
#   INSTALL_PREFIX    — where the binary lands (default: /opt/jumpserver/
#                       devolutions-gateway)
#   DGW_MIRROR        — alternative base URL when github.com release
#                       artefacts are slow from the deploy host (e.g.
#                       an internal mirror)
#
# Exit codes: 0 OK, 1 toolchain/env problem, 2 download/extract problem.
set -euo pipefail

DGW_VERSION="${DGW_VERSION:-2025.3.5}"
INSTALL_PREFIX="${INSTALL_PREFIX:-/opt/jumpserver/devolutions-gateway}"
DGW_MIRROR="${DGW_MIRROR:-https://github.com/Devolutions/devolutions-gateway/releases/download}"

log() { printf '[install-devolutions-gateway] %s\n' "$*" >&2; }
die() { log "$*"; exit "${2:-2}"; }

case "$(uname -m)" in
  x86_64|amd64) arch="x86_64" ;;
  aarch64|arm64) arch="aarch64" ;;
  *) die "unsupported architecture: $(uname -m)" 1 ;;
esac

for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required (apt install $cmd / dnf install $cmd)" 1
done

mkdir -p "$INSTALL_PREFIX"
mkdir -p "$INSTALL_PREFIX/config"

# Devolutions publishes a tarball per arch under the release tag. The
# inside layout puts the binary at usr/bin/devolutions-gateway, which
# we relocate to $INSTALL_PREFIX/devolutions-gateway for a single
# self-contained directory the supervisor knows.
asset="DevolutionsGateway_linux_${DGW_VERSION}_${arch}.tar.gz"
url="${DGW_MIRROR}/v${DGW_VERSION}/${asset}"
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

log "downloading $url"
if ! curl -fsSL "$url" -o "$tmpdir/dgw.tar.gz"; then
  die "download failed (try mirror via DGW_MIRROR=, or verify DGW_VERSION=$DGW_VERSION exists upstream)"
fi
log "extracting"
tar -xzf "$tmpdir/dgw.tar.gz" -C "$tmpdir"

bin=""
for candidate in \
  "$tmpdir/usr/bin/devolutions-gateway" \
  "$tmpdir/devolutions-gateway" \
  "$tmpdir/DevolutionsGateway-${DGW_VERSION}/devolutions-gateway"; do
  if [ -f "$candidate" ]; then
    bin="$candidate"
    break
  fi
done
if [ -z "$bin" ]; then
  die "devolutions-gateway binary not found in archive (layout drift; update this script)"
fi

install -m 0755 "$bin" "$INSTALL_PREFIX/devolutions-gateway"
log "installed: $INSTALL_PREFIX/devolutions-gateway"
"$INSTALL_PREFIX/devolutions-gateway" --version || true
