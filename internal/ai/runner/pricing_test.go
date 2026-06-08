package runner

import (
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
)

func TestCostMicrosStaticTable(t *testing.T) {
	// 1M input tokens of gpt-4o-mini at $0.15/1M = 150000 micro-dollars.
	got := costMicros("gpt-4o-mini", 1_000_000, 0, 0, 0)
	if got != 150_000 {
		t.Fatalf("gpt-4o-mini 1M in: got %d, want 150000", got)
	}
	// Unknown model → 0 (UI shows tokens only).
	if got := costMicros("totally-unknown-model", 1_000_000, 1_000_000, 0, 0); got != 0 {
		t.Fatalf("unknown model: got %d, want 0", got)
	}
}

func TestCostMicrosWithOverride(t *testing.T) {
	rate := &provider.ModelPricing{InPerMTok: 10, OutPerMTok: 30}
	// 1M in + 1M out at $10/$30 → 10_000_000 + 30_000_000 micro-dollars.
	got := costMicrosWith(rate, "anything", 1_000_000, 1_000_000, 0, 0)
	if got != 40_000_000 {
		t.Fatalf("override pricing: got %d, want 40000000", got)
	}
}

func TestCostMicrosWithNilFallsBackToStatic(t *testing.T) {
	// nil rate + known model → static table.
	got := costMicrosWith(nil, "gpt-4o-mini", 1_000_000, 0, 0, 0)
	if got != 150_000 {
		t.Fatalf("nil rate known model: got %d, want 150000", got)
	}
	// nil rate + unknown model → 0.
	if got := costMicrosWith(nil, "unknown", 1_000_000, 0, 0, 0); got != 0 {
		t.Fatalf("nil rate unknown model: got %d, want 0", got)
	}
	// zero-valued rate is treated as nil (fall back to static).
	zero := &provider.ModelPricing{}
	if got := costMicrosWith(zero, "gpt-4o-mini", 1_000_000, 0, 0, 0); got != 150_000 {
		t.Fatalf("zero rate: got %d, want 150000 (static fallback)", got)
	}
}
