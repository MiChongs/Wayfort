package webssh

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/michongs/jumpserver-anonymous/internal/approval"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/cache"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/livewatch"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"go.uber.org/zap"
	xssh "golang.org/x/crypto/ssh"
)

// AnonymousLauncher abstracts the docker sandbox to keep the gateway
// independent from the docker SDK. The returned Backend is owned by the caller
// after Launch returns.
type AnonymousLauncher interface {
	Launch(ctx context.Context, sessionID string, cols, rows int) (Backend, string, error)
	// TTL is the sandbox lifetime; the gateway arms a server-side cutoff with
	// it so an idle-but-connected session is still destroyed on schedule.
	TTL() time.Duration
	// Destroy reclaims a sandbox container by id. Called when the session ends
	// so the container does not outlive its single use.
	Destroy(ctx context.Context, containerID string)
}

type Gateway struct {
	cfg       config.WebSSHConfig
	storage   string
	recorder  config.RecorderConfig
	logger    *zap.Logger
	nodes     *repo.NodeRepo
	creds     *repo.CredentialRepo
	proxies   *repo.ProxyRepo
	sessions  *repo.SessionRepo
	audit     *audit.Writer
	resolver  *pkgssh.Resolver
	chain     *dialer.ChainBuilder
	hostKey   xssh.HostKeyCallback
	dialTO    time.Duration
	cache     *cache.Cache
	anonymous AnonymousLauncher
	anonOn    bool
	// approval is nil unless the bootstrap wired the Phase 16 approval
	// service. When non-nil, HandleNodeSSH / HandleNodeTelnet refuse a
	// dial against any node whose RequiresApprovalForConnect flag is
	// set and the requesting user has no active grant.
	approval *approval.Service

	// metrics is the lifecycle-v3 connection-quality sample queue. Nil-safe:
	// when unwired, MetricSink returns a no-op sink and sampling is skipped.
	metrics *audit.MetricWriter

	// liveHub fans an in-progress terminal session's output to read-only
	// observers (over-the-shoulder monitoring). Nil until SetLiveHub; all Hub
	// methods are nil-safe so the tee costs nothing when unwired.
	liveHub *livewatch.Hub

	// live tracks in-process interactive sessions so an admin can force one
	// off from the sessions audit page. Keyed by session id.
	liveMu sync.Mutex
	live   map[string]*liveSession
}

// SetMetrics wires the connection-quality sample queue after construction so the
// NewGateway signature stays stable. Pass nil to disable sampling.
func (g *Gateway) SetMetrics(m *audit.MetricWriter) { g.metrics = m }

// SetLiveHub wires the read-only live-watch hub. Pass nil to disable monitoring.
func (g *Gateway) SetLiveHub(h *livewatch.Hub) { g.liveHub = h }

// LiveHub exposes the hub so sibling protocol packages (dbcli) can attach it to
// the webssh.Session they build.
func (g *Gateway) LiveHub() *livewatch.Hub { return g.liveHub }

// IsLive reports whether an interactive session is currently running in this
// process — the precondition for monitoring it (the tee only exists here).
func (g *Gateway) IsLive(sessionID string) bool {
	g.liveMu.Lock()
	_, ok := g.live[sessionID]
	g.liveMu.Unlock()
	return ok
}

// liveSession is the handle the gateway keeps for a running interactive
// session: a cancel to tear it down and a flag the teardown path reads to
// stamp the row as terminated rather than a clean close.
type liveSession struct {
	cancel     context.CancelFunc
	terminated atomic.Bool
}

type GatewayOptions struct {
	Cfg        config.WebSSHConfig
	Recorder   config.RecorderConfig
	SessionDir string
	DialTO     time.Duration
	AnonOn     bool
}

func NewGateway(
	opts GatewayOptions,
	logger *zap.Logger,
	nodes *repo.NodeRepo,
	creds *repo.CredentialRepo,
	proxies *repo.ProxyRepo,
	sessions *repo.SessionRepo,
	audw *audit.Writer,
	resolver *pkgssh.Resolver,
	chain *dialer.ChainBuilder,
	hostKey xssh.HostKeyCallback,
	c *cache.Cache,
	anonymous AnonymousLauncher,
) *Gateway {
	return &Gateway{
		cfg:       opts.Cfg,
		storage:   opts.SessionDir,
		recorder:  opts.Recorder,
		logger:    logger,
		nodes:     nodes,
		creds:     creds,
		proxies:   proxies,
		sessions:  sessions,
		audit:     audw,
		resolver:  resolver,
		chain:     chain,
		hostKey:   hostKey,
		dialTO:    opts.DialTO,
		cache:     c,
		anonymous: anonymous,
		anonOn:    opts.AnonOn,
		live:      map[string]*liveSession{},
	}
}

