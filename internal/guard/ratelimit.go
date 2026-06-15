package guard

import (
	"sync"
	"time"
)

// RateLimiter is a per-key token-bucket limiter — the connection-establishment
// rate gate (e.g. 10 new sessions/min/user) and the write-API gate
// (security-architecture.md §11). Tokens refill continuously at Rate per second
// up to Burst; an Allow that finds an empty bucket is rejected. Per-instance and
// lock-guarded; a Redis layer can replace it for cross-instance limits.
type RateLimiter struct {
	rate  float64 // tokens per second
	burst float64

	counters *Counters
	mu       sync.Mutex
	buckets  map[string]*bucket
	now      func() time.Time // injectable clock for tests
}

// SetCounters attaches a shared rejection-counter sink (for /metrics).
func (r *RateLimiter) SetCounters(c *Counters) { r.counters = c }

type bucket struct {
	tokens float64
	last   time.Time
}

// NewRateLimiter builds a limiter allowing `perWindow` events per `window` with
// the bucket capacity (burst) equal to perWindow.
func NewRateLimiter(perWindow int, window time.Duration) *RateLimiter {
	if perWindow <= 0 {
		perWindow = 1
	}
	if window <= 0 {
		window = time.Minute
	}
	return &RateLimiter{
		rate:    float64(perWindow) / window.Seconds(),
		burst:   float64(perWindow),
		buckets: make(map[string]*bucket),
		now:     time.Now,
	}
}

// Allow consumes one token for key, returning a *RejectError when the bucket is
// empty. The first call for a key starts it full (burst available).
func (r *RateLimiter) Allow(key string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	b := r.buckets[key]
	if b == nil {
		b = &bucket{tokens: r.burst, last: now}
		r.buckets[key] = b
	}
	// Refill for elapsed time, capped at burst.
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * r.rate
		if b.tokens > r.burst {
			b.tokens = r.burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		r.counters.inc(RejectRateLimited)
		return reject(RejectRateLimited, "请求过于频繁，请稍后重试")
	}
	b.tokens--
	return nil
}

// Gc drops idle buckets that have fully refilled, bounding memory for a churny
// key space. Safe to call periodically.
func (r *RateLimiter) Gc() {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	for k, b := range r.buckets {
		elapsed := now.Sub(b.last).Seconds()
		if b.tokens+elapsed*r.rate >= r.burst {
			delete(r.buckets, k)
		}
	}
}
