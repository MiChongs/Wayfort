package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/secaudit"
)

// SecAuditHandler exposes the read-only security posture report (ActionConnect).
type SecAuditHandler struct {
	Mgr               *secaudit.Manager
	unavailableReason string
}

func NewSecAuditHandler(mgr *secaudit.Manager) *SecAuditHandler { return &SecAuditHandler{Mgr: mgr} }
func NewSecAuditHandlerStub(reason string) *SecAuditHandler {
	return &SecAuditHandler{unavailableReason: reason}
}

func (h *SecAuditHandler) Report(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	r, err := h.Mgr.Report(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		switch {
		case errors.Is(err, secaudit.ErrUnauthorized):
			c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
		case errors.Is(err, secaudit.ErrDisabled):
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
		case errors.Is(err, secaudit.ErrUnreachable):
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
		default:
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		}
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, r)
}

func (h *SecAuditHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "secaudit subsystem unavailable"
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
