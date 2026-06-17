package desktop

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
)

// ControlHandler — REST endpoints (control plane). Plan 17 M1 ships JSON-
// over-HTTP; M1.5 swaps for ConnectRPC handlers using buf-generated stubs.
// The shape of inputs/outputs is identical so the swap is a wire-level
// change, not a refactor.
type ControlHandler struct {
	Manager *Manager
}

func NewControlHandler(m *Manager) *ControlHandler { return &ControlHandler{Manager: m} }

// POST /api/v1/desktop/sessions
func (h *ControlHandler) Start(c *gin.Context) {
	if h.Manager == nil || !h.Manager.Enabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "desktop subsystem disabled"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	var req StartSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	resp, err := h.Manager.StartSession(c.Request.Context(), claims, c.ClientIP(), req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// DELETE /api/v1/desktop/sessions/:session_id
func (h *ControlHandler) End(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	sessionID := c.Param("session_id")
	if err := h.Manager.End(c.Request.Context(), sessionID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/v1/desktop/stats — live counters + bootstrap status. The
// bootstrap fields are populated by Manager.EnsureWorker; absence of a
// last_bootstrap_at means EnsureWorker has never run (something is wrong
// with the wiring or the goroutine).
func (h *ControlHandler) Stats(c *gin.Context) {
	live, total := h.Manager.Stats()
	status := h.Manager.BootstrapStatus()
	c.JSON(http.StatusOK, gin.H{
		"live":          live,
		"total_created": total,
		"bootstrap":     status,
	})
}

// POST /api/v1/desktop/bootstrap — manually re-run EnsureWorker. Useful
// after the operator just installed MSYS2 / apt-get'd a missing package
// and wants to retry without restarting the gateway. Returns 409 if a
// bootstrap is already in flight.
func (h *ControlHandler) RetryBootstrap(c *gin.Context) {
	if h.Manager == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "desktop subsystem unavailable"})
		return
	}
	// Run with a generous timeout that covers the build step; doesn't
	// block the HTTP request because EnsureWorker is happy in the
	// foreground here (we want the response to reflect outcome).
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()
	if err := h.Manager.EnsureWorker(ctx); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"bootstrap": h.Manager.BootstrapStatus()})
}