// registerLive records a running session so TerminateSession can reach it. The
// cancel is bound at registration so there's no window where the session is
// listed as live but not yet cancellable.
func (g *Gateway) registerLive(id string, cancel context.CancelFunc) *liveSession {
	ls := &liveSession{cancel: cancel}
	g.liveMu.Lock()
	g.live[id] = ls
	g.liveMu.Unlock()
	return ls
}

func (g *Gateway) unregisterLive(id string) {
	g.liveMu.Lock()
	delete(g.live, id)
	g.liveMu.Unlock()
}

// TerminateSession force-closes a live interactive session owned by this
// gateway. It reports whether the session was found here so the API handler
// can fall back to a direct row update for sessions it doesn't own.
func (g *Gateway) TerminateSession(_ context.Context, sessionID string) bool {
	g.liveMu.Lock()
	ls, ok := g.live[sessionID]
	g.liveMu.Unlock()
	if !ok {
		return false
	}
	ls.terminated.Store(true)
	if ls.cancel != nil {
		ls.cancel()
	}
	return true
}

// SetApproval wires the Phase 16 approval service after construction so the
// existing NewGateway signature doesn't churn. Pass nil to disable the
// gate; the gateway behaves identically to the pre-Phase-16 codebase.
func (g *Gateway) SetApproval(svc *approval.Service) { g.approval = svc }

// HandleNodeSSH upgrades the request to WebSocket and tunnels into the named node.
func (g *Gateway) HandleNodeSSH(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	nodeID, err := strconv.ParseUint(c.Param("node_id"), 10, 64)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return
	}
	cols := atoiDefault(c.Query("cols"), 120)
	rows := atoiDefault(c.Query("rows"), 32)

	node, err := g.nodes.FindByID(c.Request.Context(), nodeID)
	if err != nil || node == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	if node.Disabled {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "node disabled"})
		return
	}

	// Phase 16 — enforce per-node approval gate before WS upgrade. The
	// dial happens later in runNodeSession; doing the check here means a
	// rejected request never opens a socket the browser would need to
	// tear down. CheckEnforced is a no-op when the node's flag is unset.
	var grantDeadline time.Time
	approvalCheck := approval.EnforcementCheck{
		UserID:       claims.UserID,
		BusinessType: model.ApprovalBizAssetAccess,
		ResourceType: "node",
		ResourceID:   strconv.FormatUint(nodeID, 10),
		Action:       "connect",
	}
	if g.approval != nil {
		res, err := g.approval.CheckEnforced(c.Request.Context(), approvalCheck)
		if err != nil {
			g.logger.Warn("approval check error", zap.Error(err), zap.Uint64("node_id", nodeID))
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "approval check failed"})
			return
		}
		if !res.Allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": res.Reason, "approval_required": true})
			return
		}
		if res.Required && !res.ExpiresAt.IsZero() {
			grantDeadline = res.ExpiresAt
		}
	}

	conn, err := acceptWS(c)
	if err != nil {
		g.logger.Warn("ws upgrade failed", zap.Error(err))
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sessionID := uuid.NewString()
	clientIP := c.ClientIP()

	// Server-side hard cutoff (authoritative; the browser countdown is only a
	// courtesy). Renewal-aware: a grant renewed before expiry reschedules the
	// cutoff instead of dropping the session.
	if g.approval != nil && !grantDeadline.IsZero() {
		stop := g.approval.WatchGrant(ctx, approvalCheck, grantDeadline, func(reason string) {
			_ = conn.Close(websocket.StatusPolicyViolation, reason)
			cancel()
		})
		defer stop()
	}

	if err := g.runNodeSession(ctx, conn, sessionID, claims, clientIP, node, cols, rows); err != nil {
		g.logger.Info("ssh session ended", zap.String("session", sessionID), zap.Error(err))
		_ = conn.Close(websocket.StatusInternalError, truncate(err.Error(), 100))
		return
	}
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
}

// HandleAnonymousSSH launches an ephemeral container.
func (g *Gateway) HandleAnonymousSSH(c *gin.Context) {
	if !g.anonOn || g.anonymous == nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "anonymous disabled"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || !claims.Anonymous {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "anonymous token required"})
		return
	}
	cols := atoiDefault(c.Query("cols"), 120)
	rows := atoiDefault(c.Query("rows"), 32)

	conn, err := acceptWS(c)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sessionID := uuid.NewString()
	clientIP := c.ClientIP()
	if err := g.runAnonSession(ctx, conn, sessionID, claims, clientIP, cols, rows); err != nil {
		_ = conn.Close(websocket.StatusInternalError, truncate(err.Error(), 100))
		return
	}
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
}

