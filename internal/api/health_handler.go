package api

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/health"
	"github.com/michongs/wayfort/internal/sse"
)

// HealthHandler serves proxy reachability: a JSON snapshot, an SSE stream that
// re-reads the registry every few seconds (never probing on the request path),
// and an on-demand probe trigger. All gated by PermProxyManage at the router.
type HealthHandler struct {
	Reg    *health.Registry
	Prober *health.Prober
}

func (h *HealthHandler) ok(c *gin.Context) bool {
	if h == nil || h.Reg == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "health subsystem unavailable", "code": "subsystem_unavailable"})
		return false
	}
	return true
}

func (h *HealthHandler) Snapshot(c *gin.Context) {
	if !h.ok(c) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, h.Reg.Snapshot())
}

func (h *HealthHandler) Stream(c *gin.Context) {
	if !h.ok(c) {
		return
	}
	produce := func(context.Context) (any, error) { return h.Reg.Snapshot(), nil }
	first, _ := produce(c.Request.Context())
	sse.Snapshots(c, 5*time.Second, first, produce)
}

// ProbeNow forces a fresh probe cycle and returns the resulting snapshot. Bounded
// so a slow probe can't hang the request indefinitely.
func (h *HealthHandler) ProbeNow(c *gin.Context) {
	if !h.ok(c) {
		return
	}
	if h.Prober == nil {
		c.JSON(http.StatusOK, h.Reg.Snapshot())
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	c.JSON(http.StatusOK, h.Prober.ProbeNow(ctx))
}
