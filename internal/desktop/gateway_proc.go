package desktop

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// GatewaySupervisor owns the Devolutions Gateway subprocess lifecycle.
// The binary is installed once (either pre-deployed by the operator or
// fetched by the install script) and supervised for as long as our
// gateway is up: spawn → health-check → restart-on-crash → stop on
// shutdown. The browser connects directly to the WebSocket endpoint
// the subprocess exposes; we only relay JWTs.
//
// Restart policy is deliberately bounded (RestartBackoffMax). If
// Devolutions Gateway is wedging on every start the operator wants a
// loud failure surfaced via /desktop/stats, not an invisible retry
// storm chewing CPU.
type GatewaySupervisor struct {
	logger   *zap.Logger
	cfg      DevolutionsGatewayRuntime
	signer   *JWTSigner

	mu       sync.Mutex
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	stopped  chan struct{}

	ready    atomic.Bool
	lastErr  atomic.Value // string
	lastAt   atomic.Value // time.Time
	pid      atomic.Int32
}

// DevolutionsGatewayRuntime is the fully-resolved configuration the
// supervisor needs. It's derived from config.DesktopConfig + sane
// defaults applied in NewGatewaySupervisor; callers should not mutate
// it after handing it to the supervisor.
type DevolutionsGatewayRuntime struct {
	Enabled       bool
	BinaryPath    string        // absolute path to devolutions-gateway[.exe]
	ConfigPath    string        // where we write the gateway's JSON config
	IDFile        string        // sidecar holding the gateway's persistent Id
	ListenURL     string        // e.g. http://127.0.0.1:7171
	AdvertisedURL string        // e.g. ws://localhost:7171/jet/rdp (passed to browser)
	HealthTimeout time.Duration // how long to wait for /jet/health after spawn
	Verbosity     string        // gateway log verbosity (warn/info/debug)
	AutoStart     bool          // false = manage config but operator runs the binary
}

// NewGatewaySupervisor wires the supervisor without starting the
// subprocess. Call Ensure(ctx) to bring it up.
func NewGatewaySupervisor(logger *zap.Logger, cfg DevolutionsGatewayRuntime, signer *JWTSigner) *GatewaySupervisor {
	if cfg.HealthTimeout == 0 {
		cfg.HealthTimeout = 15 * time.Second
	}
	return &GatewaySupervisor{
		logger:  logger,
		cfg:     cfg,
		signer:  signer,
		stopped: make(chan struct{}),
	}
}

// Ensure makes sure the Devolutions Gateway is running and healthy.
// Safe to call once at startup; the supervisor goroutine takes over
// the lifecycle until Stop() is called.
//
//   1. Validate BinaryPath exists. If it does not, return a descriptive
//      error — the install script should have produced it. We refuse
//      to silently no-op since `default_backend: ironrdp` then has
//      nothing to point sessions at.
//   2. (Re)write the JSON config from current runtime values.
//   3. exec the subprocess, plumb stderr → zap.
//   4. Health-probe `<ListenURL>/jet/health` until 200 OK or timeout.
//   5. Hand the process off to the supervisor goroutine which restarts
//      on crash (bounded backoff).
func (s *GatewaySupervisor) Ensure(ctx context.Context) error {
	if !s.cfg.Enabled {
		s.recordErr("disabled")
		return errors.New("devolutions gateway disabled in config")
	}
	if s.signer == nil {
		return errors.New("devolutions gateway: missing jwt signer")
	}
	if s.cfg.BinaryPath == "" {
		return errors.New("devolutions gateway: binary path not configured")
	}
	if _, err := os.Stat(s.cfg.BinaryPath); err != nil {
		return fmt.Errorf("devolutions gateway: binary %s not found (run scripts/install-devolutions-gateway-*.{sh,ps1} first): %w", s.cfg.BinaryPath, err)
	}
	if err := writeGatewayConfig(gatewayConfigInputs{
		ConfigPath:    s.cfg.ConfigPath,
		PublicKeyPath: s.signer.PublicKeyPath(),
		ListenURL:     s.cfg.ListenURL,
		Hostname:      "jumpserver-anonymous",
		IDFile:        s.cfg.IDFile,
		Verbosity:     s.cfg.Verbosity,
	}); err != nil {
		s.recordErr(err.Error())
		return err
	}
	if !s.cfg.AutoStart {
		// Operator runs the binary themselves (e.g. systemd). We've
		// written the config; mark ready optimistically and let
		// session start fail loudly if the gateway isn't reachable.
		s.ready.Store(true)
		s.recordOK()
		return nil
	}
	if err := s.spawn(ctx); err != nil {
		s.recordErr(err.Error())
		return err
	}
	if err := s.waitHealthy(ctx); err != nil {
		s.stopProcess()
		s.recordErr(err.Error())
		return err
	}
	s.ready.Store(true)
	s.recordOK()
	go s.supervise(ctx)
	return nil
}

