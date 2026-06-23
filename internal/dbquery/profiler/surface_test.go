package profiler

import "testing"

func TestExportedSurface(t *testing.T) {
	var _ Profiler
	var _ BasicStats
	var _ Histogram
	var _ HistogramBucket
	var _ ValueFreq
	var _ PatternMatch
}
