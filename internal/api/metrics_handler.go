package api

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/metrics"
	"github.com/michongs/jumpserver-anonymous/internal/sse"
)

// MetricsHandler serves proxy-chain connection metrics as a JSON snapshot and an
// SSE stream. Both are read-only and gated by PermProxyManage at the router.
type MetricsHandler struct {
	Reg *metrics.Registry
}

func (h *MetricsHandler) ok(c *gin.Context) bool {
	if h == nil || h.Reg == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "metrics subsystem unavailable", "code": "subsystem_unavailable"})
		return false
	}
	return true
}

func (h *MetricsHandler) Snapshot(c *gin.Context) {
	if !h.ok(c) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, h.Reg.Snapshot())
}

func (h *MetricsHandler) Stream(c *gin.Context) {
	if !h.ok(c) {
		return
	}
	produce := func(context.Context) (any, error) { return h.Reg.Snapshot(), nil }
	first, _ := produce(c.Request.Context())
	sse.Snapshots(c, 5*time.Second, first, produce)
}
