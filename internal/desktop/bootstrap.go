package desktop

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"go.uber.org/zap"
)

// Plan 18 — startup self-check that lazily installs system dependencies,
// extracts the embedded worker source, builds the freerdp-worker binary,
// and deposits it at a discoverable path. On second startup the path
// check short-circuits everything.
//
// Entry point: Manager.EnsureWorker (called from cmd/jumpserver/main.go
// in a background goroutine so HTTP comes up immediately).

// candidateWorkerPaths returns the existence-check sweep before invoking
// the bootstrap pipeline. Plan 19 moved the body to bootstrap_paths.go
// so it can branch on runtime.GOOS (Windows uses .exe, macOS uses brew
// prefix, Linux uses /usr/local/bin).
func (m *Manager) candidateWorkerPaths() []string {
	return candidateWorkerPaths(m.cfg.WorkerPath)
}

// isExecutable is now defined in bootstrap_paths.go to give Windows the
// `.exe` suffix check instead of Unix mode bits.

// EnsureWorker drives the entire startup self-check. Returns nil even
// when the bootstrap fails — the gateway continues to run and individual
// session starts will return a clear error mentioning the failure.
func (m *Manager) EnsureWorker(ctx context.Context) error {
	if !m.cfg.Enabled {
		return nil
	}
	if m.cfg.DefaultBackend == "dummy" {
		// The in-process dummy worker never needs a binary. Mark ready
		// so session starts proceed.
		m.workerReady.Store(true)
		return nil
	}

	// 1. Short-circuit when an existing binary is found.
	for _, p := range m.candidateWorkerPaths() {
		if isExecutable(p) {
			m.logger.Info("desktop worker found", zap.String("path", p))
			m.cfg.WorkerPath = p
			m.workerReady.Store(true)
			return nil
		}
	}

	if !m.cfg.AutoInstall {
		m.logger.Warn("desktop worker missing and auto_install is disabled",
			zap.String("expected_path", m.cfg.WorkerPath))
		return errors.New("desktop worker not found and auto_install disabled")
	}

	m.logger.Info("desktop worker not found — starting bootstrap (this can take 30-90s)")
	startedAt := time.Now()
	if err := m.runBootstrap(ctx); err != nil {
		m.logger.Error("desktop worker bootstrap failed", zap.Error(err),
			zap.Duration("elapsed", time.Since(startedAt)))
		// Don't return the error — we want the gateway to keep running.
		return nil
	}
	m.workerReady.Store(true)
	m.logger.Info("desktop worker bootstrap complete",
		zap.String("path", m.cfg.WorkerPath),
		zap.Duration("elapsed", time.Since(startedAt)))
	return nil
}

