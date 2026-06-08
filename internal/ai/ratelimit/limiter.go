// Package ratelimit enforces per-provider request (RPM) and token (TPM) ceilings
// for the AI runner. The AIProvider model has carried RateLimitRPM/TPM columns
// for a while but nothing enforced them; this is the enforcement. Limits are
// in-memory continuous-refill token buckets keyed by provider id — process-local
// (good enough for a single gateway; a clustered deployment would move this to a
// shared store).
package ratelimit

import (
	"sync"
	"time"
)

// bucket is a continuous-refill token bucket. cap == the per-minute limit;
// perSec == cap/60. tokens may go slightly negative after Commit reconciles an
// under-estimate, which naturally throttles the next request.
type bucket struct {
	cap    float64
	tokens float64
	perSec float64
	last   time.Time
}

func (b *bucket) refill(now time.Time) {
	if b.last.IsZero() {
		b.last = now
		return
	}
	el := now.Sub(b.last).Seconds()
	if el <= 0 {
		return
	}
	b.tokens += el * b.perSec
	if b.tokens > b.cap {
		b.tokens = b.cap
	}
	b.last = now
}

type provLimits struct {
	req *bucket // nil = unlimited requests
	tok *bucket // nil = unlimited tokens
}

// Limiter holds per-provider buckets. The injectable clock keeps tests
// deterministic.
type Limiter struct {
	mu  sync.Mutex
	m   map[uint64]*provLimits
	now func() time.Time
}

// New builds an empty limiter (every provider unlimited until Configure).
func New() *Limiter { return &Limiter{m: map[uint64]*provLimits{}, now: time.Now} }

// NewWithClock is New with an injected clock (tests).
func NewWithClock(now func() time.Time) *Limiter {
	return &Limiter{m: map[uint64]*provLimits{}, now: now}
}

// Remaining is the live budget snapshot the UI renders as gauges.
type Remaining struct {
	ReqLimit       int `json:"req_limit"`
	ReqRemaining   int `json:"req_remaining"`
	TokLimit       int `json:"tok_limit"`
	TokRemaining   int `json:"tok_remaining"`
	ResetInSeconds int `json:"reset_in_seconds"`
}

// Configured reports whether either ceiling is set.
func (r Remaining) Configured() bool { return r.ReqLimit > 0 || r.TokLimit > 0 }

// Configure sets (or clears) the RPM/TPM ceilings for a provider. 0/negative =
// unlimited for that dimension. Idempotent: re-configuring with the same limits
// preserves the current fill level (the runner calls this every turn).
func (l *Limiter) Configure(providerID uint64, rpm, tpm int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	pl := l.m[providerID]
	if pl == nil {
		pl = &provLimits{}
	}
	pl.req = reconfig(pl.req, rpm, l.now())
	pl.tok = reconfig(pl.tok, tpm, l.now())
	if pl.req == nil && pl.tok == nil {
		delete(l.m, providerID)
		return
	}
	l.m[providerID] = pl
}

func reconfig(b *bucket, limit int, now time.Time) *bucket {
	if limit <= 0 {
		return nil
	}
	c := float64(limit)
	if b == nil {
		return &bucket{cap: c, tokens: c, perSec: c / 60, last: now}
	}
	if b.cap == c {
		return b // unchanged; keep live fill + last
	}
	ratio := 1.0
	if b.cap > 0 {
		ratio = b.tokens / b.cap
	}
	b.cap = c
	b.perSec = c / 60
	b.tokens = ratio * c
	return b
}

// Allow checks (and on success, consumes) one request plus estTokens against the
// provider's buckets. Returns ok=false with a retry-after duration when either
// ceiling is hit — the caller should surface that and NOT call the provider.
func (l *Limiter) Allow(providerID uint64, estTokens int) (ok bool, retryAfter time.Duration, snap Remaining) {
	l.mu.Lock()
	defer l.mu.Unlock()
	pl := l.m[providerID]
	if pl == nil {
		return true, 0, Remaining{}
	}
	now := l.now()
	var wait time.Duration
	if pl.req != nil {
		pl.req.refill(now)
		if pl.req.tokens < 1 {
			need := time.Duration((1 - pl.req.tokens) / pl.req.perSec * float64(time.Second))
			if need > wait {
				wait = need
			}
		}
	}
	if pl.tok != nil && estTokens > 0 {
		pl.tok.refill(now)
		need := float64(estTokens)
		if need > pl.tok.cap {
			need = pl.tok.cap // a single request bigger than the whole budget can't wait forever
		}
		if pl.tok.tokens < need {
			w := time.Duration((need - pl.tok.tokens) / pl.tok.perSec * float64(time.Second))
			if w > wait {
				wait = w
			}
		}
	}
	if wait > 0 {
		return false, wait, l.remainingLocked(pl)
	}
	if pl.req != nil {
		pl.req.tokens--
	}
	if pl.tok != nil {
		pl.tok.tokens -= float64(estTokens)
	}
	return true, 0, l.remainingLocked(pl)
}

// Commit reconciles the token bucket once the real token count is known: refund
// the over-estimate, or charge the extra. Bounded debt (down to -cap) so one
// huge call can't lock the provider out indefinitely.
func (l *Limiter) Commit(providerID uint64, est, actual int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	pl := l.m[providerID]
	if pl == nil || pl.tok == nil {
		return
	}
	pl.tok.tokens += float64(est - actual)
	if pl.tok.tokens > pl.tok.cap {
		pl.tok.tokens = pl.tok.cap
	}
	if pl.tok.tokens < -pl.tok.cap {
		pl.tok.tokens = -pl.tok.cap
	}
}

// Remaining returns the live budget snapshot for a provider.
func (l *Limiter) Remaining(providerID uint64) Remaining {
	l.mu.Lock()
	defer l.mu.Unlock()
	pl := l.m[providerID]
	if pl == nil {
		return Remaining{}
	}
	now := l.now()
	if pl.req != nil {
		pl.req.refill(now)
	}
	if pl.tok != nil {
		pl.tok.refill(now)
	}
	return l.remainingLocked(pl)
}

func (l *Limiter) remainingLocked(pl *provLimits) Remaining {
	r := Remaining{}
	var resetSec float64
	if pl.req != nil {
		r.ReqLimit = int(pl.req.cap)
		r.ReqRemaining = clampInt(pl.req.tokens)
		if pl.req.perSec > 0 {
			resetSec = (pl.req.cap - pl.req.tokens) / pl.req.perSec
		}
	}
	if pl.tok != nil {
		r.TokLimit = int(pl.tok.cap)
		r.TokRemaining = clampInt(pl.tok.tokens)
		if pl.tok.perSec > 0 {
			if s := (pl.tok.cap - pl.tok.tokens) / pl.tok.perSec; s > resetSec {
				resetSec = s
			}
		}
	}
	if resetSec > 0 {
		r.ResetInSeconds = int(resetSec + 0.999)
	}
	return r
}

func clampInt(f float64) int {
	if f < 0 {
		return 0
	}
	return int(f)
}
