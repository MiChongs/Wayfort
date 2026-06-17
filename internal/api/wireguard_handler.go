package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/sse"
	"github.com/michongs/wayfort/internal/wireguard"
)

// WireGuardHandler exposes the WireGuard ops surface. Status/Stream require
// ActionConnect on the node; SetInterface (wg-quick up/down) is gated by
// PermNetworkManage at the route.
type WireGuardHandler struct {
	Mgr               *wireguard.Manager
	unavailableReason string
}

func NewWireGuardHandler(mgr *wireguard.Manager) *WireGuardHandler { return &WireGuardHandler{Mgr: mgr} }
func NewWireGuardHandlerStub(reason string) *WireGuardHandler {
	return &WireGuardHandler{unavailableReason: reason}
}

func (h *WireGuardHandler) Status(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	s, err := h.Mgr.Status(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, s)
}

// Stream pushes the WireGuard status (transfer totals, handshake freshness) over
// SSE so the peer table and per-peer transfer mini-charts update live.
func (h *WireGuardHandler) Stream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	produce := func(ctx context.Context) (any, error) {
		return h.Mgr.Status(ctx, claims.UserID, nodeID)
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		respondWGErr(c, err)
		return
	}
	sse.Snapshots(c, 5*time.Second, first, produce)
}

// Probe reports the node's distro / package manager / kernel-module situation so
// the UI can show what a one-click install would do. Read-only (ActionConnect).
func (h *WireGuardHandler) Probe(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	p, err := h.Mgr.Probe(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, p)
}

// Install streams wireguard-tools installation over SSE (event: line / done) so
// the operator sees progress live instead of waiting on a blocked request. The
// route gates this with wireguard:manage (the perm middleware runs before the
// SSE headers, so a 403 is still plain JSON).
func (h *WireGuardHandler) Install(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	ac := wireguard.AuditClaims{UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP()}
	sse.Lines(c, func(ctx context.Context, emit func(string)) error {
		return h.Mgr.Install(ctx, claims.UserID, nodeID, ac, emit)
	})
}

type wgIfaceBody struct {
	Name string `json:"name" binding:"required"`
	Up   bool   `json:"up"`
}

func (h *WireGuardHandler) SetInterface(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body wgIfaceBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.SetInterface(c.Request.Context(), claims.UserID, nodeID, wireguard.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.Name, body.Up); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ---- keys ----

func (h *WireGuardHandler) GenKeyPair(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	kp, err := h.Mgr.GenKeyPair(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, kp)
}

func (h *WireGuardHandler) GenPSK(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	psk, err := h.Mgr.GenPSK(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"preshared_key": psk})
}

// ---- interfaces ----

func (h *WireGuardHandler) GetIfaceConfig(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	cfg, err := h.Mgr.GetIfaceConfig(c.Request.Context(), claims.UserID, nodeID, c.Param("name"))
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, cfg)
}

func (h *WireGuardHandler) CreateIface(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var req wireguard.CreateIfaceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cfg, err := h.Mgr.CreateIface(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), req)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, cfg)
}

func (h *WireGuardHandler) UpdateIface(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var req wireguard.UpdateIfaceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cfg, err := h.Mgr.UpdateIface(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), c.Param("name"), req)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, cfg)
}

func (h *WireGuardHandler) DeleteIface(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var opts wireguard.DeleteOpts
	_ = c.ShouldBindJSON(&opts) // body optional; confirm may also arrive as a query
	if c.Query("confirm") == "true" {
		opts.Confirm = true
	}
	if err := h.Mgr.DeleteIface(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), c.Param("name"), opts); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type wgAutostartBody struct {
	Enabled bool `json:"enabled"`
}

func (h *WireGuardHandler) SetAutostart(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body wgAutostartBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.SetAutostart(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), c.Param("name"), body.Enabled); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ---- config file ----

func (h *WireGuardHandler) ReadConf(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	// Private keys are never revealed over the API.
	conf, err := h.Mgr.ReadConf(c.Request.Context(), claims.UserID, nodeID, c.Param("name"), false)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, conf)
}

type wgConfBody struct {
	Content   string `json:"content" binding:"required"`
	ExpectSHA string `json:"expect_sha"`
}

func (h *WireGuardHandler) WriteConf(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body wgConfBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.WriteConf(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), c.Param("name"), body.Content, body.ExpectSHA); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type wgDiffBody struct {
	Content string `json:"content" binding:"required"`
}

