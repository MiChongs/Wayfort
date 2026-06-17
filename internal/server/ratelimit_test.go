package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/guard"
)

func TestWriteRateLimit_ThrottlesWritesNotReads(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rl := guard.NewRateLimiter(2, time.Minute) // burst 2 writes/min
	r := gin.New()
	r.Use(writeRateLimit(rl))
	r.POST("/x", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	do := func(method string) int {
		w := httptest.NewRecorder()
		// No JWT → keyed by client IP (httptest default 192.0.2.1).
		r.ServeHTTP(w, httptest.NewRequest(method, "/x", nil))
		return w.Code
	}

	// First two writes pass (burst), the third is throttled.
	if do(http.MethodPost) != http.StatusOK || do(http.MethodPost) != http.StatusOK {
		t.Fatal("first two writes should pass")
	}
	if got := do(http.MethodPost); got != http.StatusTooManyRequests {
		t.Fatalf("third write should be 429, got %d", got)
	}
	// Reads are never throttled, even after the write bucket is empty.
	for i := 0; i < 5; i++ {
		if got := do(http.MethodGet); got != http.StatusOK {
			t.Fatalf("read should never be throttled, got %d", got)
		}
	}
}

func TestWriteRateLimit_NilLimiterIsNoop(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(writeRateLimit(nil))
	r.POST("/x", func(c *gin.Context) { c.Status(http.StatusOK) })
	for i := 0; i < 100; i++ {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/x", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("nil limiter must not throttle, got %d", w.Code)
		}
	}
}
