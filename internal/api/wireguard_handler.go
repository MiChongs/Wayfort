package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/sse"
	"github.com/michongs/jumpserver-anonymous/internal/wireguard"
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
	case errors.Is(err, wireguard.ErrBadIface):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
