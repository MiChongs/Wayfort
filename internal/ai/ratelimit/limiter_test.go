package ratelimit

import (
	"testing"
	"time"
)

func TestUnlimitedByDefault(t *testing.T) {
	l := New()
	ok, _, _ := l.Allow(1, 1_000_000)
	if !ok {
		t.Fatal("unconfigured provider should always allow")
	}
}

func TestRPMExhaustionAndRefill(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewWithClock(func() time.Time { return now })
	l.Configure(7, 60, 0) // 60 rpm == 1/sec refill, cap 60

	// Drain the full bucket of 60 requests.
	for i := 0; i < 60; i++ {
		if ok, _, _ := l.Allow(7, 0); !ok {
			t.Fatalf("request %d should be allowed", i)
		}
	}
	ok, retry, _ := l.Allow(7, 0)
	if ok {
		t.Fatal("61st request should be denied")
	}
	if retry <= 0 || retry > 2*time.Second {
		t.Fatalf("retry-after out of range: %v", retry)
	}

	// Advance 2s → ~2 tokens refilled → allow two more.
	now = now.Add(2 * time.Second)
	if ok, _, _ := l.Allow(7, 0); !ok {
		t.Fatal("after refill, request should be allowed")
	}
}

func TestTPMExhaustion(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewWithClock(func() time.Time { return now })
	l.Configure(3, 0, 1000) // 1000 tpm, no rpm cap

	if ok, _, _ := l.Allow(3, 800); !ok {
		t.Fatal("800 tokens within 1000 budget should allow")
	}
	ok, retry, snap := l.Allow(3, 800)
	if ok {
		t.Fatal("second 800 (1600 > 1000) should be denied")
	}
	if retry <= 0 {
		t.Fatal("expected positive retry-after")
	}
	if snap.TokLimit != 1000 {
		t.Fatalf("tok limit snapshot: got %d want 1000", snap.TokLimit)
	}
}

func TestCommitRefund(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewWithClock(func() time.Time { return now })
	l.Configure(9, 0, 1000)

	l.Allow(9, 900)               // charge estimate 900 → 100 left
	l.Commit(9, 900, 100)         // actual only 100 → refund 800 → back to 900
	r := l.Remaining(9)
	if r.TokRemaining < 850 {
		t.Fatalf("after refund expected ~900 remaining, got %d", r.TokRemaining)
	}
}

func TestConfigurePreservesFill(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewWithClock(func() time.Time { return now })
	l.Configure(2, 60, 0)
	l.Allow(2, 0) // 59 left
	l.Configure(2, 60, 0) // same limits again (runner re-configures every turn)
	r := l.Remaining(2)
	if r.ReqRemaining != 59 {
		t.Fatalf("re-configure should preserve fill, got %d want 59", r.ReqRemaining)
	}
}
