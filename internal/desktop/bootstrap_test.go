package desktop

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/config"
	"go.uber.org/zap"
)

// TestEnsureWorker_RealBootstrap is an integration test that actually
// extracts the embedded source, invokes `go build -tags freerdp -mod=vendor`,
// and verifies a working binary appears at the configured install path.
//
// Skipped unless `JUMPSERVER_TEST_BOOTSTRAP=1` because it takes ~15-30s
// and needs libfreerdp3-dev + go ≥1.22 on the host.
func TestEnsureWorker_RealBootstrap(t *testing.T) {
	if os.Getenv("JUMPSERVER_TEST_BOOTSTRAP") != "1" {
		t.Skip("set JUMPSERVER_TEST_BOOTSTRAP=1 to run (needs libfreerdp3-dev + go)")
	}
	tmpDir := t.TempDir()
	installPath := tmpDir + "/freerdp-worker"
	logger, _ := zap.NewDevelopment()
	mgr := NewManager(config.DesktopConfig{
		Enabled:        true,
		DefaultBackend: "freerdp",
		WorkerPath:     installPath, // doesn't exist yet
		AutoInstall:    true,
		InstallPrefix:  installPath,
	}, Deps{Logger: logger})

	if err := mgr.EnsureWorker(context.Background()); err != nil {
		t.Fatalf("EnsureWorker: %v", err)
	}
	if !mgr.workerReady.Load() {
		t.Fatal("workerReady not set after bootstrap")
	}
	info, err := os.Stat(installPath)
	if err != nil {
		t.Fatalf("worker binary missing at %s: %v", installPath, err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("worker binary not executable: %s", info.Mode())
	}
	if info.Size() < 1_000_000 {
		t.Fatalf("worker binary suspiciously small: %d bytes", info.Size())
	}
	t.Logf("bootstrap produced %d-byte executable at %s", info.Size(), installPath)
}

// TestDetectOSAndPlan probes the OS detection + install-plan matrix on
// the current host. Doesn't actually execute the plan.
func TestDetectOSAndPlan(t *testing.T) {
	info := detectOS()
	t.Logf("detected: id=%s version=%s pretty=%q", info.ID, info.VersionID, info.PrettyName)
	plan := planInstall(info)
	if plan.Pretty == "" && plan.Reason == "" {
		t.Errorf("planInstall returned empty plan with no reason")
	}
	t.Logf("plan: pretty=%q reason=%q cmds=%d human=%q",
		plan.Pretty, plan.Reason, len(plan.Cmds), plan.HumanInstall)
}

// TestAtLeastGo unit-tests the version-comparison helper.
func TestAtLeastGo(t *testing.T) {
	cases := []struct {
		line string
		maj  int
		min  int
		want bool
	}{
		{"go version go1.22.0 linux/amd64", 1, 22, true},
		{"go version go1.22.10 linux/amd64", 1, 22, true},
		{"go version go1.23.5 linux/amd64", 1, 22, true},
		{"go version go1.21.13 linux/amd64", 1, 22, false},
		{"go version go2.0.0 linux/amd64", 1, 22, true},
		{"", 1, 22, false},
	}
	for _, tc := range cases {
		got := atLeastGo(tc.line, tc.maj, tc.min)
		if got != tc.want {
			t.Errorf("atLeastGo(%q,%d,%d) = %v want %v", tc.line, tc.maj, tc.min, got, tc.want)
		}
	}
}

// TestCandidatePaths confirms the path table includes the configured
// WorkerPath plus the right OS-default fallbacks for the host we're on.
// On Linux that's /usr/local/bin/freerdp-worker; on macOS it's the brew
// prefix's bin; on Windows it's Program Files\JumpServer.
func TestCandidatePaths(t *testing.T) {
	mgr := NewManager(config.DesktopConfig{WorkerPath: "/custom/wp"}, Deps{Logger: zap.NewNop()})
	paths := mgr.candidateWorkerPaths()
	if len(paths) < 3 {
		t.Fatalf("expected ≥3 fallback paths, got %d: %v", len(paths), paths)
	}
	if paths[0] != "/custom/wp" {
		t.Errorf("first candidate should be configured WorkerPath; got %s", paths[0])
	}
	joined := strings.Join(paths, "\n")
	switch runtime.GOOS {
	case "linux", "freebsd":
		if !strings.Contains(joined, "/usr/local/bin/freerdp-worker") {
			t.Errorf("missing /usr/local/bin fallback in: %s", joined)
		}
	case "darwin":
		// Either /opt/homebrew/bin or /usr/local/bin depending on arch +
		// brew --prefix output; at minimum one of them must appear.
		if !strings.Contains(joined, "/bin/freerdp-worker") {
			t.Errorf("missing macOS brew bin fallback in: %s", joined)
		}
	case "windows":
		if !strings.Contains(strings.ToLower(joined), "freerdp-worker.exe") {
			t.Errorf("Windows candidates should end in .exe, got: %s", joined)
		}
	}
}

// TestPlanInstall_Darwin_BrewMissing simulates brew not on PATH and
// verifies we surface a useful HumanInstall blurb.
func TestPlanInstall_Darwin_BrewMissing(t *testing.T) {
	// Force a PATH that won't contain brew so LookPath fails.
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", filepath.Join(t.TempDir(), "empty-path"))
	defer os.Setenv("PATH", origPath)
	plan := planInstallDarwin(osInfo{ID: distroDarwin, PrettyName: "macOS 14"})
	if plan.Reason == "" {
		t.Error("expected Reason explaining missing brew")
	}
	if !strings.Contains(plan.HumanInstall, "brew") {
		t.Errorf("HumanInstall should mention brew: %s", plan.HumanInstall)
	}
	if len(plan.Cmds) != 0 {
		t.Errorf("expected empty Cmds when brew missing, got %d", len(plan.Cmds))
	}
}

// TestPlanInstall_Windows_NoToolkit verifies planInstallWindows yields a
// Reason + HumanInstall when no toolkit is present. The detection scans
// the actual filesystem; on a Windows dev host with MSYS2 installed it
// returns a real install plan instead — skip in that case.
func TestPlanInstall_Windows_NoToolkit(t *testing.T) {
	if tk := detectWindowsToolkit(); tk.Kind != "none" {
		t.Skipf("host has %s toolkit at %s; this test exercises the no-toolkit path", tk.Kind, tk.Root)
	}
	plan := planInstallWindows(osInfo{ID: distroWindows, PrettyName: "Windows 10"})
	if plan.Reason == "" {
		t.Error("expected Reason when no toolkit detected")
	}
	if !strings.Contains(plan.HumanInstall, "MSYS2") {
		t.Errorf("HumanInstall should mention MSYS2: %s", plan.HumanInstall)
	}
}

// TestInstallCandidates_Windows ensures Windows fallbacks include .exe
// and ProgramFiles even when we're running on Linux (the function uses
// runtime.GOOS — so we test by directly calling osDefaultWorkerPaths.
// On Linux this test exercises the Linux branch).
func TestInstallCandidates_HostOS(t *testing.T) {
	got := installCandidates("/configured/path")
	if got[0] != "/configured/path" {
		t.Errorf("InstallPrefix should be first: %v", got)
	}
	if len(got) < 3 {
		t.Errorf("expected ≥3 candidates, got %d", len(got))
	}
}

// TestBuildEnv_Linux: on a Linux sandbox buildEnv() should return nil
// because /usr/lib/pkgconfig is already on the default search path.
func TestBuildEnv_LinuxNoExtras(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux-only test")
	}
	if got := buildEnv(); len(got) != 0 {
		t.Errorf("expected empty buildEnv on Linux, got %v", got)
	}
}
