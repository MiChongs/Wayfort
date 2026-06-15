package guard

import (
	"sync"
	"time"
)

// Breaker is a per-key circuit breaker (keyed by domain). When a key's dial
// failure rate exceeds the threshold over a rolling window with enough samples,
// it trips OPEN for a cooldown — new attempts fail fast instead of piling more
// load onto a target that is already failing (security-architecture.md §11).
// After the cooldown it half-opens: the next attempt is allowed through and its
// outcome decides whether to close or re-open.
type Breaker struct {
	minSamples   int
	failureRatio float64
	window       time.Duration
	openFor      time.Duration

	counters *Counters
	mu       sync.Mutex
	state    map[string]*breakerState
	now      func() time.Time // injectable clock for tests
}

// SetCounters attaches a shared rejection-counter sink (for /metrics).
func (b *Breaker) SetCounters(c *Counters) { b.counters = c }

type breakerState struct {
	windowStart time.Time
	successes   int
	failures    int
	openUntil   time.Time
}

// BreakerConfig tunes the breaker. Zero values fall back to sensible defaults
// (≥10 samples, >80% failures, 60s window, 30s open).
type BreakerConfig struct {
	MinSamples   int
	FailureRatio float64
	Window       time.Duration
	OpenFor      time.Duration
}

func NewBreaker(cfg BreakerConfig) *Breaker {
	if cfg.MinSamples <= 0 {
		cfg.MinSamples = 10
	}
	if cfg.FailureRatio <= 0 {
		cfg.FailureRatio = 0.8
	}
	if cfg.Window <= 0 {
		cfg.Window = time.Minute
	}
	if cfg.OpenFor <= 0 {
		cfg.OpenFor = 30 * time.Second
	}
	return &Breaker{
		minSamples:   cfg.MinSamples,
		failureRatio: cfg.FailureRatio,
		window:       cfg.Window,
		openFor:      cfg.OpenFor,
		state:        make(map[string]*breakerState),
		now:          time.Now,
	}
}

// Allow reports whether a request for key may proceed. When the breaker is open
// and the cooldown has not elapsed, it returns a *RejectError; once the cooldown
// passes it allows a single probe through (half-open).
func (b *Breaker) Allow(key string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.state[key]
	if st == nil {
		return nil
	}
	now := b.now()
	if !st.openUntil.IsZero() && now.Before(st.openUntil) {
		b.counters.inc(RejectCircuitOpen)
		return reject(RejectCircuitOpen,
			"目标连续失败，熔断中，请稍后重试 (%s)", st.openUntil.Sub(now).Round(time.Second))
	}
	return nil
}

// Record feeds a dial outcome back to the breaker, rolling the window and
// tripping the circuit when the failure threshold is crossed.
func (b *Breaker) Record(key string, success bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	st := b.state[key]
	if st == nil {
		st = &breakerState{windowStart: now}
		b.state[key] = st
	}
	// A successful probe after the cooldown closes the circuit and resets.
	if !st.openUntil.IsZero() && now.After(st.openUntil) {
		st.openUntil = time.Time{}
		st.windowStart = now
		st.successes, st.failures = 0, 0
	}
	// Roll the window.
	if now.Sub(st.windowStart) > b.window {
		st.windowStart = now
		st.successes, st.failures = 0, 0
	}
	if success {
		st.successes++
	} else {
		st.failures++
	}
	total := st.successes + st.failures
	if total >= b.minSamples {
		ratio := float64(st.failures) / float64(total)
		if ratio >= b.failureRatio {
			st.openUntil = now.Add(b.openFor)
		}
	}
}
