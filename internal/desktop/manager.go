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

	mu       sync.Mutex
	live     map[string]*Session // sessionID → Session
	maxLive  int
	created  atomic.Int64
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

	// Pick worker backend.
	worker := m.pickWorker(req.Backend)

	// Prepare session bookkeeping. We mint our own UUID instead of relying
	// on worker; the session row table doesn't need to know which backend
	// is in use.
	sessionID := uuid.NewString()
	startParams := StartParams{
		NodeID:   req.NodeID,
		Host:     node.Host,
		Port:     node.Port,
		Username: pkgssh.PreferredUser(cred, node.Username),
		Password: string(pw),
		Width:    int(req.Width),
		Height:   int(req.Height),
		Keyboard: req.Keyboard,
		Quality:  req.Quality,
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

func (m *Manager) pickWorker(backend string) DesktopWorker {
	if backend == "dummy" {
		return NewDummyWorker(m.logger)
	}
	if backend == "" {
		backend = m.cfg.DefaultBackend
	}
	switch backend {
	case "freerdp":
		if m.cfg.WorkerPath == "" {
			m.logger.Warn("freerdp worker path not configured — falling back to dummy")
			return NewDummyWorker(m.logger)
		}
		return NewFreeRDPWorker(m.logger, m.cfg.WorkerPath)
	default:
		// In M1 we default to dummy if not explicitly freerdp, so the
		// pipeline is testable without libfreerdp.
		return NewDummyWorker(m.logger)
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
