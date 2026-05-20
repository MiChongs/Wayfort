package dbcli

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"go.uber.org/zap"
)

// Handler serves /ws/dbcli/:node_id.
type Handler struct {
	GW       *webssh.Gateway
	Launcher *Launcher
	Sealer   pkgcrypto.Vault
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
	if err := h.run(ctx, ws, sessionID, claims, clientIP, node, spec, cols, rows); err != nil {
		h.GW.Logger().Info("dbcli session ended", zap.String("session", sessionID), zap.Error(err))
		_ = ws.Close(websocket.StatusInternalError, err.Error())
		return
	}
	_ = ws.Close(websocket.StatusNormalClosure, "bye")
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
		Recorder: rec, Cfg: h.GW.WSConfig(), Logger: h.GW.Logger(),
	}
	runErr := sess.Run(ctx)
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
