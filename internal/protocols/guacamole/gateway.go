package guacamole

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"go.uber.org/zap"
)

// Handler serves the /ws/rdp/:id and /ws/vnc/:id endpoints by wiring up a
// per-session SOCKS5 listener (backed by the gateway's proxy chain) and a
// bridge to guacd.
type Handler struct {
	GW     *webssh.Gateway
	Bridge *Bridge
	Cfg    config.GuacamoleConfig
	Sealer *pkgcrypto.Sealer
}

func NewHandler(gw *webssh.Gateway, cfg config.GuacamoleConfig, sealer *pkgcrypto.Sealer) *Handler {
	return &Handler{
		GW:     gw,
		Bridge: NewBridge(cfg, gw.Logger()),
		Cfg:    cfg,
		Sealer: sealer,
	}
}

func (h *Handler) HandleRDP(c *gin.Context) { h.handle(c, "rdp", model.NodeProtoRDP) }
func (h *Handler) HandleVNC(c *gin.Context) { h.handle(c, "vnc", model.NodeProtoVNC) }

func (h *Handler) handle(c *gin.Context, guacProto string, expected model.NodeProtocol) {
	if !h.Cfg.Enabled {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "guacamole disabled"})
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
	if node.Disabled || node.EffectiveProtocol() != expected {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "node protocol mismatch"})
		return
	}
	cred, err := h.GW.CredentialRepo().FindByID(c.Request.Context(), node.CredentialID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	user, pass, err := DecodeCredential(h.Sealer, cred)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	width := atoiDefault(c.Query("width"), 1280)
	height := atoiDefault(c.Query("height"), 720)
	dpi := atoiDefault(c.Query("dpi"), 96)
	// Plan 13.B.2 / B.3: client-driven feature & quality toggles.
	quality := c.Query("quality") // high / medium / low / auto
	enableAudio := queryBool(c.Query("audio"), true)
	enableClipboard := queryBool(c.Query("clipboard"), true)
	keyboardLayout := c.Query("keyboard")

	wsConn, err := webssh.AcceptWS(c, "guacamole")
	if err != nil {
		h.GW.Logger().Warn("ws upgrade failed", zap.Error(err))
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sessionID := uuid.NewString()
	clientIP := c.ClientIP()

	opts := runOpts{
		guacProto:       guacProto,
		user:            user,
		pass:            pass,
		width:           width,
		height:          height,
		dpi:             dpi,
		quality:         quality,
		enableAudio:     enableAudio,
		enableClipboard: enableClipboard,
		keyboardLayout:  keyboardLayout,
	}
	if err := h.run(ctx, wsConn, sessionID, claims, clientIP, node, opts); err != nil {
		h.GW.Logger().Info("graphical session ended", zap.String("session", sessionID), zap.Error(err))
		_ = wsConn.Close(websocket.StatusInternalError, truncate(err.Error(), 100))
		return
	}
	_ = wsConn.Close(websocket.StatusNormalClosure, "bye")
}

// runOpts groups the request-scoped knobs to keep the handler signatures
// readable as we accrete more parameters (Plan 13.B.2/3).
type runOpts struct {
	guacProto       string
	user            string
	pass            string
	width           int
	height          int
	dpi             int
	quality         string
	enableAudio     bool
	enableClipboard bool
	keyboardLayout  string
}

func (h *Handler) run(ctx context.Context, ws *websocket.Conn, sessionID string, claims *auth.Claims, clientIP string, node *model.Node, o runOpts) error {
	// Build proxy chain → ContextDialer used by per-session SOCKS5 listener.
	hops, err := h.GW.ResolveHops(ctx, node.ProxyChain)
	if err != nil {
		return fmt.Errorf("resolve hops: %w", err)
	}
	finalDialer, release, err := h.GW.BuildChain(ctx, hops)
	if err != nil {
		return fmt.Errorf("build chain: %w", err)
	}
	defer release()

	// Per-session SOCKS5 listener, bound to the configured host (default 127.0.0.1).
	// guacd will dial through this to reach the node, traversing whatever
	// bastions/SOCKS5 hops the node was configured with.
	listenHost := h.Cfg.SOCKSListenHost
	if listenHost == "" {
		listenHost = "127.0.0.1"
	}
	target := pkgssh.AddrOf(node.Host, node.Port)
	sl, err := New(ctx, listenHost, finalDialer, target, h.GW.Logger())
	if err != nil {
		return fmt.Errorf("start socks listener: %w", err)
	}
	defer sl.Close()

	// Wire up recording. The guacd container needs the recording-path as it
	// sees the filesystem; default to host's sessions_dir.
	var recPath, recName string
	if h.Cfg.Recording {
		root := h.Cfg.RecordingPathInGuacd
		if root == "" {
			root = h.GW.Storage()
		}
		recPath = JoinRecordingDir(root)
		recName = RecordingFilename(sessionID)
		// Also ensure the host-side directory exists so we can serve the file
		// later through /sessions/:id/recording.
		_ = os.MkdirAll(JoinRecordingDir(h.GW.Storage()), 0o750)
	}

	params := ConnectParams{
		Protocol:        o.guacProto,
		Hostname:        node.Host,
		Port:            node.Port,
		Username:        o.user,
		Password:        o.pass,
		Width:           o.width,
		Height:          o.height,
		DPI:             o.dpi,
		SOCKSHost:       listenHost,
		SOCKSPort:       sl.Port(),
		RecordingPath:   recPath,
		RecordingName:   recName,
		EnableAudio:     o.enableAudio,
		EnableClipboard: o.enableClipboard,
		KeyboardLayout:  o.keyboardLayout,
		// Pragmatic default: most production RDP servers (especially Windows
		// hosts) ship with self-signed certificates. Without ignore-cert=true
		// guacd terminates the TLS handshake with
		// "SSL/TLS connection failed (untrusted/self-signed certificate?)"
		// and the user just sees a black screen. We default to permissive +
		// allow explicit `"ignore-cert": "false"` in Node.ProtoOptions to
		// re-enable verification per node. For VNC the flag is a no-op (VNC
		// doesn't use X.509 by default).
		IgnoreCert: true,
	}
	// Plan 13.B.2: apply quality preset on top of base params. Per-node
	// overrides via ProtoOptions still win (processed below).
	params = ApplyQualityPreset(params, o.quality)
	// Optional protocol knobs from Node.ProtoOptions JSON.
	for k, v := range ParseOptions(node.ProtoOptions) {
		switch k {
		case "domain":
			params.Domain = v
		case "security":
			params.Security = v
		case "ignore-cert":
			// Operator can opt back into strict verification.
			params.IgnoreCert = v == "true" || v == "1"
		case "keyboard":
			params.KeyboardLayout = v
		}
	}

	hostRecPath := ""
	if h.Cfg.Recording {
		hostRecPath = JoinRecordingDir(h.GW.Storage()) + "/" + recName
	}
	row := h.GW.BeginSession(context.Background(), sessionID, model.SessionGraphical, claims, clientIP, node, hostRecPath, recordingType(h.Cfg.Recording))
	h.GW.Audit().Log(model.AuditLog{
		Kind:      model.AuditGraphicalStart,
		UserID:    claims.UserID,
		Username:  claims.Username,
		SessionID: sessionID,
		NodeID:    row.NodeID,
		ClientIP:  clientIP,
		Payload:   o.guacProto,
	})

	// Plan 13.A.2: surface guacd error instructions as audit + log entries
	// so operators can see WHY a session failed (NLA auth, unreachable, TLS,
	// etc.) without having to tail guacd logs separately.
	nodeID := row.NodeID
	params.OnError = func(code int, msg string) {
		desc := Describe(code)
		h.GW.Logger().Warn("guacd error instruction",
			zap.String("session", sessionID),
			zap.Int("code", code),
			zap.String("desc", desc),
			zap.String("msg", msg),
		)
		payload, _ := jsonMarshal(map[string]any{
			"code":        code,
			"description": desc,
			"message":     msg,
			"protocol":    o.guacProto,
		})
		h.GW.Audit().Log(model.AuditLog{
			Kind:      model.AuditGraphicalError,
			UserID:    claims.UserID,
			Username:  claims.Username,
			SessionID: sessionID,
			NodeID:    nodeID,
			ClientIP:  clientIP,
			Payload:   string(payload),
		})
	}

	start := time.Now()
	bytesIn, bytesOut, runErr := h.Bridge.Serve(ctx, ws, params)
	endErr := runErr
	if errors.Is(endErr, context.Canceled) {
		endErr = nil
	}
	// Plan 13.A.4: real byte counters (vs. previous 0,0 placeholder).
	h.GW.EndSession(context.Background(), row, claims, bytesIn, bytesOut, endErr)
	_ = start
	return runErr
}

// queryBool parses a query-string boolean. "0", "false", "no", "off" → false;
// anything else (including empty) → def.
func queryBool(s string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "":
		return def
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}

func recordingType(on bool) model.RecordingType {
	if on {
		return model.RecordingGuac
	}
	return model.RecordingNone
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
