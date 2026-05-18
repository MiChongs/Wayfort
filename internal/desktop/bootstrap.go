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

// ErrToolchainUnavailable is the typed error returned when the host
// genuinely can't build the native FreeRDP worker (e.g. Windows without
// MSYS2/vcpkg). It tells EnsureWorker this isn't an operator error worth
// surfacing as ERROR — the gateway is fully functional via Guacamole's
// RDP/VNC path; only the new "rdp_next" desktop protocol is unavailable.
var ErrToolchainUnavailable = errors.New("native FreeRDP worker unavailable: build toolchain missing on this host")

// ErrEmbedIncomplete is the typed error returned when the embedded
// _workersrc/ mirror inside this binary is missing files the worker
// build needs. This is a release-process bug (whoever built this binary
// forgot to run scripts/sync-workersrc.sh), not an operator one — config
// changes can't help. EnsureWorker surfaces it at WARN so the startup
// log is clear about who needs to act.
var ErrEmbedIncomplete = errors.New("embedded worker source mirror is incomplete")

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
//
// Every decision point logs at INFO so the operator never has to guess
// why auto_install did or didn't run. Failure state is also captured on
// the Manager and surfaced through /desktop/stats.
func (m *Manager) EnsureWorker(ctx context.Context) error {
	// Make sure repeated invocations (POST /desktop/bootstrap retry) don't
	// overlap and stomp each other's WorkerPath updates.
	if !m.bootstrapInFlight.CompareAndSwap(false, true) {
		return errors.New("bootstrap already in flight")
	}
	defer m.bootstrapInFlight.Store(false)

	m.logger.Info("ensuring desktop worker availability",
		zap.Bool("enabled", m.cfg.Enabled),
		zap.String("default_backend", m.cfg.DefaultBackend),
		zap.String("configured_worker_path", m.cfg.WorkerPath),
		zap.Bool("auto_install", m.cfg.AutoInstall),
		zap.String("install_prefix", m.cfg.InstallPrefix))

	if !m.cfg.Enabled {
		m.logger.Info("desktop subsystem disabled — skipping bootstrap (set desktop.enabled=true)")
		m.recordBootstrap(nil)
		return nil
	}
	if m.cfg.DefaultBackend == "dummy" {
		// The in-process dummy worker never needs a binary. Mark ready
		// so session starts proceed.
		m.logger.Info("default_backend=dummy — skipping freerdp bootstrap (no native worker needed)")
		m.workerReady.Store(true)
		m.recordBootstrap(nil)
		return nil
	}

	// 1. Short-circuit when an existing binary is found.
	candidates := m.candidateWorkerPaths()
	m.logger.Info("searching for existing worker binary",
		zap.Strings("candidates", candidates))
	for _, p := range candidates {
		if isExecutable(p) {
			m.logger.Info("desktop worker found — skipping bootstrap", zap.String("path", p))
			m.cfg.WorkerPath = p
			m.workerPath.Store(p)
			m.workerReady.Store(true)
			m.recordBootstrap(nil)
			return nil
		}
	}

	if !m.cfg.AutoInstall {
		err := errors.New("desktop worker not found and auto_install disabled")
		m.logger.Warn("desktop worker missing and auto_install is disabled",
			zap.String("configured_path", m.cfg.WorkerPath),
			zap.Strings("searched", candidates),
			zap.String("hint", "set desktop.auto_install=true OR install libfreerdp+go and pre-build the worker"))
		m.recordBootstrap(err)
		return nil
	}

	m.logger.Info("desktop worker not found — starting bootstrap (this can take 30-90s)",
		zap.Strings("searched", candidates))
	startedAt := time.Now()
	if err := m.runBootstrap(ctx); err != nil {
		switch {
		case errors.Is(err, ErrToolchainUnavailable):
			// Expected, non-actionable on this host. Log a single INFO
			// line (zap won't attach a stack trace at this level) so the
			// startup log stays clean. The classic Guacamole RDP/VNC
			// path is unaffected; only "rdp_next" protocol is offline.
			m.logger.Info("native FreeRDP worker disabled on this host — classic RDP/VNC via Guacamole continue to work",
				zap.String("reason", err.Error()),
				zap.Duration("elapsed", time.Since(startedAt)),
				zap.String("how_to_enable_windows", "install MSYS2 from https://www.msys2.org/ then in an MSYS2 shell: pacman -S mingw-w64-x86_64-freerdp mingw-w64-x86_64-pkgconf mingw-w64-x86_64-gcc mingw-w64-x86_64-go"),
				zap.String("retry", "POST /api/v1/desktop/bootstrap after installing the toolchain"))
		case errors.Is(err, ErrEmbedIncomplete):
			// Release-process bug — this binary was built without a
			// freshly-synced _workersrc/ mirror. Operator can't fix it
			// via config or environment. Log WARN with a clear pointer
			// to who needs to act, and what they need to do.
			m.logger.Warn("embedded worker source mirror is incomplete — this binary was built without a current _workersrc/ snapshot",
				zap.String("reason", err.Error()),
				zap.Duration("elapsed", time.Since(startedAt)),
				zap.String("how_to_fix", "from the source tree: bash scripts/sync-workersrc.sh, commit the resulting internal/desktop/_workersrc/ changes, rebuild the gateway"),
				zap.String("impact", "native FreeRDP worker won't build on this gateway; classic RDP/VNC via Guacamole continue to work"))
		default:
			m.logger.Error("desktop worker bootstrap failed", zap.Error(err),
				zap.Duration("elapsed", time.Since(startedAt)),
				zap.String("hint", "fix the reported issue, then POST /api/v1/desktop/bootstrap to retry without restart"))
		}
		m.recordBootstrap(err)
		// Don't return the error — we want the gateway to keep running.
		return nil
	}
	m.workerReady.Store(true)
	m.workerPath.Store(m.cfg.WorkerPath)
	m.logger.Info("desktop worker bootstrap complete",
		zap.String("path", m.cfg.WorkerPath),
		zap.Duration("elapsed", time.Since(startedAt)))
	m.recordBootstrap(nil)
	return nil
}

