#!/usr/bin/env bash
# install-devolutions-gateway-darwin.sh
#
# Downloads the Devolutions Gateway macOS .pkg, extracts it without
# running the installer (no admin password prompt, no system-wide
# install), and copies the binary into $INSTALL_PREFIX.
#
# Environment overrides — see install-devolutions-gateway-linux.sh.

set -euo pipefail

DGW_VERSION="${DGW_VERSION:-2025.3.5}"
INSTALL_PREFIX="${INSTALL_PREFIX:-$HOME/Library/Application Support/JumpServer/devolutions-gateway}"
DGW_MIRROR="${DGW_MIRROR:-https://github.com/Devolutions/devolutions-gateway/releases/download}"

log() { printf '[install-devolutions-gateway] %s\n' "$*" >&2; }
die() { log "$*"; exit "${2:-2}"; }

case "$(uname -m)" in
  x86_64|amd64) arch="x86_64" ;;
  arm64) arch="aarch64" ;;
  *) die "unsupported architecture: $(uname -m)" 1 ;;
esac

for cmd in curl pkgutil cpio; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required" 1
done

mkdir -p "$INSTALL_PREFIX"
mkdir -p "$INSTALL_PREFIX/config"

asset="DevolutionsGateway_macos_${DGW_VERSION}_${arch}.pkg"
url="${DGW_MIRROR}/v${DGW_VERSION}/${asset}"
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

log "downloading $url"
if ! curl -fsSL "$url" -o "$tmpdir/dgw.pkg"; then
  die "download failed (try mirror via DGW_MIRROR=, or verify DGW_VERSION=$DGW_VERSION exists upstream)"
fi
log "expanding pkg"
pkgutil --expand-full "$tmpdir/dgw.pkg" "$tmpdir/expanded"

# Locate the binary in the unpacked .pkg payload. Devolutions has
# changed pkg layout between releases; pick the first match.
bin=$(find "$tmpdir/expanded" -name devolutions-gateway -type f -perm -u+x | head -n1)
[ -n "$bin" ] || die "devolutions-gateway binary not found in pkg payload"

install -m 0755 "$bin" "$INSTALL_PREFIX/devolutions-gateway"
log "installed: $INSTALL_PREFIX/devolutions-gateway"
"$INSTALL_PREFIX/devolutions-gateway" --version || true
