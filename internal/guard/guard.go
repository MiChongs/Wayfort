// Package guard is the gateway's overload-protection layer
// (security-architecture.md §11): concurrency gates, connection-rate limits,
// and per-domain circuit breakers. It fails FAST — a rejected request returns a
// typed RejectError the protocol/API layer maps to a clear status code, rather
// than queueing and letting load pile up.
//
// This package is deliberately Redis-free and per-instance: the in-memory
// counters are the fail-open degrade path the design calls for (when Redis is
// unavailable, limits fall back to per-instance enforcement rather than becoming
// a single point of failure). A Redis-backed shared layer can wrap these for
// cross-instance counting without changing callers.
package guard

import (
	"fmt"
	"sync"
	"sync/atomic"
)

// Counters tallies rejections by reason across all guards sharing it, for the
// /metrics exporter. Safe for concurrent use; nil-safe inc.
type Counters struct {
	global  atomic.Uint64
	user    atomic.Uint64
	domain  atomic.Uint64
	rate    atomic.Uint64
	circuit atomic.Uint64
}

func (c *Counters) inc(reason RejectReason) {
	if c == nil {
		return
	}
	switch reason {
	case RejectGlobalConcurrency:
		c.global.Add(1)
	case RejectUserConcurrency:
		c.user.Add(1)
	case RejectDomainConcurrency:
		c.domain.Add(1)
	case RejectRateLimited:
		c.rate.Add(1)
	case RejectCircuitOpen:
		c.circuit.Add(1)
	}
}

// Snapshot returns the per-reason rejection totals.
func (c *Counters) Snapshot() map[RejectReason]uint64 {
	if c == nil {
		return nil
	}
	return map[RejectReason]uint64{
		RejectGlobalConcurrency: c.global.Load(),
		RejectUserConcurrency:   c.user.Load(),
		RejectDomainConcurrency: c.domain.Load(),
		RejectRateLimited:       c.rate.Load(),
		RejectCircuitOpen:       c.circuit.Load(),
	}
}

// RejectReason is a stable machine code the API layer maps to an HTTP status.
type RejectReason string

const (
	RejectGlobalConcurrency RejectReason = "global_concurrency_exceeded"
	RejectUserConcurrency   RejectReason = "user_concurrency_exceeded"
	RejectDomainConcurrency RejectReason = "domain_concurrency_exceeded"
	RejectRateLimited       RejectReason = "rate_limited"
	RejectCircuitOpen       RejectReason = "circuit_open"
)

// RejectError is returned when a guard refuses a request. Callers type-assert it
// to surface the reason (e.g. 429 vs 503) and a human message.
type RejectError struct {
	Reason  RejectReason
	Message string
}

func (e *RejectError) Error() string { return e.Message }

func reject(reason RejectReason, format string, args ...any) *RejectError {
	return &RejectError{Reason: reason, Message: fmt.Sprintf(format, args...)}
}

// Limits configures the concurrency gates. A zero ceiling means "unlimited".
type Limits struct {
	GlobalMax  int // total live sessions across all users/domains
	PerUserMax int // live sessions per user
}

// Limiter enforces global / per-user / per-domain concurrent-session ceilings.
// Acquire reserves a slot in all applicable gates atomically (all-or-nothing);
// the returned release frees them. Safe for concurrent use.
type Limiter struct {
	limits   Limits
	counters *Counters

	mu        sync.Mutex
	global    int
	perUser   map[uint64]int
	perDomain map[uint64]int
}

func NewLimiter(limits Limits) *Limiter {
	return &Limiter{
		limits:    limits,
		perUser:   make(map[uint64]int),
		perDomain: make(map[uint64]int),
	}
}

// SetCounters attaches a shared rejection-counter sink (for /metrics).
func (l *Limiter) SetCounters(c *Counters) { l.counters = c }

// Acquire reserves one session slot for (userID, domainID). domainMax is the
// domain's own ceiling (0 = unlimited), passed per-call because it lives on the
// domain row, not in static config. Returns a release func on success, or a
// *RejectError naming the gate that was full. release is safe to call once.
func (l *Limiter) Acquire(userID, domainID uint64, domainMax int) (release func(), err error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.limits.GlobalMax > 0 && l.global >= l.limits.GlobalMax {
		l.counters.inc(RejectGlobalConcurrency)
		return nil, reject(RejectGlobalConcurrency,
			"网关并发会话已达上限 (%d)，请稍后重试", l.limits.GlobalMax)
	}
	if l.limits.PerUserMax > 0 && l.perUser[userID] >= l.limits.PerUserMax {
		l.counters.inc(RejectUserConcurrency)
		return nil, reject(RejectUserConcurrency,
			"你的并发会话已达上限 (%d)", l.limits.PerUserMax)
	}
	if domainMax > 0 && l.perDomain[domainID] >= domainMax {
		l.counters.inc(RejectDomainConcurrency)
		return nil, reject(RejectDomainConcurrency,
			"该网域并发会话已达上限 (%d)", domainMax)
	}

	l.global++
	l.perUser[userID]++
	if domainID != 0 {
		l.perDomain[domainID]++
	}

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if l.global > 0 {
				l.global--
			}
			if l.perUser[userID] > 0 {
				l.perUser[userID]--
				if l.perUser[userID] == 0 {
					delete(l.perUser, userID)
				}
			}
			if domainID != 0 && l.perDomain[domainID] > 0 {
				l.perDomain[domainID]--
				if l.perDomain[domainID] == 0 {
					delete(l.perDomain, domainID)
				}
			}
		})
	}, nil
}

// Snapshot reports current counts for observability (the /metrics exporter).
type Snapshot struct {
	Global     int
	ActiveUsers int
	ActiveDomains int
}

func (l *Limiter) Snapshot() Snapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	return Snapshot{Global: l.global, ActiveUsers: len(l.perUser), ActiveDomains: len(l.perDomain)}
}