// recordBootstrap snapshots the bootstrap outcome on the Manager so
// /desktop/stats can report it. Always sets bootstrapAt; bootstrapErr is
// the empty string on success.
func (m *Manager) recordBootstrap(err error) {
	m.bootstrapAt.Store(time.Now())
	if err == nil {
		m.bootstrapErr.Store("")
	} else {
		m.bootstrapErr.Store(err.Error())
	}
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

	// 2. If the toolchain is already usable, skip the install step
	//    entirely. This is the common case on hosts where the operator
	//    pre-installed deps (manually or through a previous bootstrap),
	//    and on Windows where the user may have set up MSYS2 with a
	//    sub-environment (ucrt64 / mingw64 / clang64) we now probe.
	if err := verifyBuildToolchain(ctx); err == nil {
		m.logger.Info("toolchain already present — skipping package install")
	} else if len(plan.Cmds) > 0 {
		// 3. Install build deps. Best-effort: a partial failure still
		//    runs the verify below, since some hosts have the binaries
		//    we need from a different source.
		m.logger.Info("installing system packages", zap.String("hint", plan.HumanInstall))
		for _, c := range plan.Cmds {
			if out, err := runInstallCmd(ctx, c); err != nil {
				m.logger.Warn("package manager invocation failed",
					zap.Strings("cmd", c.Argv),
					zap.String("output", truncate(string(out), 400)),
					zap.Error(err))
			}
		}
	} else if plan.Reason != "" {
		// No install plan for this platform and the toolchain isn't
		// available. Surface as the typed error so EnsureWorker logs
		// INFO rather than ERROR.
		return fmt.Errorf("%w (probe: %v); install hint:\n%s",
			ErrToolchainUnavailable, err, plan.HumanInstall)
	}

	// 4. Re-verify after the install attempt. On Windows we treat a
	//    miss as ErrToolchainUnavailable so the startup log stays clean
	//    (the gateway keeps working through the Guacamole RDP path);
	//    on Linux/macOS this means the install step failed silently and
	//    the operator needs to investigate.
	if err := verifyBuildToolchain(ctx); err != nil {
		if runtime.GOOS == "windows" {
			return fmt.Errorf("%w (probe: %v); install hint:\n%s",
				ErrToolchainUnavailable, err, plan.HumanInstall)
		}
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
//
// On Windows we additionally probe MSYS2's standard install paths
// (C:\msys64\mingw64\bin etc.) because operators frequently install
// MSYS2 without appending its bin dir to %PATH%. Tools resolved here are
// passed back to the build step via buildEnv() so the augmented PATH is
// applied consistently.
func verifyBuildToolchain(ctx context.Context) error {
	extra := pathDirsFromBuildEnv()
	if _, err := lookToolPath("go", extra); err != nil {
		return errors.New("go toolchain not found in PATH")
	}
	goExe, _ := lookToolPath("go", extra)
	if out, err := exec.CommandContext(ctx, goExe, "version").CombinedOutput(); err != nil {
		return fmt.Errorf("go version: %w (%s)", err, string(out))
	} else {
		ver := string(out)
		if !atLeastGo(ver, 1, 22) {
			return fmt.Errorf("go ≥1.22 required, got: %s", strings.TrimSpace(ver))
		}
	}
	if _, err := lookToolPath("gcc", extra); err != nil {
		// cc symlink works too on some distros (clang→cc, etc.).
		if _, err2 := lookToolPath("cc", extra); err2 != nil {
			return errors.New("C compiler (gcc/cc) not found")
		}
	}
	pkgConfig, err := lookToolPath("pkg-config", extra)
	if err != nil {
		return errors.New("pkg-config not found")
	}
	// On Windows, pkg-config can't read PKG_CONFIG_PATH unless we pass it
	// in the child's env. buildEnv() already constructs the right value;
	// reuse it so the verify probe sees the same .pc files the build will.
	cmd := exec.CommandContext(ctx, pkgConfig, "--exists", "freerdp3")
	cmd.Env = append(os.Environ(), buildEnv()...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("pkg-config can't find freerdp3 (%s)", string(out))
	}
	return nil
}

// lookToolPath finds `name` in normal PATH first, then in extra dirs.
// On Windows tries `name` and `name.exe`. Returns the resolved absolute
// path or an error.
func lookToolPath(name string, extraDirs []string) (string, error) {
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	candidates := []string{name}
	if runtime.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(name), ".exe") {
		candidates = append(candidates, name+".exe")
	}
	for _, dir := range extraDirs {
		for _, c := range candidates {
			full := filepath.Join(dir, c)
			info, err := os.Stat(full)
			if err != nil || info.IsDir() {
				continue
			}
			return full, nil
		}
	}
	return "", fmt.Errorf("%s not found", name)
}

// pathDirsFromBuildEnv extracts the dirs that buildEnv() prepends to
// PATH (MSYS2's mingw64/bin on Windows, brew prefix's bin on macOS).
// Returned in the order they appear; empty on Linux where defaults are
// already enough.
func pathDirsFromBuildEnv() []string {
	sep := string(os.PathListSeparator)
	for _, kv := range buildEnv() {
		if !strings.HasPrefix(kv, "PATH=") {
			continue
		}
		val := strings.TrimPrefix(kv, "PATH=")
		// buildEnv() prepends new dirs to the existing PATH, so we want
		// the ones that come before the original PATH. Easiest: split
		// and dedupe vs. the existing PATH entries.
		existing := map[string]struct{}{}
		for _, d := range strings.Split(os.Getenv("PATH"), sep) {
			if d != "" {
				existing[d] = struct{}{}
			}
		}
		var extra []string
		for _, d := range strings.Split(val, sep) {
			if d == "" {
				continue
			}
			if _, was := existing[d]; was {
				continue
			}
			extra = append(extra, d)
		}
		return extra
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
