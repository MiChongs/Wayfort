package dbcli

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/michongs/wayfort/internal/approval"
	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/webssh"
	pkgcrypto "github.com/michongs/wayfort/pkg/crypto"
	"go.uber.org/zap"
)

// Handler serves /ws/dbcli/:node_id.
type Handler struct {
	GW       *webssh.Gateway
	Launcher *Launcher
	Sealer   pkgcrypto.Vault
	Asset    assetChecker
	// Approval is wired by the bootstrap; nil = no gating.
	Approval *approval.Service
}

type assetChecker interface {
	Check(ctx context.Context, userID, nodeID uint64, action string) (bool, error)
}

func (h *Handler) Handle(c *gin.Context) {
	if h.Launcher == nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "dbcli disabled"})
		return
	}
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
	node, err := h.GW.NodeRepo().FindByID(c.Request.Context(), nodeID)
	if err != nil || node == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	if node.Disabled || !isDBProto(node.EffectiveProtocol()) {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "node is not a db cli target"})
		return
	}
	if err := h.requireNodeAccess(c.Request.Context(), claims.UserID, nodeID); err != nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": err.Error()})
		return
	}

	// Phase 16 — same asset_access gate as webssh; DB CLI sessions are
	// just terminals into a privileged shell, so the gate sits on the
	// node's RequiresApprovalForConnect flag.
	var grantDeadline time.Time
	approvalCheck := approval.EnforcementCheck{
		UserID:       claims.UserID,
		BusinessType: model.ApprovalBizAssetAccess,
		ResourceType: "node",
		ResourceID:   strconv.FormatUint(nodeID, 10),
		Action:       "connect",
	}
	if h.Approval != nil {
		res, err := h.Approval.CheckEnforced(c.Request.Context(), approvalCheck)
		if err != nil {
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

	cred, err := h.GW.CredentialRepo().FindByID(c.Request.Context(), node.CredentialID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	user, pass, err := decode(h.Sealer, cred, node.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	spec, err := Build(node, user, pass, h.Launcher.Config().Images)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cols := atoiDefault(c.Query("cols"), 120)
	rows := atoiDefault(c.Query("rows"), 32)
	ws, err := webssh.AcceptWS(c, "webssh.v1")
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sessionID := uuid.NewString()
	clientIP := c.ClientIP()
	// Server-side hard cutoff (renewal-aware) when access came from a time-bound
	// approval grant.
	if h.Approval != nil && !grantDeadline.IsZero() {
		stop := h.Approval.WatchGrant(ctx, approvalCheck, grantDeadline, func(reason string) {
			_ = ws.Close(websocket.StatusPolicyViolation, reason)
			cancel()
		})
		defer stop()
	}
	if err := h.run(ctx, ws, sessionID, claims, clientIP, node, spec, cols, rows); err != nil {
		h.GW.Logger().Info("dbcli session ended", zap.String("session", sessionID), zap.Error(err))
		_ = ws.Close(websocket.StatusInternalError, err.Error())
		return
	}
	_ = ws.Close(websocket.StatusNormalClosure, "bye")
}

func (h *Handler) requireNodeAccess(ctx context.Context, userID, nodeID uint64) error {
	if h.Asset == nil {
		return errors.New("asset resolver not configured")
	}
	ok, err := h.Asset.Check(ctx, userID, nodeID, asset.ActionConnect)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("node access denied")
	}
	return nil
}

func (h *Handler) run(ctx context.Context, ws *websocket.Conn, sessionID string, claims *auth.Claims, clientIP string, node *model.Node, spec LaunchSpec, cols, rows int) error {
	resp, cid, err := h.Launcher.Launch(ctx, sessionID, spec)
	if err != nil {
		return err
	}
	backend := NewBackend(h.Launcher, cid, resp)
	_ = h.Launcher.Resize(ctx, cid, uint32(cols), uint32(rows))

	rec, rerr := audit.NewRecorder(sessionID, h.GW.Storage(), h.GW.RecorderConfig(), cols, rows, h.GW.Logger())
	if rerr != nil {
		h.GW.Logger().Warn("recorder init failed", zap.Error(rerr))
	}
	recPath := ""
	recType := model.RecordingNone
	if rec != nil {
		recPath = rec.Path()
		recType = model.RecordingAsciicast
	}
	row := h.GW.BeginSession(context.Background(), sessionID, model.SessionInteractive, claims, clientIP, node, recPath, recType)
	sess := &webssh.Session{
		ID: sessionID, Conn: ws, Backend: backend,
		Recorder: rec, Cfg: h.GW.WSConfig(), Logger: h.GW.Logger(), LiveHub: h.GW.LiveHub(),
	}
	sess.OnCommand(h.GW.CommandAuditor(sessionID, claims, clientIP, node))

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	unreg := h.GW.RegisterLive(sessionID, cancel)
	defer unreg()

	// Sample connection quality + persist live byte totals.
	if sink := h.GW.MetricSink(sessionID); sink != nil {
		sess.OnLatency = sink.ObserveLatency
		go sink.Run(sctx, 5*time.Second, func() (uint64, uint64) {
			return sess.BytesIn.Load(), sess.BytesOut.Load()
		})
	}

	runErr := sess.Run(sctx)
	endErr := runErr
	if errors.Is(endErr, context.Canceled) {
		endErr = nil
	}
	h.GW.EndSession(context.Background(), row, claims, sess.BytesIn.Load(), sess.BytesOut.Load(), endErr)
	return runErr
}

func decode(s pkgcrypto.Vault, cred *model.Credential, fallbackUser string) (string, string, error) {
	if cred == nil {
		return fallbackUser, "", nil
	}
	if cred.Kind != model.CredentialPassword {
		return "", "", errors.New("dbcli credentials must be password kind")
	}
	pw, err := s.Open(cred.Secret)
	if err != nil {
		return "", "", err
	}
	user := cred.Username
	if user == "" {
		user = fallbackUser
	}
	return user, string(pw), nil
}

func isDBProto(p model.NodeProtocol) bool {
	switch p {
	case model.NodeProtoMySQL, model.NodeProtoPostgres, model.NodeProtoRedis, model.NodeProtoMongo:
		return true
	}
	return false
}

func atoiDefault(s string, def int) int {
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