func (h *WireGuardHandler) DiffConf(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body wgDiffBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	diff, err := h.Mgr.DiffConf(c.Request.Context(), claims.UserID, nodeID, c.Param("name"), body.Content)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, diff)
}

// ApplyConfigStream applies the conf to the running interface over SSE. The mode
// query selects hot sync (default) vs reload. Gated by wireguard:manage.
func (h *WireGuardHandler) ApplyConfigStream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	mode := wireguard.ApplySync
	if c.Query("mode") == "reload" {
		mode = wireguard.ApplyReload
	}
	name := c.Param("name")
	ac := h.audit(c, claims)
	sse.Lines(c, func(ctx context.Context, emit func(string)) error {
		return h.Mgr.ApplyConfig(ctx, claims.UserID, nodeID, ac, name, mode, emit)
	})
}

// ---- peers ----

func (h *WireGuardHandler) AddPeer(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var req wireguard.PeerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.AddPeer(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), c.Param("name"), req); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *WireGuardHandler) UpdatePeer(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var req wireguard.PeerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.UpdatePeer(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), c.Param("name"), req); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type wgPeerKeyBody struct {
	PublicKey string `json:"public_key" binding:"required"`
}

func (h *WireGuardHandler) DeletePeer(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body wgPeerKeyBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.DeletePeer(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), c.Param("name"), body.PublicKey); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ---- clients ----

func (h *WireGuardHandler) NewClient(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var req wireguard.ClientReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cc, err := h.Mgr.NewClient(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), c.Param("name"), req)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, cc)
}

// ---- gateway ----

func (h *WireGuardHandler) GatewayStatus(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	gw, err := h.Mgr.GatewayStatus(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gw)
}

type wgForwardingBody struct {
	Persist bool `json:"persist"`
}

func (h *WireGuardHandler) EnableForwarding(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body wgForwardingBody
	_ = c.ShouldBindJSON(&body)
	if err := h.Mgr.EnableForwarding(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), body.Persist); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type wgNatBody struct {
	Enabled bool   `json:"enabled"`
	Egress  string `json:"egress"`
	Confirm bool   `json:"confirm"`
}

func (h *WireGuardHandler) SetNAT(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body wgNatBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.EnableGateway(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), body.Egress, body.Enabled, body.Confirm); err != nil {
		respondWGErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *WireGuardHandler) audit(c *gin.Context, claims *auth.Claims) wireguard.AuditClaims {
	return wireguard.AuditClaims{UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP()}
}

func (h *WireGuardHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "wireguard subsystem unavailable"
		if h != nil && h.unavailableReason != "" {
			msg = h.unavailableReason
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": msg, "code": "subsystem_unavailable"})
		return 0, nil, false
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return 0, nil, false
	}
	nodeID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return 0, nil, false
	}
	return nodeID, claims, true
}

func respondWGErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, wireguard.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, wireguard.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, wireguard.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, wireguard.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, wireguard.ErrBadIface),
		errors.Is(err, wireguard.ErrBadCIDR),
		errors.Is(err, wireguard.ErrBadPort),
		errors.Is(err, wireguard.ErrBadMTU),
		errors.Is(err, wireguard.ErrBadKeepalive),
		errors.Is(err, wireguard.ErrBadKey),
		errors.Is(err, wireguard.ErrBadAllowedIPs),
		errors.Is(err, wireguard.ErrBadEndpoint),
		errors.Is(err, wireguard.ErrBadEgress):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	case errors.Is(err, wireguard.ErrNotInstalled):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "not_installed"})
	case errors.Is(err, wireguard.ErrUnsupportedPkgMgr):
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error(), "code": "unsupported_pkg_manager"})
	case errors.Is(err, wireguard.ErrConfNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error(), "code": "conf_not_found"})
	case errors.Is(err, wireguard.ErrConfExists):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "conf_exists"})
	case errors.Is(err, wireguard.ErrPeerNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error(), "code": "peer_not_found"})
	case errors.Is(err, wireguard.ErrPeerExists):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "peer_exists"})
	case errors.Is(err, wireguard.ErrSubnetFull):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "subnet_full"})
	case errors.Is(err, wireguard.ErrConfConflict):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "conflict"})
	case errors.Is(err, wireguard.ErrConfirmRequired):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "confirm_required"})
	case errors.Is(err, wireguard.ErrConfParse):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "conf_parse"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
