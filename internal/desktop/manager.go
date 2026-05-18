package desktop

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"go.uber.org/zap"
)

// Manager orchestrates Plan 17 desktop sessions: validates auth, picks a
// worker backend, spawns it, and hands the WS handler a Session it can
// drive end-to-end.
type Manager struct {
	cfg      config.DesktopConfig
	logger   *zap.Logger
	nodes    *repo.NodeRepo
	creds    *repo.CredentialRepo
	asset    *asset.Resolver
	sealer   PasswordOpener
	audit    *audit.Writer
	sessions *repo.SessionRepo

	mu      sync.Mutex
	live    map[string]*Session // sessionID → Session
	maxLive int
	created atomic.Int64
	// Plan 18 — true once EnsureWorker has either found or built the
	// worker binary. Sessions started before this flips get a 503.
	workerReady atomic.Bool
	// Plan 19.5 — bootstrap state surfaced via /desktop/stats so the
	// operator can debug "why isn't auto_install running?" without
	// grepping logs. All three are accessed via atomic.Value to keep
	// reader paths lock-free.
	bootstrapErr     atomic.Value // string — empty when no error
	bootstrapAt      atomic.Value // time.Time — last bootstrap attempt finish
	bootstrapInFlight atomic.Bool
	// Resolved path to the worker binary, populated by EnsureWorker.
	// Mirrored back into m.cfg.WorkerPath for backwards compat but
	// exposed here so /desktop/stats can show the resolved path even
	// when the operator left worker_path blank.
	workerPath atomic.Value // string
}

// PasswordOpener is the subset of pkgcrypto.Sealer we need (decrypt one blob).
type PasswordOpener interface {
	Open(secret []byte) ([]byte, error)
}

type Deps struct {
	Logger   *zap.Logger
	Nodes    *repo.NodeRepo
	Creds    *repo.CredentialRepo
	Asset    *asset.Resolver
	Sealer   PasswordOpener
	Audit    *audit.Writer
	Sessions *repo.SessionRepo
}

func NewManager(cfg config.DesktopConfig, deps Deps) *Manager {
	max := cfg.MaxConcurrentSessions
	if max <= 0 {
		max = 64
	}
	return &Manager{
		cfg:      cfg,
		logger:   deps.Logger,
		nodes:    deps.Nodes,
		creds:    deps.Creds,
		asset:    deps.Asset,
		sealer:   deps.Sealer,
		audit:    deps.Audit,
		sessions: deps.Sessions,
		live:     map[string]*Session{},
		maxLive:  max,
	}
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// StartSession handles the control-plane request. It performs auth, looks
// up node + credential, spawns the worker, registers the live Session.
// Returns the opaque session_id the browser uses to open the WS data
// channel.
func (m *Manager) StartSession(ctx context.Context, claims *auth.Claims, clientIP string, req StartSessionRequest) (*StartSessionResponse, error) {
	if !m.cfg.Enabled {
		return nil, errors.New("desktop subsystem disabled")
	}
	// Plan 18 — gate the freerdp backend on workerReady. The dummy
	// in-process backend is always available.
	backend := req.Backend
	if backend == "" {
		backend = m.cfg.DefaultBackend
	}
	if backend == "freerdp" && !m.workerReady.Load() {
		return nil, errors.New("desktop worker bootstrapping (libfreerdp + go build); retry in 30-90s")
	}
	m.mu.Lock()
	if len(m.live) >= m.maxLive {
		m.mu.Unlock()
		return nil, fmt.Errorf("too many desktop sessions (max %d)", m.maxLive)
	}
	m.mu.Unlock()

	// Authorise on the node.
	if m.asset != nil {
		ok, err := m.asset.Check(ctx, claims.UserID, req.NodeID, asset.ActionConnect)
		if err != nil {
			return nil, fmt.Errorf("asset check: %w", err)
		}
		if !ok {
			return nil, errors.New("not authorised on this node")
		}
	}
	node, err := m.nodes.FindByID(ctx, req.NodeID)
	if err != nil || node == nil {
		return nil, fmt.Errorf("node %d not found", req.NodeID)
	}
	if node.Disabled {
		return nil, errors.New("node disabled")
	}
	// Decode credential. RDP needs a password credential; we re-use the
	// same Sealer path the guacd handler uses (Plan 12 bridge.go).
	cred, err := m.creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		return nil, errors.New("credential lookup failed")
	}
	if cred.Kind != model.CredentialPassword {
		return nil, errors.New("desktop subsystem requires a password credential (V1)")
	}
	pw, err := m.sealer.Open(cred.Secret)
	if err != nil {
		return nil, fmt.Errorf("decrypt credential: %w", err)
	}

	// Pick worker backend. Bubble the typed error so the operator sees
	// "worker path not resolved" instead of an opaque crash.
	worker, err := m.pickWorker(req.Backend)
	if err != nil {
		return nil, fmt.Errorf("pick worker: %w", err)
	}

	// Prepare session bookkeeping. We mint our own UUID instead of relying
	// on worker; the session row table doesn't need to know which backend
	// is in use.
	sessionID := uuid.NewString()
	rdpOpts := ParseRdpOptions(node.ProtoOptions)
	// Pick a keyboard layout: explicit per-session request wins, then the
	// node-saved layout, then the worker's default ("us").
	keyboard := req.Keyboard
	if keyboard == "" {
		keyboard = rdpOpts.Keyboard
	}
	startParams := StartParams{
		NodeID:   req.NodeID,
		Host:     node.Host,
		Port:     node.Port,
		Username: pkgssh.PreferredUser(cred, node.Username),
		Password: string(pw),
		Domain:   rdpOpts.Domain,
		Width:    int(req.Width),
		Height:   int(req.Height),
		Keyboard: keyboard,
		Quality:  req.Quality,
		RDP:      rdpOpts,
	}

	wctx, cancel := context.WithCancel(context.Background())
	if err := worker.Start(wctx, startParams); err != nil {
		cancel()
		return nil, fmt.Errorf("worker start: %w", err)
	}

	sess := &Session{
		ID:        sessionID,
		Worker:    worker,
		NodeID:    req.NodeID,
		UserID:    claims.UserID,
		Username:  claims.Username,
		ClientIP:  clientIP,
		StartedAt: time.Now(),
		cancel:    cancel,
		manager:   m,
	}
	m.register(sess)
	m.recordStart(ctx, sess, node)

	return &StartSessionResponse{
		SessionID:    sessionID,
		RemoteWidth:  req.Width,
		RemoteHeight: req.Height,
	}, nil
}

