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
	cfg        config.TCPFwdConfig
	repo       *repo.PortForwardRepo
	nodes      *repo.NodeRepo
	cache      *cache.Cache
	audit      *audit.Writer
	logger     *zap.Logger
	makeDialer DialerFactory
	bus        *EventBus

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

func NewManager(cfg config.TCPFwdConfig, r *repo.PortForwardRepo, nodes *repo.NodeRepo, c *cache.Cache, aud *audit.Writer, logger *zap.Logger, df DialerFactory) *Manager {
	return &Manager{
		cfg: cfg, repo: r, nodes: nodes, cache: c, audit: aud, logger: logger,
		makeDialer: df, entries: map[string]*entry{},
		bus: NewEventBus(),
	}
}

// Bus exposes the per-Manager event fanout. The WS endpoint subscribes here
// to forward events to browsers.
func (m *Manager) Bus() *EventBus { return m.bus }

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

// CreateOpts captures the user-supplied metadata for a new forwarder.
type CreateOpts struct {
	TTL    time.Duration
	Label  string
	Tags   []string
	Pinned bool
}

// Create launches a new forwarder and persists its row.
func (m *Manager) Create(ctx context.Context, userID uint64, username string, node *model.Node, opts CreateOpts) (*model.PortForward, error) {
	if !m.cfg.Enabled {
		return nil, errors.New("tcpfwd disabled")
	}
	if m.cfg.MaxPerUser > 0 && m.CountForUser(userID) >= m.cfg.MaxPerUser {
		return nil, fmt.Errorf("max %d port forwards per user", m.cfg.MaxPerUser)
	}
	ttl := opts.TTL
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
	id := newID()
	fwd, err := Start(ctx, StartOpts{
		ID:        id,
		UserID:    userID,
		Host:      listenHost,
		PortRange: m.cfg.PortRange,
		Dialer:    dialer,
		Target:    target,
		Logger:    m.logger,
		Bus:       m.bus,
	})
	if err != nil {
		release()
		return nil, err
	}
	now := time.Now()
	expires := now.Add(ttl)
	tags := model.StringSlice(append([]string(nil), opts.Tags...))
	row := &model.PortForward{
		ID: id, UserID: userID, Username: username,
		NodeID: node.ID, LocalHost: listenHost, LocalPort: fwd.Addr().Port,
		TargetHost: node.Host, TargetPort: node.Port,
		CreatedAt: now, ExpiresAt: expires,
		Status: model.PortForwardActive,
		Label:  opts.Label,
		Tags:   tags,
		Pinned: opts.Pinned,
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

// UpdateMeta lets the owner rename / tag / pin a forwarder after creation.
// Returns the post-update row. Empty Tags slice clears the column; passing
// a nil slice (i.e. omitting Tags from the request) leaves it unchanged —
// the caller is expected to populate `apply` accordingly.
type UpdateMeta struct {
	Label  *string
	Tags   *[]string
	Pinned *bool
}

func (m *Manager) UpdateMeta(ctx context.Context, userID uint64, id string, meta UpdateMeta) (*model.PortForward, error) {
	m.mu.Lock()
	e, ok := m.entries[id]
	m.mu.Unlock()
	if !ok {
		// Allow editing rows that are no longer active (e.g. expired).
		row, ferr := m.repo.FindByID(ctx, id)
		if ferr != nil || row == nil {
			return nil, errors.New("not found")
		}
		if row.UserID != userID {
			return nil, errors.New("forbidden")
		}
		applyMeta(row, meta)
		if err := m.repo.Update(ctx, row); err != nil {
			return nil, err
		}
		return row, nil
	}
	if e.row.UserID != userID {
		return nil, errors.New("forbidden")
	}
	applyMeta(e.row, meta)
	if err := m.repo.Update(ctx, e.row); err != nil {
		return nil, err
	}
	m.bus.Publish(Event{Type: EventMetadata, ForwardID: id, UserID: userID})
	return e.row, nil
}

func applyMeta(row *model.PortForward, m UpdateMeta) {
	if m.Label != nil {
		row.Label = *m.Label
	}
	if m.Tags != nil {
		row.Tags = model.StringSlice(append([]string(nil), (*m.Tags)...))
	}
	if m.Pinned != nil {
		row.Pinned = *m.Pinned
	}
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

// Resume rehydrates active forwarders from the database on startup. Each
// row whose ExpiresAt is still in the future is reopened on the same
// listen host:port; rows whose port is now occupied are marked
// PortForwardPortUnavailable so the operator can see the discrepancy in
// the list view. Returns the count of successfully resumed entries.
func (m *Manager) Resume(ctx context.Context) (int, error) {
	if !m.cfg.Enabled {
		return 0, nil
	}
	rows, err := m.repo.ListActive(ctx, 0)
	if err != nil {
		return 0, err
	}
	resumed := 0
	now := time.Now()
	for i := range rows {
		row := rows[i]
		if !row.ExpiresAt.After(now) {
			_ = m.repo.MarkExpired(ctx, row.ID)
			continue
		}
		if m.nodes == nil {
			break
		}
		node, ferr := m.nodes.FindByID(ctx, row.NodeID)
		if ferr != nil || node == nil {
			m.logger.Warn("tcpfwd resume: node missing",
				zap.String("forward_id", row.ID),
				zap.Uint64("node_id", row.NodeID))
			_ = m.repo.MarkClosed(ctx, row.ID, row.BytesIn, row.BytesOut)
			continue
		}
		target, dialer, release, derr := m.makeDialer(ctx, node)
		if derr != nil {
			m.logger.Warn("tcpfwd resume: dialer build failed",
				zap.String("forward_id", row.ID), zap.Error(derr))
			_ = m.repo.MarkClosed(ctx, row.ID, row.BytesIn, row.BytesOut)
			continue
		}
		fwd, serr := Start(ctx, StartOpts{
			ID:        row.ID,
			UserID:    row.UserID,
			Host:      row.LocalHost,
			PortRange: [2]int{row.LocalPort, row.LocalPort},
			Dialer:    dialer,
			Target:    target,
			Logger:    m.logger,
			Bus:       m.bus,
		})
		if serr != nil {
			release()
			row.Status = model.PortForwardPortUnavailable
			_ = m.repo.Update(ctx, &row)
			m.logger.Warn("tcpfwd resume: listener busy",
				zap.String("forward_id", row.ID),
				zap.String("host", row.LocalHost),
				zap.Int("port", row.LocalPort),
				zap.Error(serr))
			continue
		}
		if fwd.Addr().Port != row.LocalPort {
			// Kernel handed us a different port — the original was already
			// taken. Record the new port so the UI stays accurate.
			row.LocalPort = fwd.Addr().Port
			_ = m.repo.Update(ctx, &row)
		}
		m.mu.Lock()
		m.entries[row.ID] = &entry{
			row: &row, forwarder: fwd, release: release, expiresAt: row.ExpiresAt,
		}
		m.mu.Unlock()
		resumed++
	}
	if resumed > 0 {
		m.logger.Info("tcpfwd resumed forwarders", zap.Int("count", resumed))
	}
	return resumed, nil
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