func (g *Gateway) runNodeSession(ctx context.Context, conn *websocket.Conn, sessionID string, claims *auth.Claims, clientIP string, node *model.Node, cols, rows int) (rerr error) {
	nodeID := node.ID

	// Create the session row up front so a connection that fails to dial or
	// authenticate still produces a lifecycle record (phases + an end row) and
	// shows up in the audit center. The recording path is backfilled once the
	// recorder exists. recordEnd runs on every return path via defer.
	row := g.recordStart(sessionID, model.SessionInteractive, claims, clientIP, node, nil)
	var sess *Session
	terminated := false
	defer func() { g.recordEnd(row, sess, claims, rerr, terminated) }()

	dctx, dcancel := context.WithTimeout(ctx, g.dialTO+5*time.Second)
	defer dcancel()

	// ---- dial: resolve the proxy chain and build the dialer ----
	doneDial := g.OpenPhase(sessionID, model.PhaseDial, claims, clientIP, &nodeID)
	hops, err := g.resolveHops(dctx, node.ProxyChain)
	if err != nil {
		doneDial(model.PhaseFailed, err.Error())
		return fmt.Errorf("resolve hops: %w", err)
	}
	finalDialer, release, err := g.chain.Build(dctx, hops, nil)
	if err != nil {
		doneDial(model.PhaseFailed, err.Error())
		return fmt.Errorf("build chain: %w", err)
	}
	defer release()
	doneDial(model.PhaseSucceeded, fmt.Sprintf("hops=%d", len(hops)))

	// ---- auth: connect TCP to the target and authenticate SSH ----
	doneAuth := g.OpenPhase(sessionID, model.PhaseAuth, claims, clientIP, &nodeID)
	cred, err := g.creds.FindByID(dctx, node.CredentialID)
	if err != nil || cred == nil {
		doneAuth(model.PhaseFailed, "credential lookup failed")
		return fmt.Errorf("credential lookup: %w", err)
	}
	methods, err := g.resolver.AuthMethods(cred)
	if err != nil {
		doneAuth(model.PhaseFailed, err.Error())
		return err
	}
	client, err := pkgssh.Connect(dctx, finalDialer, pkgssh.DialConfig{
		Addr:    pkgssh.AddrOf(node.Host, node.Port),
		User:    pkgssh.PreferredUser(cred, node.Username),
		Auth:    methods,
		HostKey: g.hostKey,
		Timeout: g.dialTO,
	})
	if err != nil {
		doneAuth(model.PhaseFailed, truncate(err.Error(), 200))
		return err
	}
	defer client.Close()
	doneAuth(model.PhaseSucceeded, "")

	// Best-effort: stamp the credential's last-used time for the admin
	// freshness signal. Detached context so it outlives the dial scope; a
	// failure here must never affect the session.
	go func(cid uint64) { _ = g.creds.TouchLastUsed(context.Background(), cid) }(node.CredentialID)

	// ---- handshake: open the SSH channel, allocate the PTY, init recording ----
	doneHS := g.OpenPhase(sessionID, model.PhaseHandshake, claims, clientIP, &nodeID)
	sshSess, err := client.NewSession()
	if err != nil {
		doneHS(model.PhaseFailed, err.Error())
		return err
	}
	backend, err := NewSSHBackend(sshSess, "xterm-256color", cols, rows)
	if err != nil {
		_ = sshSess.Close()
		doneHS(model.PhaseFailed, err.Error())
		return err
	}
	rec, recErr := audit.NewRecorder(sessionID, g.storage, g.recorder, cols, rows, g.logger)
	if recErr != nil {
		g.logger.Warn("recorder init failed", zap.Error(recErr))
	}
	if rec != nil {
		row.RecordingPath = rec.Path()
		row.RecordingType = model.RecordingAsciicast
		_ = g.sessions.Finish(context.Background(), sessionID, map[string]any{
			"cast_path":      rec.Path(),
			"recording_type": model.RecordingAsciicast,
		})
	}
	doneHS(model.PhaseSucceeded, "")

	sess = &Session{
		ID: sessionID, Conn: conn, Backend: backend,
		Recorder: rec, Cfg: g.cfg, Logger: g.logger, LiveHub: g.liveHub,
	}
	tracker := newCmdTracker(func(cmd string) {
		g.audit.Log(model.AuditLog{
			Kind: model.AuditCommand, UserID: claims.UserID, Username: claims.Username,
			SessionID: sessionID, NodeID: &nodeID, ClientIP: clientIP, Payload: cmd,
		})
	})
	sess.OnCommand(tracker.feed)

	sctx, scancel := context.WithCancel(ctx)
	defer scancel()
	ls := g.registerLive(sessionID, scancel)
	defer g.unregisterLive(sessionID)

	// ---- ready: the interactive loop, sampled for connection quality ----
	doneReady := g.OpenPhase(sessionID, model.PhaseReady, claims, clientIP, &nodeID)
	// Dual-path latency: the SSH client measures the real gateway↔target hop via
	// keepalive, while the prober's WS ping measures the operator's link.
	sess.ServerPing = func(pctx context.Context) (time.Duration, error) {
		return pkgssh.ProbeRTT(pctx, client)
	}
	if sink := g.MetricSink(sessionID); sink != nil {
		sess.OnLatency = sink.ObserveLatency
		go sink.Run(sctx, 5*time.Second, func() (uint64, uint64) {
			return sess.BytesIn.Load(), sess.BytesOut.Load()
		})
	}

	runErr := sess.Run(sctx)
	doneReady(model.PhaseSucceeded, "")
	terminated = ls.terminated.Load()
	return runErr
}

