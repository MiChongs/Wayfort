// Package profiler defines the Data Profiling contract — column-level
// statistics, distribution histograms, top-N values and regex patterns.
package profiler

import "context"

type Profiler interface {
	BasicStats(ctx context.Context, schema, table, column string) (BasicStats, error)
	Distribution(ctx context.Context, schema, table, column string, buckets int) (Histogram, error)
	TopN(ctx context.Context, schema, table, column string, n int) ([]ValueFreq, error)
	Patterns(ctx context.Context, schema, table, column string) ([]PatternMatch, error)
}

type BasicStats struct {
	Count     int64
	NullCount int64
	Distinct  int64
	Min       any
	Max       any
	Avg       float64
	StdDev    float64
}

type Histogram struct {
	Buckets []HistogramBucket
}

type HistogramBucket struct {
	LowerBound any
	UpperBound any
	Count      int64
}

type ValueFreq struct {
	Value any
	Count int64
}

// PatternMatch reports how many rows match a named regex pattern.
// Patterns are dialect-bundled (email/phone/uuid/ipv4/...).
type PatternMatch struct {
	Pattern string
	Count   int64
}
