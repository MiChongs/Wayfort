package desktop

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
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

// GET /api/v1/desktop/stats — quick ops view
func (h *ControlHandler) Stats(c *gin.Context) {
	live, total := h.Manager.Stats()
	c.JSON(http.StatusOK, gin.H{"live": live, "total_created": total})
}
