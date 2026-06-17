package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	aihealth "github.com/michongs/wayfort/internal/ai/health"
	"github.com/michongs/wayfort/internal/ai/ratelimit"
	"github.com/michongs/wayfort/internal/sse"
)

// AIHealthHandler serves AI provider reachability: a JSON snapshot, an SSE
// stream that re-reads the registry every few seconds (never probing on the
// request path), and an on-demand probe trigger. The live rate-limit budget is
// folded into each provider's status so the UI's Limits gauge stays current.
type AIHealthHandler struct {
	Reg     *aihealth.Registry
	Prober  *aihealth.Prober
	Limiter *ratelimit.Limiter
}

func (h *AIHealthHandler) ok(c *gin.Context) bool {
	if h == nil || h.Reg == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ai health subsystem unavailable", "code": "subsystem_unavailable"})
		return false
	}
	return true
}

// enrich folds the live rate-limit budget into each provider status. Snapshot()
// returns a fresh copy, so mutating it here is safe.
func (h *AIHealthHandler) enrich(snap aihealth.SnapshotPayload) aihealth.SnapshotPayload {
	if h.Limiter == nil {
		return snap
	}
	for id, s := range snap.Providers {
		r := h.Limiter.Remaining(id)
		if !r.Configured() {
			continue
		}
		s.ReqLimit, s.ReqRemaining = r.ReqLimit, r.ReqRemaining
		s.TokLimit, s.TokRemaining = r.TokLimit, r.TokRemaining
		snap.Providers[id] = s
	}
	return snap
}

func (h *AIHealthHandler) Snapshot(c *gin.Context) {
	if !h.ok(c) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, h.enrich(h.Reg.Snapshot()))
}

func (h *AIHealthHandler) Stream(c *gin.Context) {
	if !h.ok(c) {
		return
	}
	produce := func(context.Context) (any, error) { return h.enrich(h.Reg.Snapshot()), nil }
	first, _ := produce(c.Request.Context())
	sse.Snapshots(c, 5*time.Second, first, produce)
}

// ProbeNow forces a fresh probe cycle and returns the resulting snapshot.
// Bounded so a slow probe can't hang the request indefinitely.
func (h *AIHealthHandler) ProbeNow(c *gin.Context) {
	if !h.ok(c) {
		return
	}
	if h.Prober == nil {
		c.JSON(http.StatusOK, h.enrich(h.Reg.Snapshot()))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()
	c.JSON(http.StatusOK, h.enrich(h.Prober.ProbeNow(ctx)))
}
