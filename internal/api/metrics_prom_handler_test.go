package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/guard"
)

func TestPrometheus_EmitsMetricsAndGatesOnToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	lim := guard.NewLimiter(guard.Limits{GlobalMax: 10, PerUserMax: 2})
	ctr := &guard.Counters{}
	lim.SetCounters(ctr)
	// Hold one slot and trip a per-user rejection so the counters are non-zero.
	rel, _ := lim.Acquire(1, 0, 0)
	defer rel()
	_, _ = lim.Acquire(1, 0, 0)
	_, _ = lim.Acquire(1, 0, 0) // 3rd → user rejection

	h := &PrometheusHandler{
		Limiter:         lim,
		Counters:        ctr,
		AuditDropped:    func() uint64 { return 7 },
		AgentsConnected: func() int { return 2 },
		Token:           "scrape-secret",
	}
	r := gin.New()
	r.GET("/metrics", h.Metrics)

	// Without the token → 401.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("missing token must be 401, got %d", w.Code)
	}

	// With the token → 200 + the expected metric lines.
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.Header.Set("Authorization", "Bearer scrape-secret")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("with token want 200, got %d", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{
		"bastion_sessions_active",
		"bastion_guard_active_users",
		"bastion_guard_rejections_total{reason=\"user_concurrency_exceeded\"}",
		"bastion_audit_dropped_total 7",
		"bastion_agents_connected 2",
		"# TYPE bastion_sessions_active gauge",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics output missing %q\n---\n%s", want, body)
		}
	}
}

func TestPrometheus_NoTokenMeansOpen(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := &PrometheusHandler{AuditDropped: func() uint64 { return 0 }}
	r := gin.New()
	r.GET("/metrics", h.Metrics)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("no token configured → open scrape, got %d", w.Code)
	}
}
