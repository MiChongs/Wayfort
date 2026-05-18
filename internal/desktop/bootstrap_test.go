package desktop

import (
	"runtime"
	"strings"
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/config"
	"go.uber.org/zap"
)

// TestCandidatePaths confirms the path table includes the configured
// WorkerPath plus the right OS-default fallbacks for the host we're on.
// On Linux that's /usr/local/bin/freerdp-worker; on macOS it's the brew
// prefix's bin; on Windows it's Program Files\JumpServer.
func TestCandidatePaths(t *testing.T) {
	mgr := NewManager(config.DesktopConfig{WorkerPath: "/custom/wp"}, Deps{Logger: zap.NewNop()})
	paths := mgr.candidateWorkerPaths()
	if len(paths) < 3 {
		t.Fatalf("expected ≥3 path entries, got %d: %v", len(paths), paths)
	}
	if paths[0] != "/custom/wp" {
		t.Errorf("first entry should be the configured WorkerPath; got %s", paths[0])
	}
	joined := strings.Join(paths, "\n")
	switch runtime.GOOS {
	case "linux", "freebsd":
		if !strings.Contains(joined, "/usr/local/bin/freerdp-worker") {
			t.Errorf("missing /usr/local/bin entry in: %s", joined)
		}
	case "darwin":
		if !strings.Contains(joined, "/bin/freerdp-worker") {
			t.Errorf("missing macOS brew bin entry in: %s", joined)
		}
	case "windows":
		if !strings.Contains(strings.ToLower(joined), "freerdp-worker.exe") {
			t.Errorf("Windows entries should end in .exe, got: %s", joined)
		}
	}
}

// TestBuildHintForGOOS makes sure every OS the binary runs on has a
// build hint surfaced. Without this, a host with an unknown runtime.GOOS
// would silently emit an empty hint string in the startup log.
func TestBuildHintForGOOS(t *testing.T) {
	hint := buildHintForGOOS()
	if hint == "" {
		t.Fatalf("buildHintForGOOS returned empty hint on %s", runtime.GOOS)
	}
}
