package guard

import (
	"errors"
	"testing"
	"time"
)

func asReject(t *testing.T, err error) *RejectError {
	t.Helper()
	var re *RejectError
	if !errors.As(err, &re) {
		t.Fatalf("expected *RejectError, got %v", err)
	}
	return re
}

func TestLimiter_GlobalAndPerUserCeilings(t *testing.T) {
	l := NewLimiter(Limits{GlobalMax: 3, PerUserMax: 2})

	// User 1 takes 2 slots (its per-user ceiling).
	r1, err := l.Acquire(1, 0, 0)
	if err != nil {
		t.Fatalf("acquire 1: %v", err)
	}
	r2, err := l.Acquire(1, 0, 0)
	if err != nil {
		t.Fatalf("acquire 2: %v", err)
	}
	// A third for user 1 hits the per-user ceiling.
	if _, err := l.Acquire(1, 0, 0); asReject(t, err).Reason != RejectUserConcurrency {
		t.Fatalf("expected user concurrency reject, got %v", err)
	}

	// User 2 takes the last global slot.
	r3, err := l.Acquire(2, 0, 0)
	if err != nil {
		t.Fatalf("acquire user2: %v", err)
	}
	// Global is now full (3) — even a fresh user is rejected globally.
	if _, err := l.Acquire(3, 0, 0); asReject(t, err).Reason != RejectGlobalConcurrency {
		t.Fatalf("expected global concurrency reject, got %v", err)
	}

	// Releasing frees slots and the counts go back down.
	r1()
	if _, err := l.Acquire(3, 0, 0); err != nil {
		t.Fatalf("after release a slot should be free: %v", err)
	}
	r2()
	r3()
	if s := l.Snapshot(); s.Global == 0 {
		// one slot still held by user 3's acquire above
	}
}

func TestLimiter_PerDomainCeiling(t *testing.T) {
	l := NewLimiter(Limits{})
	// Domain 5 capped at 1.
	rel, err := l.Acquire(1, 5, 1)
	if err != nil {
		t.Fatalf("first domain acquire: %v", err)
	}
	if _, err := l.Acquire(2, 5, 1); asReject(t, err).Reason != RejectDomainConcurrency {
		t.Fatalf("expected domain concurrency reject, got %v", err)
	}
	rel()
	if _, err := l.Acquire(2, 5, 1); err != nil {
		t.Fatalf("domain slot should free after release: %v", err)
	}
}

func TestLimiter_ReleaseIsIdempotent(t *testing.T) {
	l := NewLimiter(Limits{GlobalMax: 1})
	rel, _ := l.Acquire(1, 0, 0)
	rel()
	rel() // double release must not underflow / free a phantom slot
	if _, err := l.Acquire(2, 0, 0); err != nil {
		t.Fatalf("one slot expected free: %v", err)
	}
	if _, err := l.Acquire(3, 0, 0); err == nil {
		t.Fatal("global should be full again — double release leaked a slot")
	}
}

func TestBreaker_TripsAndRecovers(t *testing.T) {
	clock := time.Unix(0, 0)
	b := NewBreaker(BreakerConfig{MinSamples: 5, FailureRatio: 0.8, Window: time.Minute, OpenFor: 30 * time.Second})
	b.now = func() time.Time { return clock }

	// Below the sample floor: not tripped even at 100% failure.
	for i := 0; i < 4; i++ {
		b.Record("dom", false)
	}
	if err := b.Allow("dom"); err != nil {
		t.Fatalf("should not trip below min samples: %v", err)
	}
	// Cross the floor with >80% failures → open.
	b.Record("dom", false)
	if err := b.Allow("dom"); asReject(t, err).Reason != RejectCircuitOpen {
		t.Fatalf("expected open circuit, got %v", err)
	}
	// Still open during cooldown.
	clock = clock.Add(20 * time.Second)
	if b.Allow("dom") == nil {
		t.Fatal("should still be open within cooldown")
	}
	// After cooldown, a probe is allowed; a success closes it.
	clock = clock.Add(11 * time.Second)
	if err := b.Allow("dom"); err != nil {
		t.Fatalf("probe should be allowed after cooldown: %v", err)
	}
	b.Record("dom", true)
	if err := b.Allow("dom"); err != nil {
		t.Fatalf("a healthy probe should close the circuit: %v", err)
	}
}

func TestRateLimiter_BurstThenRefill(t *testing.T) {
	clock := time.Unix(0, 0)
	r := NewRateLimiter(3, time.Minute) // 3 per minute, burst 3
	r.now = func() time.Time { return clock }

	// Burst of 3 allowed immediately.
	for i := 0; i < 3; i++ {
		if err := r.Allow("u1"); err != nil {
			t.Fatalf("burst token %d should pass: %v", i, err)
		}
	}
	// 4th is rejected.
	if err := r.Allow("u1"); asReject(t, err).Reason != RejectRateLimited {
		t.Fatalf("expected rate-limit reject, got %v", err)
	}
	// After 20s, one token (rate = 3/60s = 0.05/s → 20s = 1 token) refills.
	clock = clock.Add(20 * time.Second)
	if err := r.Allow("u1"); err != nil {
		t.Fatalf("a token should have refilled: %v", err)
	}
	if err := r.Allow("u1"); err == nil {
		t.Fatal("only one token should have refilled")
	}
	// A different key has its own independent bucket.
	if err := r.Allow("u2"); err != nil {
		t.Fatalf("independent key should pass: %v", err)
	}
}
