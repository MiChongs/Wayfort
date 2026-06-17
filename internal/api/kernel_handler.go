package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/kernel"
)

// KernelHandler exposes kernel parameter inspection + tuning. Info requires
// ActionConnect; SetSysctl is gated by PermKernelManage at the route.
type KernelHandler struct {
	Mgr               *kernel.Manager
	unavailableReason string
}

func NewKernelHandler(mgr *kernel.Manager) *KernelHandler { return &KernelHandler{Mgr: mgr} }
func NewKernelHandlerStub(reason string) *KernelHandler   { return &KernelHandler{unavailableReason: reason} }

func (h *KernelHandler) Info(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	info, err := h.Mgr.Info(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondKernelErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, info)
}

type kernelSetBody struct {
	Key     string `json:"key" binding:"required"`
	Value   string `json:"value" binding:"required"`
	Persist bool   `json:"persist"`
}

func (h *KernelHandler) SetSysctl(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body kernelSetBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.SetSysctl(c.Request.Context(), claims.UserID, nodeID, kernel.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.Key, body.Value, body.Persist); err != nil {
		respondKernelErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *KernelHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "kernel subsystem unavailable"
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

func respondKernelErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, kernel.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, kernel.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, kernel.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, kernel.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, kernel.ErrBadKey), errors.Is(err, kernel.ErrBadValue):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