func (g *Gateway) runAnonSession(ctx context.Context, conn *websocket.Conn, sessionID string, claims *auth.Claims, clientIP string, cols, rows int) error {
	backend, containerID, err := g.anonymous.Launch(ctx, sessionID, cols, rows)
	if err != nil {
		return err
	}
	// A sandbox is single-use: reclaim its container the instant the session
	// ends, whatever the cause (clean disconnect, error, or TTL cutoff). The
	// janitor stays the safety net for orphans a gateway crash would leave.
	defer g.anonymous.Destroy(context.Background(), containerID)

	rec, rerr := audit.NewRecorder(sessionID, g.storage, g.recorder, cols, rows, g.logger)
	if rerr != nil {
		g.logger.Warn("recorder init failed", zap.Error(rerr))
	}

	now := time.Now()
	row := &model.Session{
		ID: sessionID, Kind: model.SessionAnonymous,
		UserID: claims.UserID, Username: claims.Username, ClientIP: clientIP,
		StartedAt: now, Status: model.SessionActive,
	}
	if rec != nil {
		row.RecordingPath = rec.Path()
		row.RecordingType = model.RecordingAsciicast
	}
	if err := g.sessions.Create(context.Background(), row); err != nil {
		g.logger.Warn("anon session row create failed", zap.Error(err))
	}
	if g.cache != nil {
		_ = g.cache.RegisterSession(context.Background(), sessionID, claims.Username)
	}
	g.audit.Log(model.AuditLog{
		Kind: model.AuditAnonymousLaunch, UserID: claims.UserID, Username: claims.Username,
		SessionID: sessionID, ClientIP: clientIP, Payload: containerID,
	})

	sess := &Session{ID: sessionID, Conn: conn, Backend: backend, Recorder: rec, Cfg: g.cfg, Logger: g.logger, LiveHub: g.liveHub}
	tracker := newCmdTracker(func(cmd string) {
		g.audit.Log(model.AuditLog{
			Kind: model.AuditCommand, UserID: claims.UserID, Username: claims.Username,
			SessionID: sessionID, ClientIP: clientIP, Payload: cmd,
		})
	})
	sess.OnCommand(tracker.feed)

	sctx, scancel := context.WithCancel(ctx)
	defer scancel()
	ls := g.registerLive(sessionID, scancel)
	defer g.unregisterLive(sessionID)

	// Server-side TTL cutoff — authoritative. The browser shows a courtesy
	// countdown, but the sandbox's "auto-destroy after TTL" guarantee can't
	// depend on a client timer: arm a hard deadline here that closes the
	// socket with a clear reason and tears the session down. The deferred
	// Destroy above then reclaims the container.
	if ttl := g.anonymous.TTL(); ttl > 0 {
		timer := time.AfterFunc(ttl, func() {
			_ = conn.Close(websocket.StatusPolicyViolation, "sandbox expired")
			scancel()
		})
		defer timer.Stop()
	}

	// A sandbox is interactive from the moment it launches — record a ready
	// phase and sample its connection quality like any other session. There's no
	// SSH hop to a target (it's a local container), so only the client path is
	// measured (ServerPing left nil).
	doneReady := g.OpenPhase(sessionID, model.PhaseReady, claims, clientIP, nil)
	if sink := g.MetricSink(sessionID); sink != nil {
		sess.OnLatency = sink.ObserveLatency
		go sink.Run(sctx, 5*time.Second, func() (uint64, uint64) {
			return sess.BytesIn.Load(), sess.BytesOut.Load()
		})
	}

	runErr := sess.Run(sctx)
	doneReady(model.PhaseSucceeded, "")
	g.recordEnd(row, sess, claims, runErr, ls.terminated.Load())
	return runErr
}

