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
//
// When the gateway is built without firewall wiring (older binary or a
// disabled config branch), routes.go constructs the handler via
// NewFirewallHandlerStub() with a human-readable reason; the 503 response
// body then carries that reason instead of a generic placeholder.
type FirewallHandler struct {
	Mgr               *firewall.Manager
	unavailableReason string
}

func NewFirewallHandler(mgr *firewall.Manager) *FirewallHandler {
	return &FirewallHandler{Mgr: mgr}
}

// NewFirewallHandlerStub returns a handler that always responds 503 with
// the given reason. Used by routes.go when rt.Firewall is nil so operators
// get a concrete diagnosis ("rebuild the gateway from latest source")
// instead of the previous opaque "firewall subsystem unavailable".
func NewFirewallHandlerStub(reason string) *FirewallHandler {
	return &FirewallHandler{Mgr: nil, unavailableReason: reason}
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

func (h *FirewallHandler) Enable(c *gin.Context)  { h.setEnabled(c, true) }
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

// Diagnose returns the same probe results the manager runs internally
// (uid / sudo availability / tool detection / probe stdout) so operators
// can debug "why doesn't the firewall tab work on this node" without
// reading gateway logs.
func (h *FirewallHandler) Diagnose(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	d, err := h.Mgr.Diagnose(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, d)
}

func (h *FirewallHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "firewall subsystem unavailable"
		if h != nil && h.unavailableReason != "" {
			msg = h.unavailableReason
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": msg,
			"code":  "subsystem_unavailable",
		})
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

// respondFirewallErr maps typed errors → HTTP statuses with a machine code
// for the frontend to render contextual hints (vs. dumping a raw stderr
// blob in a toast).
func respondFirewallErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, firewall.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, firewall.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, firewall.ErrNoTool):
		c.JSON(http.StatusNotImplemented, gin.H{"error": err.Error(), "code": "no_tool"})
	case errors.Is(err, firewall.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, firewall.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, firewall.ErrParse):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "parse_error"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
