#!/usr/bin/env bash
# install-devolutions-gateway-linux.sh
#
# One-shot installer that fetches a Devolutions Gateway release from
# GitHub and installs the `devolutions-gateway` binary into $INSTALL_PREFIX.
# Upstream ships the Linux build as an xz tarball, e.g.
#   devolutions-gateway-<ver>-linux-<x64|arm64>.tar.xz
# so this script downloads it, extracts the binary, and installs it.
# Requires: curl + tar (with xz support — `xz-utils` on Debian).
#
# Environment overrides:
#   DGW_VERSION   pinned release version (default: latest from GitHub API)
#   INSTALL_PREFIX  where the binary lands (default: /opt/wayfort/
#                   devolutions-gateway)
#   DGW_MIRROR    alternative base URL when the github.com release CDN
#                 is slow from the deploy host (e.g. an internal mirror).
#                 The script appends `/v<version>/<asset>` to this URL.
#
# Exit codes: 0 OK, 1 toolchain/env problem, 2 download problem.
set -euo pipefail

INSTALL_PREFIX="${INSTALL_PREFIX:-/opt/wayfort/devolutions-gateway}"
DGW_MIRROR="${DGW_MIRROR:-https://github.com/Devolutions/devolutions-gateway/releases/download}"
DGW_API="${DGW_API:-https://api.github.com/repos/Devolutions/devolutions-gateway/releases/latest}"

log() { printf '[install-devolutions-gateway] %s\n' "$*" >&2; }
die() { log "$*"; exit "${2:-2}"; }

# Architecture → upstream asset suffix. Tarball names use `x64` / `arm64`
# (devolutions-gateway-<ver>-linux-<arch>.tar.xz).
case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" 1 ;;
esac

for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required (apt install $cmd / dnf install $cmd)" 1
done

# Resolve the version: explicit override or latest-from-GitHub-API.
if [ -z "${DGW_VERSION:-}" ]; then
  log "querying GitHub for latest release tag"
  # Write the API response to a FILE (curl -o), NOT a pipe / command-substitution.
  # Two failure modes have bitten here: (1) `curl | grep -m1` makes grep close the
  # pipe early → curl SIGPIPE; (2) even `$(curl …)` command-substitution can fail
  # mid-stream with "(23) Failure writing output to destination" in constrained
  # build sandboxes. Writing to a regular file is the same reliable path the binary
  # download below uses (and that apt / go build use); then parse with a
  # non-early-closing `sed -n …/p` and keep the first line via shell expansion.
  api_file="$(mktemp)"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$api_file" "$DGW_API"; then
    rm -f "$api_file"
    die "could not reach $DGW_API (rate-limited / blocked? set DGW_VERSION=<x.y.z> to skip the lookup, or DGW_MIRROR=<internal mirror>)"
  fi
  tag=$(sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/p' "$api_file")
  tag=${tag%%$'\n'*}
  rm -f "$api_file"
  if [ -z "$tag" ]; then
    die "could not parse tag_name from $DGW_API (rate-limited? set DGW_VERSION=<x.y.z> to skip)"
  fi
  DGW_VERSION="$tag"
fi
log "installing Devolutions Gateway $DGW_VERSION ($arch) into $INSTALL_PREFIX"

mkdir -p "$INSTALL_PREFIX"
mkdir -p "$INSTALL_PREFIX/config"

# Upstream Linux asset is an xz tarball, e.g.
#   devolutions-gateway-2026.2.2-linux-x64.tar.xz
asset="devolutions-gateway-${DGW_VERSION}-linux-${arch}.tar.xz"
url="${DGW_MIRROR}/v${DGW_VERSION}/${asset}"
dest="$INSTALL_PREFIX/devolutions-gateway"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tarball="$work/dgw.tar.xz"

log "downloading $url"
if ! curl -fsSL --retry 3 --retry-delay 2 -o "$tarball" "$url"; then
  die "download failed (check version + arch exist upstream, or set DGW_MIRROR=<internal>)"
fi

log "extracting"
tar -xJf "$tarball" -C "$work" || die "extract failed — need tar with xz support (apt install xz-utils)"

# Locate the gateway binary inside the tarball (layout may be flat or nested).
# Avoid `find | head` (SIGPIPE under pipefail): collect matches, keep the first.
matches="$(find "$work" -type f -name devolutions-gateway)"
bin_path="${matches%%$'\n'*}"
[ -n "$bin_path" ] || die "devolutions-gateway binary not found in $asset — upstream layout may have changed"

# Sanity-check it's an ELF, not an HTML error page or unexpected payload.
if command -v file >/dev/null 2>&1; then
  case "$(file -b "$bin_path")" in
    ELF*) : ;;
    *) die "extracted payload is not ELF — upstream layout may have changed, please update this script" ;;
  esac
fi

install -m 0755 "$bin_path" "$dest"
log "installed: $dest"
"$dest" --version || true
