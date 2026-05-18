package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/firewall"
)

// FirewallHandler exposes the workspace v2 firewall management surface.
// Reads require an authenticated session with ActionConnect on the node;
// writes are additionally gated by PermFirewallManage at the route level.
type FirewallHandler struct {
	Mgr *firewall.Manager
}

func NewFirewallHandler(mgr *firewall.Manager) *FirewallHandler {
	return &FirewallHandler{Mgr: mgr}
}

func (h *FirewallHandler) Status(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	s, err := h.Mgr.Status(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, s)
}

func (h *FirewallHandler) ListRules(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	rules, err := h.Mgr.ListRules(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": rules})
}

func (h *FirewallHandler) AddRule(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var spec firewall.RuleSpec
	if err := c.ShouldBindJSON(&spec); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.AddRule(c.Request.Context(), claims.UserID, nodeID, firewall.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, spec); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *FirewallHandler) DeleteRule(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	idx, err := strconv.Atoi(c.Param("index"))
	if err != nil || idx <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid rule index"})
		return
	}
	if err := h.Mgr.DeleteRule(c.Request.Context(), claims.UserID, nodeID, firewall.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, idx); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *FirewallHandler) Enable(c *gin.Context) { h.setEnabled(c, true) }
func (h *FirewallHandler) Disable(c *gin.Context) { h.setEnabled(c, false) }

func (h *FirewallHandler) setEnabled(c *gin.Context, on bool) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	if err := h.Mgr.SetEnabled(c.Request.Context(), claims.UserID, nodeID, firewall.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, on); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ctx pulls the node ID + claims, short-circuiting on missing auth or bad
// path param. Mirrors the pattern used by other per-node handlers.
func (h *FirewallHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "firewall subsystem unavailable"})
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

func respondFirewallErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, firewall.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
	case errors.Is(err, firewall.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