// AdvertisedURL is the WebSocket URL the browser uses to connect to the
// gateway. Falls back to deriving from ListenURL if not explicitly set.
func (s *GatewaySupervisor) AdvertisedURL() string {
	if s.cfg.AdvertisedURL != "" {
		return s.cfg.AdvertisedURL
	}
	if u, err := url.Parse(s.cfg.ListenURL); err == nil {
		scheme := "ws"
		if u.Scheme == "https" {
			scheme = "wss"
		}
		return fmt.Sprintf("%s://%s/jet/rdp", scheme, u.Host)
	}
	return ""
}

// Ready reports whether the supervisor believes the Devolutions Gateway
// is currently healthy. Sessions use this as a gate before minting a
// JWT — no point handing the browser a token if the gateway isn't there.
func (s *GatewaySupervisor) Ready() bool { return s.ready.Load() }

// Stop signals the subprocess to shut down and waits up to 5s. Idempotent.
func (s *GatewaySupervisor) Stop() error {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.mu.Unlock()
	s.stopProcess()
	s.ready.Store(false)
	return nil
}

// Snapshot returns a copy of the current supervisor state for /desktop/stats.
func (s *GatewaySupervisor) Snapshot() GatewayStatus {
	lastErr, _ := s.lastErr.Load().(string)
	lastAt, _ := s.lastAt.Load().(time.Time)
	return GatewayStatus{
		Enabled:       s.cfg.Enabled,
		BinaryPath:    s.cfg.BinaryPath,
		ConfigPath:    s.cfg.ConfigPath,
		ListenURL:     s.cfg.ListenURL,
		AdvertisedURL: s.AdvertisedURL(),
		Ready:         s.ready.Load(),
		PID:           int(s.pid.Load()),
		LastError:     lastErr,
		LastUpdateAt:  lastAt,
	}
}

// GatewayStatus is a JSON-friendly snapshot of the supervisor used by
// /desktop/stats to surface health to operators.
type GatewayStatus struct {
	Enabled       bool      `json:"enabled"`
	BinaryPath    string    `json:"binary_path"`
	ConfigPath    string    `json:"config_path"`
	ListenURL     string    `json:"listen_url"`
	AdvertisedURL string    `json:"advertised_url"`
	Ready         bool      `json:"ready"`
	PID           int       `json:"pid"`
	LastError     string    `json:"last_error,omitempty"`
	LastUpdateAt  time.Time `json:"last_update_at,omitempty"`
}

// --- private ---

