package desktop

import (
	"embed"
	"io/fs"
)

// Plan 18 — embed the standalone worker module so the gateway binary
// can build itself a fresh `freerdp-worker` at runtime without needing
// the original source tree present on the deployment host.
//
// The mirror lives in `_workersrc/`; Go's tooling ignores `_`-prefixed
// directories during normal compilation but `//go:embed` reads them
// when prefixed with `all:`. The mirror is produced by
// `scripts/sync-workersrc.sh` and CI enforces it stays in lockstep with
// `cmd/freerdp-worker/` + `internal/desktop/{types,framed}.go`.

//go:embed all:_workersrc
var workerSourceFS embed.FS

// workerSourceTree returns a sub-filesystem rooted at `_workersrc/` so the
// extract step writes a clean module tree without the `_workersrc/`
// prefix baked into every path.
func workerSourceTree() (fs.FS, error) {
	return fs.Sub(workerSourceFS, "_workersrc")
}