// runBootstrap is the actual install → extract → build → deploy pipeline.
// Each step logs progress; on failure it returns the first error and
// leaves any artefacts in /tmp for debugging.
func (m *Manager) runBootstrap(ctx context.Context) error {
	// 1. Detect OS and plan dependency install.
	info := detectOS()
	plan := planInstall(info)
	m.logger.Info("detected platform",
		zap.String("pretty", info.PrettyName), zap.String("id", string(info.ID)))

	// 2. Install build deps (best-effort — if it fails AND go+pkg-config
	//    are already present, continue).
	if len(plan.Cmds) > 0 {
		m.logger.Info("installing system packages", zap.String("hint", plan.HumanInstall))
		for _, c := range plan.Cmds {
			if out, err := runInstallCmd(ctx, c); err != nil {
				m.logger.Warn("package manager invocation failed",
					zap.Strings("cmd", c.Argv),
					zap.String("output", truncate(string(out), 400)),
					zap.Error(err))
				// Don't abort yet — maybe deps are already there.
			}
		}
	} else if plan.Reason != "" {
		m.logger.Warn("no automatic install plan", zap.String("reason", plan.Reason),
			zap.String("manual", plan.HumanInstall))
		// Continue — operator may have installed deps manually.
	}

	// 3. Verify the toolchain we need is now reachable.
	if err := verifyBuildToolchain(ctx); err != nil {
		return fmt.Errorf("toolchain check: %w (hint: %s)", err, plan.HumanInstall)
	}

	// 4. Extract embedded source into a temp dir.
	srcDir, err := m.extractEmbeddedSource()
	if err != nil {
		return fmt.Errorf("extract: %w", err)
	}
	m.logger.Info("extracted embedded worker source", zap.String("dir", srcDir))

	// 5. Build the binary. Output name is platform-aware (.exe on Windows).
	tmpBin := filepath.Join(srcDir, workerBaseName())
	if err := buildWorker(ctx, srcDir, tmpBin, m.logger); err != nil {
		return fmt.Errorf("build: %w", err)
	}

	// 6. Move to a discoverable install path.
	installed, err := m.installBinary(tmpBin)
	if err != nil {
		return fmt.Errorf("install: %w", err)
	}
	m.cfg.WorkerPath = installed

	// 7. Clean up the build dir (leave on failure so operator can debug).
	_ = os.RemoveAll(srcDir)
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// verifyBuildToolchain confirms `go`, `gcc`, and `pkg-config` are usable
// after the install attempt. If any is missing or `go` is < 1.22 we abort.
func verifyBuildToolchain(ctx context.Context) error {
	if _, err := exec.LookPath("go"); err != nil {
		return errors.New("go toolchain not found in PATH")
	}
	if out, err := exec.CommandContext(ctx, "go", "version").CombinedOutput(); err != nil {
		return fmt.Errorf("go version: %w (%s)", err, string(out))
	} else {
		ver := string(out)
		if !atLeastGo(ver, 1, 22) {
			return fmt.Errorf("go ≥1.22 required, got: %s", strings.TrimSpace(ver))
		}
	}
	if _, err := exec.LookPath("gcc"); err != nil {
		// cc symlink works too on some distros (clang→cc, etc.).
		if _, err2 := exec.LookPath("cc"); err2 != nil {
			return errors.New("C compiler (gcc/cc) not found")
		}
	}
	if _, err := exec.LookPath("pkg-config"); err != nil {
		return errors.New("pkg-config not found")
	}
	if out, err := exec.CommandContext(ctx, "pkg-config", "--exists", "freerdp3").CombinedOutput(); err != nil {
		return fmt.Errorf("pkg-config can't find freerdp3 (%s)", string(out))
	}
	return nil
}

// atLeastGo parses `go version go1.22.3 …` and compares.
func atLeastGo(versionLine string, minMajor, minMinor int) bool {
	idx := strings.Index(versionLine, " go")
	if idx < 0 {
		return false
	}
	ver := versionLine[idx+3:]
	dot := strings.IndexByte(ver, ' ')
	if dot < 0 {
		dot = len(ver)
	}
	ver = ver[:dot]
	parts := strings.Split(ver, ".")
	if len(parts) < 2 {
		return false
	}
	var maj, min int
	if _, err := fmt.Sscanf(parts[0], "%d", &maj); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(parts[1], "%d", &min); err != nil {
		return false
	}
	if maj > minMajor {
		return true
	}
	return maj == minMajor && min >= minMinor
}

// extractEmbeddedSource writes the contents of the embedded _workersrc/
// sub-filesystem out to a fresh temp directory. Returns the directory
// root so the caller can `go build` from there.
func (m *Manager) extractEmbeddedSource() (string, error) {
	root, err := workerSourceTree()
	if err != nil {
		return "", err
	}
	dst, err := os.MkdirTemp("", "jumpserver-worker-build-*")
	if err != nil {
		return "", err
	}
	err = fs.WalkDir(root, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// Rename go.mod.tmpl → go.mod (and same for go.sum). The mirror
		// stores them under *.tmpl names so the outer module's
		// //go:embed doesn't refuse them as "in different module".
		outName := p
		if strings.HasSuffix(p, "/go.mod.tmpl") || p == "go.mod.tmpl" {
			outName = strings.TrimSuffix(p, ".tmpl")
		}
		if strings.HasSuffix(p, "/go.sum.tmpl") || p == "go.sum.tmpl" {
			outName = strings.TrimSuffix(p, ".tmpl")
		}
		target := filepath.Join(dst, outName)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		f, err := root.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		defer out.Close()
		if _, err := io.Copy(out, f); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		_ = os.RemoveAll(dst)
		return "", err
	}
	return dst, nil
}

// buildWorker shells out to `go build -tags freerdp -mod=vendor` inside
// the extracted source dir. Platform-aware env (PKG_CONFIG_PATH on
// macOS, PATH+CC for MinGW on Windows) is layered on top via buildEnv().
// The mod=vendor flag means no network access is needed at runtime —
// all deps were vendored when sync-workersrc ran.
func buildWorker(ctx context.Context, srcDir, outBin string, logger *zap.Logger) error {
	args := []string{"build", "-tags", "freerdp", "-mod=vendor",
		"-trimpath", "-o", outBin, "./cmd/freerdp-worker"}
	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Dir = srcDir
	env := append(os.Environ(), "CGO_ENABLED=1")
	if extra := buildEnv(); len(extra) > 0 {
		env = append(env, extra...)
	}
	cmd.Env = env
	logger.Info("compiling freerdp-worker",
		zap.Strings("argv", append([]string{"go"}, args...)),
		zap.Strings("extra_env", buildEnv()))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("go build: %w\n%s", err, string(out))
	}
	// chmod is a no-op on Windows (no execute bit). On Unix we make sure
	// the binary is +x even if the umask was restrictive.
	if runtime.GOOS != "windows" {
		if err := os.Chmod(outBin, 0o755); err != nil {
			return fmt.Errorf("chmod: %w", err)
		}
	}
	if info, err := os.Stat(outBin); err == nil {
		logger.Info("compile succeeded", zap.Int64("size_bytes", info.Size()))
	}
	return nil
}

// installBinary moves the freshly-built worker into a stable path. Tries
// the configured InstallPrefix first; falls back through a platform-
// specific path table until something writeable is found. Atomic via
// rename within the same filesystem; if cross-FS, falls back to copy +
// remove. On Windows we additionally handle in-use locks by renaming
// the old binary to a .old sidecar before placing the new one.
func (m *Manager) installBinary(srcBin string) (string, error) {
	for _, dst := range installCandidates(m.cfg.InstallPrefix) {
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			continue
		}
		// Windows-specific: if the destination exists and is in use,
		// rename it to .old first so the new binary takes its place.
		if runtime.GOOS == "windows" {
			if _, statErr := os.Stat(dst); statErr == nil {
				_ = os.Rename(dst, dst+".old")
			}
		}
		// Atomic rename — same FS only. If that fails, copy + remove.
		if err := os.Rename(srcBin, dst); err == nil {
			if runtime.GOOS != "windows" {
				_ = os.Chmod(dst, 0o755)
			}
			m.logger.Info("installed freerdp-worker", zap.String("path", dst))
			return dst, nil
		}
		if err := copyFile(srcBin, dst); err == nil {
			if runtime.GOOS != "windows" {
				_ = os.Chmod(dst, 0o755)
			}
			_ = os.Remove(srcBin)
			m.logger.Info("installed freerdp-worker (via copy)", zap.String("path", dst))
			return dst, nil
		}
	}
	return "", fmt.Errorf("could not install worker — all candidate paths unwriteable")
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".partial"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}