func (s *GatewaySupervisor) spawn(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil {
		return errors.New("devolutions gateway already running")
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	// `--config-path` is a *directory*, not the JSON file itself. The
	// gateway appends `gateway.json` internally and also writes peer
	// state (boot.stacktrace, recordings, etc.) alongside. PR-A
	// originally passed the .json file path here, causing the gateway
	// to try `<file>\gateway.json\gateway.json` on Windows and fail
	// with "os error 3 — system cannot find the path". Pass the
	// directory containing our generated gateway.json.
	configDir := filepath.Dir(s.cfg.ConfigPath)
	cmd := exec.CommandContext(runCtx, s.cfg.BinaryPath, "--config-path", configDir)
	// Hide the gateway binary's stdin so it doesn't compete for the TTY.
	cmd.Stdin = nil
	// Capture stderr and stdout to forward to our zap logger; the
	// gateway is otherwise silent.
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("devolutions gateway: stderr pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("devolutions gateway: stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("devolutions gateway: start %s: %w", s.cfg.BinaryPath, err)
	}
	s.cmd = cmd
	if cmd.Process != nil {
		s.pid.Store(int32(cmd.Process.Pid))
	}
	go s.forwardLog("stderr", stderr)
	go s.forwardLog("stdout", stdout)
	return nil
}

func (s *GatewaySupervisor) waitHealthy(ctx context.Context) error {
	deadline := time.Now().Add(s.cfg.HealthTimeout)
	healthURL := strings.TrimRight(s.cfg.ListenURL, "/") + "/jet/health"
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		if err == nil {
			resp, herr := client.Do(req)
			if herr == nil {
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 400 {
					s.logger.Info("devolutions gateway healthy",
						zap.String("listen_url", s.cfg.ListenURL),
						zap.Int("pid", int(s.pid.Load())))
					return nil
				}
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("devolutions gateway: health %s timed out after %s", healthURL, s.cfg.HealthTimeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *GatewaySupervisor) supervise(ctx context.Context) {
	const maxBackoff = 30 * time.Second
	backoff := time.Second
	for {
		err := s.waitProcess()
		s.ready.Store(false)
		s.pid.Store(0)
		if ctx.Err() != nil {
			close(s.stopped)
			return
		}
		s.logger.Warn("devolutions gateway exited; restarting", zap.Error(err))
		select {
		case <-ctx.Done():
			close(s.stopped)
			return
		case <-time.After(backoff):
		}
		if respawnErr := s.spawn(ctx); respawnErr != nil {
			s.logger.Warn("devolutions gateway respawn failed", zap.Error(respawnErr))
			s.recordErr(respawnErr.Error())
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}
		if healthErr := s.waitHealthy(ctx); healthErr != nil {
			s.logger.Warn("devolutions gateway health probe failed after respawn", zap.Error(healthErr))
			s.recordErr(healthErr.Error())
			s.stopProcess()
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}
		s.ready.Store(true)
		s.recordOK()
		backoff = time.Second
	}
}

func (s *GatewaySupervisor) waitProcess() error {
	s.mu.Lock()
	cmd := s.cmd
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return errors.New("not running")
	}
	return cmd.Wait()
}

func (s *GatewaySupervisor) stopProcess() {
	s.mu.Lock()
	cmd := s.cmd
	s.cmd = nil
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	if runtime.GOOS == "windows" {
		// Windows has no SIGTERM; send Kill directly. exec.Cmd's
		// context cancel will also fire Kill, but we want a chance
		// to clean up before that.
		_ = cmd.Process.Kill()
	} else {
		if err := cmd.Process.Signal(os.Interrupt); err != nil {
			_ = cmd.Process.Kill()
		}
	}
	done := make(chan struct{})
	go func() {
		_, _ = cmd.Process.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
	}
}

func (s *GatewaySupervisor) forwardLog(stream string, r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		s.logger.Info("devolutions gateway "+stream, zap.String("line", line))
	}
}

func (s *GatewaySupervisor) recordErr(msg string) {
	s.lastErr.Store(msg)
	s.lastAt.Store(time.Now())
}

func (s *GatewaySupervisor) recordOK() {
	s.lastErr.Store("")
	s.lastAt.Store(time.Now())
}

// DefaultBinaryPath returns the platform-appropriate place the install
// script drops the Devolutions Gateway binary. Used as a fallback when
// the operator left binary_path empty in YAML.
func DefaultBinaryPath(installPrefix string) string {
	if installPrefix == "" {
		installPrefix = "."
	}
	name := "devolutions-gateway"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(installPrefix, name)
}
