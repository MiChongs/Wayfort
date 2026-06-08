// Package metrics is an in-memory, thread-safe registry for proxy-chain
// connection telemetry. It implements dialer.MetricsSink (structurally) and is
// surfaced over a JSON snapshot + SSE stream by internal/api. No Prometheus
// dependency — the snapshot shape is deliberately promhttp-adaptable later.
package metrics

import (
	"sync"
	"time"
)

type proxyStat struct {
	active         int64
	totalDials     int64
	failures       int64
	bytesIn        int64
	bytesOut       int64
	sumLatencyMS   int64
	latencySamples int64
}

// Registry accumulates per-proxy counters plus a rolling aggregate series.
type Registry struct {
	mu           sync.Mutex
	proxies      map[uint64]*proxyStat
	series       []SeriesPoint
	lastSeriesAt time.Time
}

func New() *Registry { return &Registry{proxies: map[uint64]*proxyStat{}} }

// stat returns (creating if needed) the per-proxy bucket. Caller holds mu.
func (r *Registry) stat(id uint64) *proxyStat {
	s := r.proxies[id]
	if s == nil {
		s = &proxyStat{}
		r.proxies[id] = s
	}
	return s
}

// --- dialer.MetricsSink ---

func (r *Registry) OnDial(proxyID uint64, ok bool, d time.Duration) {
	r.mu.Lock()
	s := r.stat(proxyID)
	s.totalDials++
	if !ok {
		s.failures++
	}
	s.sumLatencyMS += d.Milliseconds()
	s.latencySamples++
	r.mu.Unlock()
}

func (r *Registry) OnConnOpen(proxyID uint64) {
	r.mu.Lock()
	r.stat(proxyID).active++
	r.mu.Unlock()
}

func (r *Registry) OnConnClose(proxyID uint64) {
	r.mu.Lock()
	s := r.stat(proxyID)
	if s.active > 0 {
		s.active--
	}
	r.mu.Unlock()
}

func (r *Registry) AddBytes(proxyID uint64, in, out int64) {
	r.mu.Lock()
	s := r.stat(proxyID)
	s.bytesIn += in
	s.bytesOut += out
	r.mu.Unlock()
}

// --- snapshot ---

type ProxyMetric struct {
	ProxyID      uint64  `json:"proxy_id"`
	ActiveConns  int64   `json:"active_conns"`
	TotalDials   int64   `json:"total_dials"`
	Failures     int64   `json:"failures"`
	SuccessRate  float64 `json:"success_rate"`
	BytesIn      int64   `json:"bytes_in"`
	BytesOut     int64   `json:"bytes_out"`
	AvgLatencyMS int64   `json:"avg_latency_ms"`
}

type Aggregate struct {
	ActiveConns int64   `json:"active_conns"`
	TotalDials  int64   `json:"total_dials"`
	Failures    int64   `json:"failures"`
	SuccessRate float64 `json:"success_rate"`
	BytesIn     int64   `json:"bytes_in"`
	BytesOut    int64   `json:"bytes_out"`
}

// SeriesPoint is one rolling sample: cumulative dials/failures and the
// instantaneous active-connection gauge at that moment.
type SeriesPoint struct {
	TS          time.Time `json:"ts"`
	Dials       int64     `json:"dials"`
	Failures    int64     `json:"failures"`
	ActiveConns int64     `json:"active_conns"`
}

type Snapshot struct {
	Proxies   map[uint64]ProxyMetric `json:"proxies"`
	Aggregate Aggregate              `json:"aggregate"`
	Series    []SeriesPoint          `json:"series"`
	SampledAt time.Time              `json:"sampled_at"`
}

// Snapshot returns the current per-proxy + aggregate metrics and appends a
// rolling series point (debounced to ~4s so concurrent readers don't double up).
func (r *Registry) Snapshot() Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	out := Snapshot{Proxies: make(map[uint64]ProxyMetric, len(r.proxies)), SampledAt: now}
	var agg Aggregate
	for id, s := range r.proxies {
		m := ProxyMetric{
			ProxyID: id, ActiveConns: s.active, TotalDials: s.totalDials,
			Failures: s.failures, BytesIn: s.bytesIn, BytesOut: s.bytesOut,
		}
		if s.totalDials > 0 {
			m.SuccessRate = float64(s.totalDials-s.failures) / float64(s.totalDials)
		}
		if s.latencySamples > 0 {
			m.AvgLatencyMS = s.sumLatencyMS / s.latencySamples
		}
		out.Proxies[id] = m
		agg.ActiveConns += s.active
		agg.TotalDials += s.totalDials
		agg.Failures += s.failures
		agg.BytesIn += s.bytesIn
		agg.BytesOut += s.bytesOut
	}
	if agg.TotalDials > 0 {
		agg.SuccessRate = float64(agg.TotalDials-agg.Failures) / float64(agg.TotalDials)
	}
	out.Aggregate = agg

	if now.Sub(r.lastSeriesAt) >= 4*time.Second {
		r.series = append(r.series, SeriesPoint{
			TS: now, Dials: agg.TotalDials, Failures: agg.Failures, ActiveConns: agg.ActiveConns,
		})
		if len(r.series) > 180 {
			r.series = r.series[len(r.series)-180:]
		}
		r.lastSeriesAt = now
	}
	out.Series = append([]SeriesPoint(nil), r.series...)
	return out
}
