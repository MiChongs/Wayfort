package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/sysuser"
)

// SysUserHandler exposes local-account inspection + management. Info requires
// ActionConnect; lock/unlock + group changes are gated by PermSysUserManage.
type SysUserHandler struct {
	Mgr               *sysuser.Manager
	unavailableReason string
}

func NewSysUserHandler(mgr *sysuser.Manager) *SysUserHandler { return &SysUserHandler{Mgr: mgr} }
func NewSysUserHandlerStub(reason string) *SysUserHandler {
	return &SysUserHandler{unavailableReason: reason}
}

func (h *SysUserHandler) Info(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	info, err := h.Mgr.Info(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondSysUserErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, info)
}

func (h *SysUserHandler) Lock(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body struct {
		User string `json:"user" binding:"required"`
		Lock bool   `json:"lock"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.SetLock(c.Request.Context(), claims.UserID, nodeID, h.ac(c, claims), body.User, body.Lock); err != nil {
		respondSysUserErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *SysUserHandler) AddToGroup(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body struct {
		User  string `json:"user" binding:"required"`
		Group string `json:"group" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.AddToGroup(c.Request.Context(), claims.UserID, nodeID, h.ac(c, claims), body.User, body.Group); err != nil {
		respondSysUserErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *SysUserHandler) ac(c *gin.Context, claims *auth.Claims) sysuser.AuditClaims {
	return sysuser.AuditClaims{UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP()}
}

func (h *SysUserHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "sysuser subsystem unavailable"
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

func respondSysUserErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, sysuser.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, sysuser.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, sysuser.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, sysuser.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, sysuser.ErrBadName):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
