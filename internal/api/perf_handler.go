package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/perf"
	"github.com/michongs/jumpserver-anonymous/internal/sse"
)

// PerfHandler exposes read-only performance diagnostics. All endpoints require
// an authenticated session with ActionConnect on the node.
type PerfHandler struct {
	Mgr               *perf.Manager
	unavailableReason string
}

func NewPerfHandler(mgr *perf.Manager) *PerfHandler { return &PerfHandler{Mgr: mgr} }
func NewPerfHandlerStub(reason string) *PerfHandler  { return &PerfHandler{unavailableReason: reason} }

func (h *PerfHandler) Snapshot(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	snap, err := h.Mgr.Snapshot(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondPerfErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, snap)
}

// Stream pushes a fresh performance snapshot every few seconds over SSE so the
// dock's live mini-charts update without the client re-establishing a request
// each tick. The first snapshot is fetched synchronously so hard failures keep
// their proper HTTP status.
func (h *PerfHandler) Stream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	produce := func(ctx context.Context) (any, error) {
		return h.Mgr.Snapshot(ctx, claims.UserID, nodeID)
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		respondPerfErr(c, err)
		return
	}
	sse.Snapshots(c, 5*time.Second, first, produce)
}

func (h *PerfHandler) Dmesg(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	lines, _ := strconv.Atoi(c.DefaultQuery("lines", "200"))
	d, err := h.Mgr.Dmesg(c.Request.Context(), claims.UserID, nodeID, lines)
	if err != nil {
		respondPerfErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, d)
}

func (h *PerfHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "perf subsystem unavailable"
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

func respondPerfErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, perf.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, perf.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, perf.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
