package desktop

import (
	"embed"
	"fmt"
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

// requiredEmbedFiles lists files that MUST be present in the embed for
// the worker build to succeed. Any extension (a new rdp/ source file,
// say) should keep the list short — these are the entry points the
// extract+build pipeline calls into.
var requiredEmbedFiles = []string{
	"cmd/freerdp-worker/main.go",
	"desktop/types.go",
	"desktop/framed.go",
	"go.mod.tmpl",
}

// workerSourceTree returns a sub-filesystem rooted at `_workersrc/` so the
// extract step writes a clean module tree without the `_workersrc/`
// prefix baked into every path.
//
// Validates the mirror is intact before returning — a stale binary built
// against an out-of-sync mirror would otherwise fail later with a cryptic
// "directory not found" from `go build`, and the operator has no way to
// figure out it's a release-process bug rather than their environment.
func workerSourceTree() (fs.FS, error) {
	sub, err := fs.Sub(workerSourceFS, "_workersrc")
	if err != nil {
		return nil, err
	}
	for _, p := range requiredEmbedFiles {
		if _, err := fs.Stat(sub, p); err != nil {
			return nil, fmt.Errorf("%w: %s is missing — rebuild the gateway after running scripts/sync-workersrc.sh",
				ErrEmbedIncomplete, p)
		}
	}
	return sub, nil
}
