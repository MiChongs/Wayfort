#!/usr/bin/env bash
# install-devolutions-gateway-linux.sh
#
# One-shot installer that fetches the latest Devolutions Gateway
# release from GitHub and drops the binary into $INSTALL_PREFIX. The
# upstream Linux release artefacts are plain ELF binaries (NOT
# tarballs / packages), so this script just curl-downloads and
# chmods — no extraction, no package manager.
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

# Architecture detection. Upstream uses `arm64` (NOT `aarch64`) in the
# release asset filename for both kernel-arch reporting conventions.
case "$(uname -m)" in
  x86_64|amd64) arch="x86_64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" 1 ;;
esac

for cmd in curl; do
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

# Asset filename is literal — no extension. Upstream ships the binary
# directly, presumably because the project is a single static-ish
# Rust executable.
asset="DevolutionsGateway_Linux_${DGW_VERSION}_${arch}"
url="${DGW_MIRROR}/v${DGW_VERSION}/${asset}"
dest="$INSTALL_PREFIX/devolutions-gateway"

log "downloading $url"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
if ! curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$tmp"; then
  die "download failed (check version + arch exist upstream, or set DGW_MIRROR=<internal>)"
fi

# Sanity check the download is actually an executable ELF and not an
# HTML error page returned by a mid-flight redirect. `file` is part
# of base on every distro we support.
if command -v file >/dev/null 2>&1; then
  case "$(file -b "$tmp")" in
    ELF*) : ;;
    *) die "downloaded payload is not ELF — upstream layout may have changed, please update this script" ;;
  esac
fi

install -m 0755 "$tmp" "$dest"
log "installed: $dest"
"$dest" --version || true
