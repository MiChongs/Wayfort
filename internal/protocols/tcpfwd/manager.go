package tcpfwd

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/cache"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
	"golang.org/x/net/proxy"
)

// Manager owns the lifecycle of every active gateway-side TCP forwarder.
type Manager struct {
	cfg     config.TCPFwdConfig
	repo    *repo.PortForwardRepo
	cache   *cache.Cache
	audit   *audit.Writer
	logger  *zap.Logger
	makeDialer DialerFactory

	mu      sync.Mutex
	entries map[string]*entry
}

// DialerFactory builds the ContextDialer for a node — typically wrapping the
// gateway's chain.Build call. Each new forwarder gets a fresh dialer + release.
type DialerFactory func(ctx context.Context, node *model.Node) (target string, dialer proxy.ContextDialer, release func(), err error)

type entry struct {
	row       *model.PortForward
	forwarder *Forwarder
	release   func()
	expiresAt time.Time
}

func NewManager(cfg config.TCPFwdConfig, r *repo.PortForwardRepo, c *cache.Cache, aud *audit.Writer, logger *zap.Logger, df DialerFactory) *Manager {
	return &Manager{
		cfg: cfg, repo: r, cache: c, audit: aud, logger: logger,
		makeDialer: df, entries: map[string]*entry{},
	}
}

// SnapshotEntry is a point-in-time view of one active forwarder, returned by
// ListForUser. Stable across releases — used by callers outside this package.
type SnapshotEntry struct {
	ID         string
	NodeID     uint64
	LocalHost  string
	LocalPort  int
	TargetHost string
	TargetPort int
	ExpiresAt  time.Time
	CreatedAt  time.Time
}

// ListForUser returns a snapshot of the active forwarders the user owns.
func (m *Manager) ListForUser(uid uint64) []SnapshotEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SnapshotEntry, 0)
	for _, e := range m.entries {
		if e.row.UserID != uid || e.row.Status != model.PortForwardActive {
			continue
		}
		out = append(out, SnapshotEntry{
			ID: e.row.ID, NodeID: e.row.NodeID,
			LocalHost: e.row.LocalHost, LocalPort: e.row.LocalPort,
			TargetHost: e.row.TargetHost, TargetPort: e.row.TargetPort,
			ExpiresAt: e.expiresAt, CreatedAt: e.row.CreatedAt,
		})
	}
	return out
}

// CountForUser returns how many active forwarders the user owns; used to
// enforce TCPFwdConfig.MaxPerUser.
func (m *Manager) CountForUser(uid uint64) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := 0
	for _, e := range m.entries {
		if e.row.UserID == uid && e.row.Status == model.PortForwardActive {
			c++
		}
	}
	return c
}

// Create launches a new forwarder and persists its row.
func (m *Manager) Create(ctx context.Context, userID uint64, username string, node *model.Node, ttl time.Duration) (*model.PortForward, error) {
	if !m.cfg.Enabled {
		return nil, errors.New("tcpfwd disabled")
	}
	if m.cfg.MaxPerUser > 0 && m.CountForUser(userID) >= m.cfg.MaxPerUser {
		return nil, fmt.Errorf("max %d port forwards per user", m.cfg.MaxPerUser)
	}
	if ttl <= 0 {
		ttl = m.cfg.DefaultTTL
	}
	target, dialer, release, err := m.makeDialer(ctx, node)
	if err != nil {
		return nil, err
	}
	listenHost := m.cfg.ListenHost
	if listenHost == "" {
		listenHost = "127.0.0.1"
	}
	fwd, err := Start(ctx, listenHost, m.cfg.PortRange, dialer, target, m.logger)
	if err != nil {
		release()
		return nil, err
	}
	id := newID()
	row := &model.PortForward{
		ID: id, UserID: userID, Username: username,
		NodeID: node.ID, LocalHost: listenHost, LocalPort: fwd.Addr().Port,
		TargetHost: node.Host, TargetPort: node.Port,
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(ttl),
		Status: model.PortForwardActive,
	}
	if err := m.repo.Create(ctx, row); err != nil {
		_ = fwd.Close()
		release()
		return nil, err
	}
	if m.cache != nil {
		_ = m.cache.TrackPortForward(ctx, id, ttl)
	}
	m.mu.Lock()
	m.entries[id] = &entry{row: row, forwarder: fwd, release: release, expiresAt: row.ExpiresAt}
	m.mu.Unlock()
	m.audit.Log(model.AuditLog{
		Kind: model.AuditPortForwardOpen, UserID: userID, Username: username,
		SessionID: id, NodeID: &node.ID,
		Payload: fmt.Sprintf("%s:%d -> %s:%d", listenHost, row.LocalPort, node.Host, node.Port),
	})
	return row, nil
}

// Close stops a forwarder by id.
func (m *Manager) Close(ctx context.Context, id string) error {
	m.mu.Lock()
	e, ok := m.entries[id]
	if !ok {
		m.mu.Unlock()
		return errors.New("not found")
	}
	delete(m.entries, id)
	m.mu.Unlock()
	_ = e.forwarder.Close()
	e.release()
	_ = m.repo.MarkClosed(ctx, id, e.forwarder.BytesIn.Load(), e.forwarder.BytesOut.Load())
	if m.cache != nil {
		_ = m.cache.UntrackPortForward(ctx, id)
	}
	m.audit.Log(model.AuditLog{
		Kind: model.AuditPortForwardClose, UserID: e.row.UserID, Username: e.row.Username,
		SessionID: id, NodeID: &e.row.NodeID,
	})
	return nil
}

// Run is the janitor loop: every 30s it closes forwarders whose ExpiresAt has
// passed. Blocks until ctx is canceled.
func (m *Manager) Run(ctx context.Context) error {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			m.shutdown()
			return ctx.Err()
		case <-t.C:
			m.sweep(ctx)
		}
	}
}

func (m *Manager) sweep(ctx context.Context) {
	now := time.Now()
	m.mu.Lock()
	expired := make([]string, 0)
	for id, e := range m.entries {
		if now.After(e.expiresAt) {
			expired = append(expired, id)
		}
	}
	m.mu.Unlock()
	for _, id := range expired {
		_ = m.Close(ctx, id)
	}
}

func (m *Manager) shutdown() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.entries))
	for id := range m.entries {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Close(context.Background(), id)
	}
}

func newID() string {
	// Use the first 16 hex chars of time + random; we don't need uuid here.
	return fmt.Sprintf("pf-%016x", time.Now().UnixNano())
}
