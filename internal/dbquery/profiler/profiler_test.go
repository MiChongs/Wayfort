package profiler

import "testing"

func TestBasicStatsZero(t *testing.T) {
	var s BasicStats
	if s.Count != 0 || s.Distinct != 0 {
		t.Fatal("zero BasicStats must be empty")
	}
}