func (m *Manager) pickWorker(backend string) (DesktopWorker, error) {
	if backend == "" {
		backend = m.cfg.DefaultBackend
	}
	switch backend {
	case "dummy":
		return NewDummyWorker(m.logger), nil
	case "freerdp":
		path, _ := m.workerPath.Load().(string)
		if path == "" {
			return nil, errors.New("freerdp worker path not resolved; check /desktop/stats and ensure bootstrap completed")
		}
		return NewFreeRDPWorker(m.logger, path, WithDebugLog(m.cfg.DebugLog)), nil
	default:
		return nil, fmt.Errorf("unknown desktop backend %q (supported: freerdp, dummy)", backend)
	}
}

// BootstrapStatus snapshots the current worker / bootstrap state. Used by
// the /desktop/stats handler so operators can debug auto_install without
// digging through logs.
type BootstrapStatus struct {
	Enabled        bool      `json:"enabled"`
	Backend        string    `json:"default_backend"`
	WorkerReady    bool      `json:"worker_ready"`
	WorkerPath     string    `json:"worker_path"`
	AutoInstall    bool      `json:"auto_install"`
	InFlight       bool      `json:"bootstrap_in_flight"`
	LastError      string    `json:"last_bootstrap_error,omitempty"`
	LastAttemptAt  time.Time `json:"last_bootstrap_at,omitempty"`
}

func (m *Manager) BootstrapStatus() BootstrapStatus {
	path, _ := m.workerPath.Load().(string)
	lastErr, _ := m.bootstrapErr.Load().(string)
	lastAt, _ := m.bootstrapAt.Load().(time.Time)
	return BootstrapStatus{
		Enabled:       m.cfg.Enabled,
		Backend:       m.cfg.DefaultBackend,
		WorkerReady:   m.workerReady.Load(),
		WorkerPath:    path,
		AutoInstall:   m.cfg.AutoInstall,
		InFlight:      m.bootstrapInFlight.Load(),
		LastError:     lastErr,
		LastAttemptAt: lastAt,
	}
}

func (m *Manager) register(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.live[s.ID] = s
	m.created.Add(1)
}

func (m *Manager) Take(sessionID string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.live[sessionID]
	if !ok {
		return nil
	}
	return s
}

func (m *Manager) End(ctx context.Context, sessionID string) error {
	m.mu.Lock()
	s, ok := m.live[sessionID]
	if !ok {
		m.mu.Unlock()
		return errors.New("session not found")
	}
	delete(m.live, sessionID)
	m.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	if err := s.Worker.Close(); err != nil {
		m.logger.Warn("worker close", zap.String("session", sessionID), zap.Error(err))
	}
	m.recordEnd(ctx, s, nil)
	return nil
}

// Stats for ops visibility.
func (m *Manager) Stats() (live int, total int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.live), m.created.Load()
}

// recordStart writes session + audit rows so existing /sessions list +
// audit_logs queries pick up the new desktop sessions automatically.
func (m *Manager) recordStart(ctx context.Context, s *Session, node *model.Node) {
	if m.sessions == nil || m.audit == nil {
		return
	}
	row := &model.Session{
		ID:        s.ID,
		Kind:      model.SessionGraphical,
		UserID:    s.UserID,
		Username:  s.Username,
		ClientIP:  s.ClientIP,
		StartedAt: s.StartedAt,
		Status:    model.SessionActive,
	}
	if node != nil {
		nid := node.ID
		row.NodeID = &nid
		row.NodeName = node.Name
	}
	if err := m.sessions.Create(ctx, row); err != nil {
		m.logger.Warn("desktop session create failed", zap.Error(err))
	}
	s.sessionRow = row
	m.audit.Log(model.AuditLog{
		Kind:      model.AuditGraphicalStart,
		UserID:    s.UserID,
		Username:  s.Username,
		SessionID: s.ID,
		NodeID:    row.NodeID,
		ClientIP:  s.ClientIP,
		Payload:   "desktop-v2",
	})
}

func (m *Manager) recordEnd(ctx context.Context, s *Session, runErr error) {
	if m.sessions == nil || m.audit == nil || s.sessionRow == nil {
		return
	}
	end := time.Now()
	s.sessionRow.EndedAt = &end
	if runErr != nil {
		s.sessionRow.Status = model.SessionErrored
		s.sessionRow.Reason = runErr.Error()
	} else {
		s.sessionRow.Status = model.SessionClosed
	}
	if err := m.sessions.Update(ctx, s.sessionRow); err != nil {
		m.logger.Warn("desktop session update failed", zap.Error(err))
	}
	m.audit.Log(model.AuditLog{
		Kind:      model.AuditSessionEnd,
		UserID:    s.UserID,
		Username:  s.Username,
		SessionID: s.ID,
		NodeID:    s.sessionRow.NodeID,
		ClientIP:  s.ClientIP,
	})
}
