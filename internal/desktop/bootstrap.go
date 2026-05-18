package desktop

import (
	"context"
	"errors"
	"runtime"
	"time"

	"go.uber.org/zap"
)

// EnsureWorker locates the freerdp-worker binary at startup. The build
// itself is no longer a runtime concern — operators run
// scripts/build-worker-{linux,darwin,windows}.{sh,ps1} ahead of time
// (see scripts/README.md). That script drops the binary at one of the
// paths candidateWorkerPaths() searches, and this function just picks
// up whichever it finds first.
//
// Returns nil even when the worker is missing so the gateway keeps
// running — classic RDP/VNC via Guacamole works without the worker;
// only the workspace-v2 "rdp_next" protocol needs it.
//
// Re-invocation is gated by bootstrapInFlight so two concurrent retries
// (POST /api/v1/desktop/bootstrap) don't race on workerPath updates.
func (m *Manager) EnsureWorker(ctx context.Context) error {
	if !m.bootstrapInFlight.CompareAndSwap(false, true) {
		return errors.New("bootstrap already in flight")
	}
	defer m.bootstrapInFlight.Store(false)

	m.logger.Info("locating desktop worker",
		zap.Bool("enabled", m.cfg.Enabled),
		zap.String("default_backend", m.cfg.DefaultBackend),
		zap.String("configured_worker_path", m.cfg.WorkerPath))

	if !m.cfg.Enabled {
		m.logger.Info("desktop subsystem disabled — set desktop.enabled=true to use rdp_next")
		m.recordBootstrap(nil)
		return nil
	}
	if m.cfg.DefaultBackend == "dummy" {
		m.logger.Info("default_backend=dummy — no native worker needed")
		m.workerReady.Store(true)
		m.recordBootstrap(nil)
		return nil
	}
	if m.cfg.AutoInstall {
		// Backward-compat: surface the deprecation once at startup; do
		// nothing else with the flag. The runtime install/compile path
		// was removed in favour of pre-built binaries.
		m.logger.Warn("desktop.auto_install is deprecated and has no effect — build the worker with scripts/build-worker-*.{sh,ps1}; remove the line from your config")
	}

	candidates := m.candidateWorkerPaths()
	for _, p := range candidates {
		if isExecutable(p) {
			m.logger.Info("freerdp-worker found", zap.String("path", p))
			m.cfg.WorkerPath = p
			m.workerPath.Store(p)
			m.workerReady.Store(true)
			m.recordBootstrap(nil)
			return nil
		}
	}

	hint := buildHintForGOOS()
	m.logger.Info("freerdp-worker not installed — workspace-v2 'rdp_next' protocol unavailable, classic Guacamole RDP/VNC unaffected",
		zap.Strings("searched", candidates),
		zap.String("how_to_build", hint),
		zap.String("retry_without_restart", "POST /api/v1/desktop/bootstrap"))
	m.recordBootstrap(errors.New("worker binary not found in any standard install path"))
	return nil
}

// recordBootstrap snapshots the outcome for /api/v1/desktop/stats so
// the UI can report worker state without reading server logs.
func (m *Manager) recordBootstrap(err error) {
	m.bootstrapAt.Store(time.Now())
	if err == nil {
		m.bootstrapErr.Store("")
	} else {
		m.bootstrapErr.Store(err.Error())
	}
}

// buildHintForGOOS returns the one-liner the operator should run to
// produce a worker binary on this OS.
func buildHintForGOOS() string {
	switch runtime.GOOS {
	case "linux", "freebsd":
		return "bash scripts/build-worker-linux.sh"
	case "darwin":
		return "bash scripts/build-worker-darwin.sh"
	case "windows":
		return "powershell -ExecutionPolicy Bypass -File scripts/build-worker-windows.ps1"
	default:
		return "see scripts/README.md"
	}
}

// candidateWorkerPaths wraps the package-level helper in bootstrap_paths.go
// to forward the operator-configured path as the highest-priority entry.
func (m *Manager) candidateWorkerPaths() []string {
	return candidateWorkerPaths(m.cfg.WorkerPath)
}