func (g *Gateway) resolveHops(ctx context.Context, chain string) ([]*model.Proxy, error) {
	if chain == "" {
		return nil, nil
	}
	out := make([]*model.Proxy, 0, 4)
	for _, raw := range splitNonEmpty(chain, ',') {
		id, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy id %q", raw)
		}
		p, err := g.proxies.FindByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if p == nil {
			return nil, fmt.Errorf("proxy %d not found", id)
		}
		out = append(out, p)
	}
	return out, nil
}

func (g *Gateway) recordStart(sessionID string, kind model.SessionKind, claims *auth.Claims, clientIP string, node *model.Node, rec *audit.Recorder) *model.Session {
	now := time.Now()
	nodeID := node.ID
	row := &model.Session{
		ID: sessionID, Kind: kind,
		UserID: claims.UserID, Username: claims.Username,
		NodeID: &nodeID, NodeName: node.Name,
		ClientIP:  clientIP,
		StartedAt: now, Status: model.SessionActive,
	}
	if rec != nil {
		row.RecordingPath = rec.Path()
		row.RecordingType = model.RecordingAsciicast
	}
	if err := g.sessions.Create(context.Background(), row); err != nil {
		g.logger.Warn("session row create failed", zap.Error(err))
	}
	if g.cache != nil {
		_ = g.cache.RegisterSession(context.Background(), sessionID, claims.Username)
	}
	g.audit.Log(model.AuditLog{
		Kind: model.AuditSessionStart, UserID: claims.UserID, Username: claims.Username,
		SessionID: sessionID, NodeID: &nodeID, ClientIP: clientIP,
	})
	return row
}

func (g *Gateway) recordEnd(row *model.Session, sess *Session, claims *auth.Claims, runErr error, terminated bool) {
	end := time.Now()
	row.EndedAt = &end
	if sess != nil {
		row.BytesIn = sess.BytesIn.Load()
		row.BytesOut = sess.BytesOut.Load()
	}
	switch {
	case terminated:
		row.Status = model.SessionTerminated
		row.Reason = "管理员强制下线"
	case runErr != nil && !errors.Is(runErr, context.Canceled):
		row.Status = model.SessionErrored
		row.Reason = truncate(runErr.Error(), 250)
	default:
		row.Status = model.SessionClosed
	}
	// Backfill phase + quality rollups, then persist the end fields with a
	// partial update so ready_at / current_phase set mid-session aren't
	// clobbered by a full-row Save.
	g.finalizeLifecycle(row)
	if err := g.sessions.Finish(context.Background(), row.ID, map[string]any{
		"ended_at":        end,
		"bytes_in":        row.BytesIn,
		"bytes_out":       row.BytesOut,
		"status":          row.Status,
		"reason":          row.Reason,
		"current_phase":   row.CurrentPhase,
		"peak_rtt_ms":     row.PeakRTTMs,
		"avg_rtt_ms":      row.AvgRTTMs,
		"reconnect_count": row.ReconnectCount,
	}); err != nil {
		g.logger.Warn("session row finish failed", zap.Error(err))
	}
	if g.cache != nil {
		_ = g.cache.UnregisterSession(context.Background(), row.ID)
	}
	g.audit.Log(model.AuditLog{
		Kind: model.AuditSessionEnd, UserID: claims.UserID, Username: claims.Username,
		SessionID: row.ID, NodeID: row.NodeID, ClientIP: row.ClientIP,
	})
}

func acceptWS(c *gin.Context) (*websocket.Conn, error) {
	return websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{
		OriginPatterns:  []string{"*"},
		Subprotocols:    []string{"webssh.v1"},
		CompressionMode: websocket.CompressionDisabled,
	})
}

func atoiDefault(s string, def int) int {
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func splitNonEmpty(s string, sep rune) []string {
	var out []string
	start := 0
	for i, r := range s {
		if r == sep {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}
