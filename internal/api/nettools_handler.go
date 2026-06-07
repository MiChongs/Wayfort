package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/nettools"
	"github.com/michongs/jumpserver-anonymous/internal/sse"
)

// NetToolsHandler exposes network inspection + diagnostics + interface control.
// Info/Diagnose require ActionConnect; SetIface is gated by PermNetworkManage.
type NetToolsHandler struct {
	Mgr               *nettools.Manager
	unavailableReason string
}

func NewNetToolsHandler(mgr *nettools.Manager) *NetToolsHandler { return &NetToolsHandler{Mgr: mgr} }
func NewNetToolsHandlerStub(reason string) *NetToolsHandler {
	return &NetToolsHandler{unavailableReason: reason}
}

func (h *NetToolsHandler) Info(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	info, err := h.Mgr.Info(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondNetErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, info)
}

// Stream pushes the full network snapshot (interfaces + counters + connections)
// over SSE every few seconds, feeding the live per-interface traffic mini-charts
// and a self-updating connection list.
func (h *NetToolsHandler) Stream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	produce := func(ctx context.Context) (any, error) {
		return h.Mgr.Info(ctx, claims.UserID, nodeID)
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		respondNetErr(c, err)
		return
	}
	sse.Snapshots(c, 5*time.Second, first, produce)
}

type netDiagBody struct {
	Tool   string `json:"tool" binding:"required"`
	Target string `json:"target" binding:"required"`
}

func (h *NetToolsHandler) Diagnose(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body netDiagBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.Diagnose(c.Request.Context(), claims.UserID, nodeID, nettools.DiagTool(body.Tool), body.Target)
	if err != nil {
		respondNetErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, r)
}

type netIfaceBody struct {
	Name string `json:"name" binding:"required"`
	Up   bool   `json:"up"`
}

func (h *NetToolsHandler) SetIface(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body netIfaceBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.SetIface(c.Request.Context(), claims.UserID, nodeID, nettools.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.Name, body.Up); err != nil {
		respondNetErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *NetToolsHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "nettools subsystem unavailable"
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

func respondNetErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, nettools.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, nettools.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, nettools.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, nettools.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, nettools.ErrBadTool), errors.Is(err, nettools.ErrBadTarget), errors.Is(err, nettools.ErrBadIface):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
