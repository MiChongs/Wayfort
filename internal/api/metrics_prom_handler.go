package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/guard"
)

// PrometheusHandler exposes gateway health in Prometheus text format
// (security-architecture.md §16). It writes the metrics directly — no client
// library dependency — gathering from the overload guard, the audit writer, and
// the agent registry. All sources are optional (nil-safe).
type PrometheusHandler struct {
	Limiter         *guard.Limiter
	Counters        *guard.Counters
	AuditDropped    func() uint64
	AgentsConnected func() int
	// Token, when non-empty, is required as `Authorization: Bearer <token>` —
	// the secure-by-default gate for an otherwise unauthenticated scrape endpoint.
	Token string
}

// Metrics writes the Prometheus exposition.
func (h *PrometheusHandler) Metrics(c *gin.Context) {
	if h.Token != "" {
		got := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
		if strings.TrimSpace(got) != h.Token {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
	}

	var b strings.Builder
	gauge := func(name, help string, v float64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n%s %g\n", name, help, name, name, v)
	}
	counter := func(name, help string, v float64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n%s %g\n", name, help, name, name, v)
	}

	if h.Limiter != nil {
		s := h.Limiter.Snapshot()
		gauge("bastion_sessions_active", "Active sessions tracked by the overload guard.", float64(s.Global))
		gauge("bastion_guard_active_users", "Users with at least one active session.", float64(s.ActiveUsers))
		gauge("bastion_guard_active_domains", "Domains with at least one active session.", float64(s.ActiveDomains))
	}
	if h.Counters != nil {
		b.WriteString("# HELP bastion_guard_rejections_total Overload-guard rejections by reason.\n")
		b.WriteString("# TYPE bastion_guard_rejections_total counter\n")
		for reason, n := range h.Counters.Snapshot() {
			fmt.Fprintf(&b, "bastion_guard_rejections_total{reason=%q} %d\n", string(reason), n)
		}
	}
	if h.AuditDropped != nil {
		counter("bastion_audit_dropped_total", "Audit events dropped under backpressure.", float64(h.AuditDropped()))
	}
	if h.AgentsConnected != nil {
		gauge("bastion_agents_connected", "Reverse-connect agents currently tunnelled to this instance.", float64(h.AgentsConnected()))
	}

	c.Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	c.String(http.StatusOK, b.String())
}
