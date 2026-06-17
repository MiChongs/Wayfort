package insights

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/sse"
)

// Handler serves the three insights endpoints under /api/v1/nodes/:id/insights/*.
type Handler struct {
	Manager *Manager
}

func NewHandler(m *Manager) *Handler { return &Handler{Manager: m} }

// System: GET /api/v1/nodes/:id/insights/system
func (h *Handler) System(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	snap, err := h.Manager.System(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, snap)
}

// SystemStream: GET /api/v1/nodes/:id/insights/system/stream
// Pushes a fresh system snapshot every few seconds over SSE so the dock's
// in-place live KPI strip (CPU / memory / load / disk mini-charts) updates
// continuously without per-tick request setup.
func (h *Handler) SystemStream(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	produce := func(ctx context.Context) (any, error) {
		return h.Manager.System(ctx, claims.UserID, nodeID)
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	sse.Snapshots(c, 5*time.Second, first, produce)
}

// Processes: GET /api/v1/nodes/:id/insights/processes?sort=cpu|mem|rss|pid&limit=50
func (h *Handler) Processes(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	sortBy := c.DefaultQuery("sort", "cpu")
	switch sortBy {
	case "cpu", "mem", "rss", "pid":
	default:
		sortBy = "cpu"
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	list, err := h.Manager.Processes(c.Request.Context(), claims.UserID, nodeID, sortBy, limit)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, list)
}

// Network: GET /api/v1/nodes/:id/insights/network
func (h *Handler) Network(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	snap, err := h.Manager.Network(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, snap)
}

// gate extracts the node id from the path and the auth claims from context.
// Returns ok=false (and writes the error response) when either is missing.
func (h *Handler) gate(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h.Manager == nil || !h.Manager.Enabled() {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "insights disabled"})
		return 0, nil, false
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return 0, nil, false
	}
	nodeID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return 0, nil, false
	}
	return nodeID, claims, true
}

func respondError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
	case errors.Is(err, ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
	default:
		// 502 Bad Gateway makes sense here — the gateway tried to reach the
		// upstream node and that call failed. Matches what the SFTP handler
		// would also surface in this scenario.
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
