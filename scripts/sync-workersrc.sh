#!/usr/bin/env bash
# Plan 18 — keep internal/desktop/_workersrc/ in sync with cmd/freerdp-worker
# and the desktop-package files the worker depends on. The mirror is what
# the gateway binary embeds via //go:embed for runtime self-build.
#
# Why not embed cmd/freerdp-worker/ directly: Go's //go:embed cannot ascend
# the package directory. We need the embed in internal/desktop/ so we
# maintain a sibling copy + rewrite imports.
#
# CI invariant: run this script, then `git diff --exit-code` must be clean.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/internal/desktop/_workersrc"

echo "[sync-workersrc] mirroring cmd/freerdp-worker + internal/desktop type files into _workersrc"

rm -rf "$DEST"
mkdir -p "$DEST/cmd/freerdp-worker/rdp" "$DEST/desktop"

# 1. Worker sources (main + rdp/*).
cp "$ROOT/cmd/freerdp-worker/main.go"     "$DEST/cmd/freerdp-worker/"
cp "$ROOT/cmd/freerdp-worker/rdp/"*.go    "$DEST/cmd/freerdp-worker/rdp/"

# 2. Minimum subset of internal/desktop the worker actually imports — types
#    (DesktopWorker / ServerMessage / etc.) and framed (length-prefix codec).
cp "$ROOT/internal/desktop/types.go"      "$DEST/desktop/"
cp "$ROOT/internal/desktop/framed.go"     "$DEST/desktop/"

# 3. Rewrite worker import paths to point at the standalone embed module.
#    Both `internal/desktop` and the worker's own `cmd/freerdp-worker/rdp`
#    sub-package need to migrate from github.com/michongs/... → the embed
#    module's path.
find "$DEST/cmd/freerdp-worker" -name '*.go' -exec sed -i \
  -e 's|github.com/michongs/jumpserver-anonymous/internal/desktop|jumpserver-worker-embed/desktop|g' \
  -e 's|github.com/michongs/jumpserver-anonymous/cmd/freerdp-worker/rdp|jumpserver-worker-embed/cmd/freerdp-worker/rdp|g' \
  {} +

# 4. Synthesize the embed module's go.mod. We pin go.uber.org/zap to the
#    same minor the gateway uses — go mod tidy below fetches the rest.
cat > "$DEST/go.mod" <<'EOF'
// Plan 18 — embed-only module that lives inside internal/desktop/_workersrc.
// Built at runtime by the bootstrapper to produce the freerdp-worker
// binary when the gateway can't find a pre-existing one.
module jumpserver-worker-embed

go 1.22

require go.uber.org/zap v1.27.0
EOF

# 5. Resolve transitive dependencies + vendor them so runtime builds don't
#    need network access. `go mod tidy` populates go.sum; `go mod vendor`
#    copies dependency sources into vendor/.
( cd "$DEST" && go mod tidy && go mod vendor )

# 6. Rename go.mod/go.sum → *.tmpl so the outer module's `//go:embed`
#    doesn't refuse to embed a "different module". Bootstrap.go renames
#    them back at extract time.
mv "$DEST/go.mod" "$DEST/go.mod.tmpl"
[ -f "$DEST/go.sum" ] && mv "$DEST/go.sum" "$DEST/go.sum.tmpl"

# 7. Drop a stamp file with the source commit so we can detect mismatches.
git -C "$ROOT" rev-parse HEAD > "$DEST/SOURCE_SHA" 2>/dev/null || \
  echo "unknown" > "$DEST/SOURCE_SHA"

echo "[sync-workersrc] done — $DEST"
