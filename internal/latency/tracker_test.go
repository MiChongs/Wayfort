package latency

import (
	"testing"
	"time"
)

func TestTrackerPercentiles(t *testing.T) {
	tr := New()
	// 100 samples 10..1000ms; p50≈500, p99≈990, max=1000.
	for i := 1; i <= 100; i++ {
		tr.Observe(time.Duration(i*10) * time.Millisecond)
	}
	s := tr.Snapshot()
	if s.Probes != 100 {
		t.Fatalf("probes = %d, want 100", s.Probes)
	}
	if s.MaxMs != 1000 {
		t.Fatalf("max = %d, want 1000", s.MaxMs)
	}
	// HdrHistogram percentiles are within the configured precision.
	if s.P50Ms < 480 || s.P50Ms > 520 {
		t.Fatalf("p50 = %d, want ≈500", s.P50Ms)
	}
	if s.P95Ms < 940 || s.P95Ms > 960 {
		t.Fatalf("p95 = %d, want ≈950", s.P95Ms)
	}
	if s.P99Ms < 980 || s.P99Ms > 1000 {
		t.Fatalf("p99 = %d, want ≈990", s.P99Ms)
	}
}

func TestTrackerSubMillisecond(t *testing.T) {
	tr := New()
	// Loopback-style sub-ms samples must record as 1ms, never 0.
	for i := 0; i < 20; i++ {
		tr.Observe(200 * time.Microsecond)
	}
	s := tr.Snapshot()
	if s.CurrentMs != 1 || s.P50Ms != 1 || s.MaxMs != 1 {
		t.Fatalf("sub-ms should round to 1ms: %+v", s)
	}
}

func TestTrackerJitterAndLoss(t *testing.T) {
	tr := New()
	// Alternating 10/30ms → non-trivial jitter.
	for i := 0; i < 30; i++ {
		if i%2 == 0 {
			tr.Observe(10 * time.Millisecond)
		} else {
			tr.Observe(30 * time.Millisecond)
		}
	}
	// 10 timeouts out of 40 total → 25% loss.
	for i := 0; i < 10; i++ {
		tr.ObserveTimeout()
	}
	s := tr.Snapshot()
	if s.JitterMs == 0 {
		t.Fatalf("expected non-zero jitter, got %d", s.JitterMs)
	}
	if s.LossPct != 2500 {
		t.Fatalf("loss = %d, want 2500 (25.00%%)", s.LossPct)
	}
}

func TestTrackerEmpty(t *testing.T) {
	s := New().Snapshot()
	if s.Probes != 0 || s.CurrentMs != 0 || s.P95Ms != 0 || s.LossPct != 0 {
		t.Fatalf("empty tracker should be all-zero: %+v", s)
	}
}
