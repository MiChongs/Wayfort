// Package sesswin gives the stateless REST protocols (SFTP file browser, OSS
// object browser) a lifecycle-v3 session row without a long-lived connection.
//
// Those handlers open and close a fresh backend connection on every request, so
// there is no natural "session". The Tracker synthesises one per (user, node)
// browsing window: the first operation lazily creates an active Session row
// (kind=sftp|oss) with a ready phase; subsequent operations reuse it and bump a
// sliding idle timer; a reaper goroutine closes windows that go quiet, stamping
// the end row + byte totals + a closed phase. Every file/object audit event can
// then carry the SessionID, so the sessions list shows a real duration, byte
// total, and a clickable timeline instead of scattered orphan rows.
package sesswin

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
)

// Namer resolves a node id to its display name (best-effort; "" on miss).
type Namer func(ctx context.Context, id uint64) string

type entry struct {
	sessionID string
	userID    uint64
	username  string
	nodeID    uint64
	nodeName  string
	clientIP  string
	lastSeen  time.Time
	bytesIn   uint64
	bytesOut  uint64
}

// Tracker manages the open browsing windows for one session kind.
type Tracker struct {
	kind     model.SessionKind
	sessions *repo.SessionRepo
	audit    *audit.Writer
	namer    Namer
	logger   *zap.Logger
	ttl      time.Duration

	mu   sync.Mutex
	live map[string]*entry // key = "uid:nodeID"
}

// New builds a tracker. ttl is the idle window after which a quiet session is
// closed (default 30m). namer may be nil.
func New(kind model.SessionKind, sessions *repo.SessionRepo, aud *audit.Writer, namer Namer, ttl time.Duration, logger *zap.Logger) *Tracker {
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	return &Tracker{
		kind: kind, sessions: sessions, audit: aud, namer: namer, ttl: ttl, logger: logger,
		live: map[string]*entry{},
	}
}

func key(uid, nodeID uint64) string { return fmt.Sprintf("%d:%d", uid, nodeID) }

// Touch returns the session id for the (user, node) browsing window, creating
// the active row + ready phase on first contact and accumulating byte deltas.
// Safe (returns "") when the tracker isn't wired with a repo.
func (t *Tracker) Touch(ctx context.Context, userID uint64, username, clientIP string, nodeID uint64, inDelta, outDelta uint64) string {
	if t == nil || t.sessions == nil {
		return ""
	}
	k := key(userID, nodeID)
	t.mu.Lock()
	e, ok := t.live[k]
	if ok {
		e.lastSeen = time.Now()
		e.bytesIn += inDelta
		e.bytesOut += outDelta
		id := e.sessionID
		in, out := e.bytesIn, e.bytesOut
		t.mu.Unlock()
		// Persist the running totals immediately when an operation actually
		// moved bytes (upload/download), so the session's "流量" shows live —
		// the reaper otherwise only flushes every ~30s.
		if inDelta > 0 || outDelta > 0 {
			_ = t.sessions.Finish(ctx, id, map[string]any{"bytes_in": in, "bytes_out": out})
		}
		return id
	}
	e = &entry{
		sessionID: uuid.NewString(),
		userID:    userID, username: username, nodeID: nodeID, clientIP: clientIP,
		lastSeen: time.Now(), bytesIn: inDelta, bytesOut: outDelta,
	}
	if t.namer != nil {
		e.nodeName = t.namer(ctx, nodeID)
	}
	t.live[k] = e
	t.mu.Unlock()

	now := time.Now()
	nid := nodeID
	row := &model.Session{
		ID: e.sessionID, Kind: t.kind,
		UserID: userID, Username: username,
		NodeID: &nid, NodeName: e.nodeName, ClientIP: clientIP,
		StartedAt: now, Status: model.SessionActive,
		CurrentPhase: model.PhaseReady, ReadyAt: &now,
	}
	if err := t.sessions.Create(ctx, row); err != nil && t.logger != nil {
		t.logger.Warn("sesswin row create failed", zap.Error(err))
	}
	_ = t.sessions.AppendPhase(ctx, &model.SessionPhase{
		SessionID: e.sessionID, Phase: model.PhaseReady, Status: model.PhaseRunning, StartedAt: now,
	})
	if t.audit != nil {
		t.audit.Log(model.AuditLog{
			Kind: model.AuditSessionStart, UserID: userID, Username: username,
			SessionID: e.sessionID, NodeID: &nid, ClientIP: clientIP,
		})
	}
	return e.sessionID
}

// Run reaps idle windows on a fixed interval and closes every open window on
// shutdown, so no session is left dangling as "active".
func (t *Tracker) Run(ctx context.Context) error {
	interval := min(t.ttl, 30*time.Second)
	tk := time.NewTicker(interval)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			t.closeAll(context.Background())
			return ctx.Err()
		case <-tk.C:
			t.reap(ctx)
		}
	}
}

type byteFlush struct {
	id  string
	in  uint64
	out uint64
}

func (t *Tracker) reap(ctx context.Context) {
	cutoff := time.Now().Add(-t.ttl)
	var stale []*entry
	var active []byteFlush
	t.mu.Lock()
	for k, e := range t.live {
		if e.lastSeen.Before(cutoff) {
			stale = append(stale, e)
			delete(t.live, k)
		} else {
			active = append(active, byteFlush{e.sessionID, e.bytesIn, e.bytesOut})
		}
	}
	t.mu.Unlock()
	for _, e := range stale {
		t.closeEntry(ctx, e)
	}
	// Backstop: keep live rows' byte totals fresh even if the last op was a
	// metadata-only listing (Touch only flushes on byte-moving ops).
	for _, f := range active {
		_ = t.sessions.Finish(ctx, f.id, map[string]any{"bytes_in": f.in, "bytes_out": f.out})
	}
}

func (t *Tracker) closeAll(ctx context.Context) {
	t.mu.Lock()
	all := make([]*entry, 0, len(t.live))
	for k, e := range t.live {
		all = append(all, e)
		delete(t.live, k)
	}
	t.mu.Unlock()
	for _, e := range all {
		t.closeEntry(ctx, e)
	}
}

func (t *Tracker) closeEntry(ctx context.Context, e *entry) {
	end := time.Now()
	nid := e.nodeID
	_ = t.sessions.ClosePhaseAny(ctx, e.sessionID, model.PhaseSucceeded, end)
	if err := t.sessions.Finish(ctx, e.sessionID, map[string]any{
		"ended_at":      end,
		"bytes_in":      e.bytesIn,
		"bytes_out":     e.bytesOut,
		"status":        model.SessionClosed,
		"current_phase": model.PhaseClosed,
	}); err != nil && t.logger != nil {
		t.logger.Warn("sesswin row finish failed", zap.Error(err))
	}
	if t.audit != nil {
		t.audit.Log(model.AuditLog{
			Kind: model.AuditSessionEnd, UserID: e.userID, Username: e.username,
			SessionID: e.sessionID, NodeID: &nid, ClientIP: e.clientIP,
		})
	}
}
