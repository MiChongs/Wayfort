#!/usr/bin/env bash
# install-devolutions-gateway-darwin.sh
#
# Devolutions does not currently publish a standalone macOS binary for
# the Gateway (only the `jetsocat-macos-*` companion). On macOS we
# build from the upstream Rust source via `cargo install`. The host
# therefore needs a Rust toolchain; the script bails with a clear
# bootstrap hint if cargo is missing.
#
# Environment overrides:
#   DGW_VERSION     pinned upstream tag (default: latest from GitHub API)
#   INSTALL_PREFIX  where the binary lands (default:
#                   ~/Library/Application Support/Wayfort/devolutions-gateway)

set -euo pipefail

INSTALL_PREFIX="${INSTALL_PREFIX:-$HOME/Library/Application Support/Wayfort/devolutions-gateway}"
DGW_API="${DGW_API:-https://api.github.com/repos/Devolutions/devolutions-gateway/releases/latest}"
DGW_REPO="${DGW_REPO:-https://github.com/Devolutions/devolutions-gateway.git}"

log() { printf '[install-devolutions-gateway] %s\n' "$*" >&2; }
die() { log "$*"; exit "${2:-2}"; }

if ! command -v cargo >/dev/null 2>&1; then
  die "macOS install requires Rust. Install it with:
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
      Then re-run this script. (Upstream does not publish a macOS
      gateway binary; we build it via cargo install.)" 1
fi

for cmd in curl git; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required (xcode-select --install or brew install $cmd)" 1
done

# Resolve version: explicit override or latest-from-GitHub-API.
if [ -z "${DGW_VERSION:-}" ]; then
  log "querying GitHub for latest release tag"
  tag=$(curl -fsSL "$DGW_API" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/')
  if [ -z "$tag" ]; then
    die "could not parse tag_name from $DGW_API (rate-limited? set DGW_VERSION=<x.y.z> to skip)"
  fi
  DGW_VERSION="$tag"
fi
log "building Devolutions Gateway $DGW_VERSION from source via cargo"

mkdir -p "$INSTALL_PREFIX"
mkdir -p "$INSTALL_PREFIX/config"

# `cargo install` builds the `devolutions-gateway` binary from the
# pinned tag and drops it under $CARGO_HOME/bin (default ~/.cargo/bin).
# `--locked` honours the upstream Cargo.lock so we don't pull
# unexpectedly newer transitive deps. `--force` is set so a rerun
# replaces a prior install of the same tag without complaints.
cargo install \
  --locked \
  --force \
  --git "$DGW_REPO" \
  --tag "v${DGW_VERSION}" \
  --bin devolutions-gateway \
  devolutions-gateway

src_bin="${CARGO_HOME:-$HOME/.cargo}/bin/devolutions-gateway"
[ -x "$src_bin" ] || die "expected cargo-installed binary at $src_bin not found"

install -m 0755 "$src_bin" "$INSTALL_PREFIX/devolutions-gateway"
log "installed: $INSTALL_PREFIX/devolutions-gateway"
"$INSTALL_PREFIX/devolutions-gateway" --version || true
